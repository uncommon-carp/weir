variable "region" {
  description = "AWS region for the gate infrastructure."
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "Local AWS profile to use"
  type        = string
  default     = ""
}

variable "name_prefix" {
  description = "Prefix for all resource names."
  type        = string
  default     = "sentinel-gate"
}

variable "github_repos" {
  description = "GitHub repos allowed to assume the CI role via OIDC, each as 'org/repo'. Weir itself (for its own CI) plus every target repo wired to call scan.yml — reusable-workflow OIDC 'sub' claims reflect the calling repo, not this one."
  type        = list(string)
}

variable "vpc_cidr" {
  description = "CIDR block for the gate VPC."
  type        = string
  default     = "10.20.0.0/16"
}

variable "private_subnet_cidr" {
  description = "CIDR for the private subnet in AZ a (scan task ENI, VPC endpoints)."
  type        = string
  default     = "10.20.1.0/24"
}

variable "private_subnet_cidr_b" {
  description = "CIDR for the second private subnet in AZ b, for multi-AZ resilience."
  type        = string
  default     = "10.20.2.0/24"
}

variable "task_cpu" {
  description = "Fargate task CPU units (512 = 0.5 vCPU)."
  type        = number
  default     = 512
}

variable "task_memory" {
  description = "Fargate task memory in MiB. Must be a valid pairing with task_cpu."
  type        = number
  default     = 1024
}

variable "target_port" {
  description = "Port the vulnerable target container listens on."
  type        = number
  default     = 3000
}

variable "target_health_check_path" {
  description = "HTTP path the target container's health check probes. Anemone-specific default; override per target repo."
  type        = string
  default     = "/api/v2/health"
}

variable "max_concurrent_scans" {
  description = "Soft cap the orchestrator CLI enforces before RunTask. Exposed as an output; not an ECS-native limit."
  type        = number
  default     = 3
}

variable "teardown_minutes" {
  description = "Backstop TTL. The CLI creates a one-shot EventBridge schedule at now+N to StopTask if the run wedges."
  type        = number
  default     = 15
}

variable "billing_alarm_threshold_usd" {
  description = "Monthly estimated-charges threshold (USD) for the billing alarm."
  type        = number
  default     = 25
}

variable "alarm_email" {
  description = "Email subscribed to the billing-alarm SNS topic. Leave empty to skip the subscription."
  type        = string
  default     = ""
}

variable "create_oidc_provider" {
  description = "Create the GitHub OIDC provider. Set false if the account already has one (a second is an error)."
  type        = bool
  default     = true
}
