# ─────────────────────────────────────────────────────────────────────────────
# IAM. Four distinct roles, deliberately not merged:
#
#   execution_role  — ECS agent uses it to PULL images and PUSH logs (control).
#   task_role       — the running containers use it at runtime (S3 PutObject).
#   gha_role        — GitHub Actions assumes it via OIDC, no stored keys.
#   scheduler_role  — EventBridge Scheduler assumes it to StopTask (teardown).
#
# Keeping execution vs task separate is the point: a compromised target gets the
# task role (write one S3 prefix) and nothing else — never the pull/log creds.
# ─────────────────────────────────────────────────────────────────────────────

# ── ECS task execution role (image pull + logs) ──────────────────────────────
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ── ECS task role (runtime perms for the containers) ─────────────────────────
resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

# Sentinel writes results only under results/* in the gate bucket. Nothing else.
data "aws_iam_policy_document" "task_perms" {
  statement {
    sid       = "WriteResults"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.results.arn}/results/*"]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "${local.name}-task"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_perms.json
}

# ── GitHub OIDC provider + CI role ───────────────────────────────────────────
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # AWS validates GitHub's cert chain dynamically now; these are the published
  # thumbprints kept for the required field.
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fca",
  ]
  tags = local.tags
}

locals {
  oidc_provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "gha_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Scope to this repo only. Tighten to a branch/environment later if wanted,
    # e.g. "repo:org/repo:ref:refs/heads/main".
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:*"]
    }
  }
}

resource "aws_iam_role" "gha" {
  name               = "${local.name}-gha"
  assume_role_policy = data.aws_iam_policy_document.gha_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "gha_perms" {
  # Push the PR's target image to ECR.
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.target.arn, aws_ecr_repository.sentinel.arn]
  }

  # Drive the scan task.
  statement {
    sid       = "EcsRegister"
    actions   = ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition"]
    resources = ["*"] # RegisterTaskDefinition does not support resource-level scoping
  }
  statement {
    sid       = "EcsRun"
    actions   = ["ecs:RunTask", "ecs:StopTask", "ecs:DescribeTasks", "ecs:ListTasks"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }

  # PassRole is the least-privilege landmine: RunTask needs to hand the task its
  # execution + task roles, so scope PassRole to exactly those two ARNs.
  statement {
    sid       = "PassTaskRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  # Create the one-shot teardown schedule, and pass the scheduler role to it.
  statement {
    sid       = "SchedulerBackstop"
    actions   = ["scheduler:CreateSchedule", "scheduler:DeleteSchedule"]
    resources = ["arn:aws:scheduler:${var.region}:${data.aws_caller_identity.current.account_id}:schedule/default/${local.name}-*"]
  }
  statement {
    sid       = "PassSchedulerRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.scheduler.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["scheduler.amazonaws.com"]
    }
  }

  # Read scan results back to surface them on the PR.
  statement {
    sid       = "ReadResults"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.results.arn, "${aws_s3_bucket.results.arn}/results/*"]
  }
}

resource "aws_iam_role_policy" "gha" {
  name   = "${local.name}-gha"
  role   = aws_iam_role.gha.id
  policy = data.aws_iam_policy_document.gha_perms.json
}

# ── EventBridge Scheduler role (teardown backstop) ───────────────────────────
data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${local.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "scheduler_perms" {
  statement {
    actions   = ["ecs:StopTask"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "${local.name}-scheduler"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler_perms.json
}
