# Publishes the values scan.yml needs into SSM Parameter Store so CI never
# needs `terraform init` (and therefore never needs backend credentials).
# outputs.tf still exists separately for human/local `terraform output` use.

locals {
  ssm_parameters = {
    "ecs-cluster"          = aws_ecs_cluster.this.name
    "task-family"          = aws_ecs_task_definition.scan.family
    "subnet-id"            = aws_subnet.private.id
    "security-group-id"    = aws_security_group.task.id
    "results-bucket"       = aws_s3_bucket.results.bucket
    "execution-role-arn"   = aws_iam_role.execution.arn
    "task-role-arn"        = aws_iam_role.task.arn
    "scheduler-role-arn"   = aws_iam_role.scheduler.arn
    "ecr-target-repo"      = aws_ecr_repository.target.repository_url
    "ecr-sentinel-repo"    = aws_ecr_repository.sentinel.repository_url
    "log-group"            = aws_cloudwatch_log_group.scan.name
    "max-concurrent-scans" = tostring(var.max_concurrent_scans)
    "teardown-minutes"     = tostring(var.teardown_minutes)
  }
}

resource "aws_ssm_parameter" "ci" {
  for_each = local.ssm_parameters
  name     = "${local.ssm_prefix}/${each.key}"
  type     = "String"
  value    = each.value
  tags     = local.tags
}
