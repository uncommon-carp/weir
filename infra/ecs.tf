# ─────────────────────────────────────────────────────────────────────────────
# ECS / Fargate. One task definition, two containers sharing a network namespace:
#
#   target   — the PR's build of the vulnerable API, listening on target_port.
#   sentinel — scans http://localhost:<target_port>, writes results to S3, exits.
#
# Because both containers share the task ENI, Sentinel reaches the target over
# loopback. No service discovery, no private-IP resolution, no proxy. When the
# essential sentinel container exits, ECS stops the task and the target with it.
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_ecr_repository" "target" {
  name                 = "${local.name}/target"
  image_tag_mutability = "MUTABLE"
  force_delete         = true # portfolio fixture — fine to nuke on destroy
  image_scanning_configuration {
    scan_on_push = true
  }
  tags = local.tags
}

resource "aws_ecr_repository" "sentinel" {
  name                 = "${local.name}/sentinel"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration {
    scan_on_push = true
  }
  tags = local.tags
}

resource "aws_cloudwatch_log_group" "scan" {
  name              = "/ecs/${local.name}"
  retention_in_days = 14
  tags              = local.tags
}

resource "aws_ecs_cluster" "this" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "disabled" # keep cost down for an intermittent gate
  }
  tags = local.tags
}

# A baseline task definition. The CI workflow registers a NEW revision each run
# with the target image pinned to the PR's git SHA (container override / image
# swap). This resource exists so the family, roles, and shape live in IaC and so
# `terraform apply` produces something runnable on day one.
resource "aws_ecs_task_definition" "scan" {
  family                   = "${local.name}-scan"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "target"
      image     = "${aws_ecr_repository.target.repository_url}:bootstrap"
      essential = false # supporting service; sentinel drives task lifecycle
      portMappings = [
        { containerPort = var.target_port, protocol = "tcp" }
      ]
      # Container-level env carries the misconfiguration flags. The CI run can
      # override these per scan to toggle which findings are live.
      environment = [
        { name = "PORT", value = tostring(var.target_port) }
      ]
      healthCheck = {
        # node is in the target image, so avoid depending on curl/wget.
        command = [
          "CMD-SHELL",
          "node -e \"require('http').get('http://localhost:${var.target_port}/api/v2/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\""
        ]
        interval    = 5
        timeout     = 3
        retries     = 5
        startPeriod = 10
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.scan.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "target"
        }
      }
    },
    {
      name      = "sentinel"
      image     = "${aws_ecr_repository.sentinel.repository_url}:latest"
      essential = true # when this exits, the task (and target) stop
      dependsOn = [
        { containerName = "target", condition = "HEALTHY" }
      ]
      # The orchestrator passes RUN_ID and RESULTS_BUCKET per run. Contract:
      # sentinel scans TARGET_URL, then uploads its JSON report to
      # s3://$RESULTS_BUCKET/results/$RUN_ID.json  (see APP-SIDE note in README).
      environment = [
        { name = "TARGET_URL", value = "http://localhost:${var.target_port}" },
        { name = "RESULTS_BUCKET", value = aws_s3_bucket.results.bucket }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.scan.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "sentinel"
        }
      }
    }
  ])

  tags = local.tags
}
