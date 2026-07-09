# Everything the orchestrator CLI and the GitHub Actions workflow need.

output "aws_region" {
  value = var.region
}

output "gha_role_arn" {
  description = "Role the GitHub Actions workflow assumes via OIDC."
  value       = aws_iam_role.gha.arn
}

output "ecs_cluster" {
  value = aws_ecs_cluster.this.name
}

output "task_family" {
  value = aws_ecs_task_definition.scan.family
}

output "subnet_ids" {
  description = "Both private subnet IDs (AZ a, AZ b) for RunTask."
  value       = [aws_subnet.private.id, aws_subnet.private_b.id]
}

output "task_security_group_id" {
  value = aws_security_group.task.id
}

output "results_bucket" {
  value = aws_s3_bucket.results.bucket
}

output "log_group" {
  value = aws_cloudwatch_log_group.scan.name
}

output "ecr_target_repo" {
  value = aws_ecr_repository.target.repository_url
}

output "ecr_sentinel_repo" {
  value = aws_ecr_repository.sentinel.repository_url
}

output "execution_role_arn" {
  value = aws_iam_role.execution.arn
}

output "task_role_arn" {
  value = aws_iam_role.task.arn
}

output "scheduler_role_arn" {
  description = "Passed to scheduler:CreateSchedule by the CLI for the teardown backstop."
  value       = aws_iam_role.scheduler.arn
}

output "max_concurrent_scans" {
  description = "Soft cap the CLI enforces before RunTask."
  value       = var.max_concurrent_scans
}

output "teardown_minutes" {
  value = var.teardown_minutes
}
