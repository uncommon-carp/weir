terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

# Billing metrics only exist in us-east-1. Used by the cost alarm in observability.tf.
provider "aws" {
  alias  = "use1"
  region = "us-east-1"
}
