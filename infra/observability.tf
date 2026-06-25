# Cost blast-radius backstop. A wedged reaper or a RunTask loop should never
# bill silently. This watches the account's estimated charges and alerts.
#
# Requires: Billing → "Receive CloudWatch billing alerts" enabled in the account
# (one-time console toggle; the metric does not publish until it is on).

resource "aws_sns_topic" "billing" {
  provider = aws.use1
  name     = "${local.name}-billing"
  tags     = local.tags
}

resource "aws_sns_topic_subscription" "billing_email" {
  count     = var.alarm_email == "" ? 0 : 1
  provider  = aws.use1
  topic_arn = aws_sns_topic.billing.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_cloudwatch_metric_alarm" "billing" {
  provider            = aws.use1
  alarm_name          = "${local.name}-estimated-charges"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "EstimatedCharges"
  namespace           = "AWS/Billing"
  period              = 21600 # 6h; billing metric updates only a few times/day
  statistic           = "Maximum"
  threshold           = var.billing_alarm_threshold_usd
  alarm_description   = "Estimated monthly charges exceeded threshold."
  dimensions          = { Currency = "USD" }
  alarm_actions       = [aws_sns_topic.billing.arn]
  tags                = local.tags
}
