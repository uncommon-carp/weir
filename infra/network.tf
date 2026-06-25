# ─────────────────────────────────────────────────────────────────────────────
# Network: a single private subnet with NO internet route.
#
# There is no Internet Gateway and no NAT. The task reaches AWS services only
# through VPC endpoints (ECR pull, S3, CloudWatch Logs). It has no route to the
# public internet, so a compromised target container cannot exfiltrate or be
# used for outbound attacks — egress is denied by construction, not by policy.
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true # required for private DNS on interface endpoints
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = "${local.name}-vpc" })
}

resource "aws_subnet" "private" {
  vpc_id            = aws_vpc.this.id
  cidr_block        = var.private_subnet_cidr
  availability_zone = "${var.region}a"
  tags              = merge(local.tags, { Name = "${local.name}-private" })
}

# Route table holds only the implicit local route plus the S3 gateway endpoint.
# No 0.0.0.0/0 entry exists anywhere — that absence is the egress lockdown.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${local.name}-private-rt" })
}

resource "aws_route_table_association" "private" {
  subnet_id      = aws_subnet.private.id
  route_table_id = aws_route_table.private.id
}

# ── Security groups ──────────────────────────────────────────────────────────

# Endpoint SG: accepts 443 only from the task SG.
resource "aws_security_group" "endpoints" {
  name        = "${local.name}-endpoints"
  description = "Ingress 443 from scan tasks to interface endpoints."
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${local.name}-endpoints" })
}

# Task SG: NO ingress (the two containers share one ENI and talk over loopback,
# so no cross-ENI path is ever needed). Egress is 443 to the interface endpoints
# and to the S3 prefix list — nothing else.
resource "aws_security_group" "task" {
  name        = "${local.name}-task"
  description = "Scan task: no ingress; egress 443 to AWS endpoints only."
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${local.name}-task" })
}

resource "aws_security_group_rule" "endpoints_ingress_from_task" {
  type                     = "ingress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  security_group_id        = aws_security_group.endpoints.id
  source_security_group_id = aws_security_group.task.id
  description              = "443 from scan tasks"
}

resource "aws_security_group_rule" "task_egress_to_endpoints" {
  type                     = "egress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  security_group_id        = aws_security_group.task.id
  source_security_group_id = aws_security_group.endpoints.id
  description              = "443 to interface endpoints (ECR, Logs)"
}

resource "aws_security_group_rule" "task_egress_to_s3" {
  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  security_group_id = aws_security_group.task.id
  prefix_list_ids   = [data.aws_ec2_managed_prefix_list.s3.id]
  description       = "443 to S3 via gateway endpoint (ECR layers + results)"
}

# ── VPC endpoints ────────────────────────────────────────────────────────────
# Fargate image pull needs ecr.api + ecr.dkr (interface) and S3 (gateway, for
# the layer blobs). awslogs driver needs the logs endpoint. With these four the
# task runs fully offline from the internet.

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
  tags              = merge(local.tags, { Name = "${local.name}-s3" })
}

locals {
  interface_endpoints = {
    ecr_api = "com.amazonaws.${var.region}.ecr.api"
    ecr_dkr = "com.amazonaws.${var.region}.ecr.dkr"
    logs    = "com.amazonaws.${var.region}.logs"
  }
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = local.interface_endpoints
  vpc_id              = aws_vpc.this.id
  service_name        = each.value
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private.id]
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = merge(local.tags, { Name = "${local.name}-${each.key}" })
}
