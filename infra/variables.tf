variable "region" {
  description = "AWS region for the gate infrastructure."
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "Local AWS profile to use"
  type = "string"
  default = ""
}

variable "name_prefix" {
  description = "Prefix for all resource names."
  type        = string
  default     = "sentinel-gate"
}

variable "github_repo" {
  description = "GitHub repo allowed to assume the CI role, as 'org/repo'. Used in the OIDC trust policy 'sub' condition."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the gate VPC."
  type        = string
  default     = "10.20.0.0/16"
}

variable "private_subnet_cidr" {
  description = "CIDR for the single private subnet the scan task runs in."
  type        = string
  default     = "10.20.1.0/24"
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
