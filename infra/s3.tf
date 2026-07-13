# Results bucket. Private, encrypted, lifecycle-expired — a scan report is
# ephemeral evidence, not something to keep forever. Not versioned, on
# purpose: versioning would work against the 30-day expiration below by
# letting noncurrent versions accumulate indefinitely, for no compliance/
# audit need this bucket actually has.

resource "aws_s3_bucket" "results" {
  bucket_prefix = "${local.name}-results-"
  force_destroy = true
  tags          = local.tags
}

resource "aws_s3_bucket_public_access_block" "results" {
  bucket                  = aws_s3_bucket.results.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "results" {
  bucket = aws_s3_bucket.results.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "results" {
  bucket = aws_s3_bucket.results.id
  rule {
    id     = "expire-reports"
    status = "Enabled"
    filter {
      prefix = "results/"
    }
    expiration {
      days = 30
    }
  }
}
