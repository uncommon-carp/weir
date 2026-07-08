data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# Managed prefix list for S3 in this region — used to allow task egress to the
# S3 *gateway* endpoint (gateway endpoints are routed via prefix list, not SG-to-SG).
data "aws_ec2_managed_prefix_list" "s3" {
  name = "com.amazonaws.${var.region}.s3"
}

locals {
  name       = var.name_prefix
  ssm_prefix = "/weir/ci"
  tags = {
    Project   = "sentinel-gate"
    ManagedBy = "terraform"
  }
}
