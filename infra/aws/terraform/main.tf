# SH-11c / ADR-0184 D1 — minimal T1 Terraform.
# Lightsail (default): instance 1 + static IP 1 + disk 1 + ports {22,80,443} + budget.
# EC2: same shape via var.compute. Credentials: provider chain only.

terraform {
  required_version = ">= 1.3.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0.0"
    }
  }
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile
}

locals {
  is_lightsail = var.compute == "lightsail"
  is_ec2       = var.compute == "ec2"
  common_tags = {
    oort       = "selfhost"
    oort_issue = var.oort_issue
  }
  user_data = file("${path.module}/../cloud-init.yaml")
}

# ---------------------------------------------------------------------------
# Lightsail
# ---------------------------------------------------------------------------

resource "aws_lightsail_instance" "oort" {
  count = local.is_lightsail ? 1 : 0

  name              = var.name
  availability_zone = var.availability_zone
  blueprint_id      = var.lightsail_blueprint_id
  bundle_id         = var.lightsail_bundle_id
  key_pair_name     = var.ssh_key_name
  user_data         = local.user_data
  tags              = local.common_tags
}

resource "aws_lightsail_static_ip" "oort" {
  count = local.is_lightsail ? 1 : 0
  name  = "${var.name}-ip"
}

resource "aws_lightsail_static_ip_attachment" "oort" {
  count = local.is_lightsail ? 1 : 0

  static_ip_name = aws_lightsail_static_ip.oort[0].id
  instance_name  = aws_lightsail_instance.oort[0].name
}

resource "aws_lightsail_disk" "data" {
  count = local.is_lightsail ? 1 : 0

  name              = "${var.name}-data"
  size_in_gb        = var.data_disk_gb
  availability_zone = var.availability_zone
  tags              = local.common_tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_lightsail_disk_attachment" "data" {
  count = local.is_lightsail ? 1 : 0

  disk_name     = aws_lightsail_disk.data[0].name
  instance_name = aws_lightsail_instance.oort[0].name
  disk_path     = "/dev/xvdf"
}

# Replaces the instance's open-port set. AWS closes anything not listed here.
# Postgres 5432 must never appear (compose postgres stays on the docker network).
resource "aws_lightsail_instance_public_ports" "oort" {
  count = local.is_lightsail ? 1 : 0

  instance_name = aws_lightsail_instance.oort[0].name

  port_info {
    protocol  = "tcp"
    from_port = 22
    to_port   = 22
  }

  port_info {
    protocol  = "tcp"
    from_port = 80
    to_port   = 80
  }

  port_info {
    protocol  = "tcp"
    from_port = 443
    to_port   = 443
  }
}

# ---------------------------------------------------------------------------
# EC2 fork (same three ports, same prevent_destroy data volume)
# ---------------------------------------------------------------------------

resource "aws_security_group" "oort" {
  count = local.is_ec2 ? 1 : 0

  name        = "${var.name}-sg"
  description = "oort T1: 22/80/443 only"
  vpc_id      = var.ec2_vpc_id
  tags        = local.common_tags

  ingress {
    description = "ssh"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "http"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "https"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "oort" {
  count = local.is_ec2 ? 1 : 0

  ami                    = var.ec2_ami_id
  instance_type          = var.ec2_instance_type
  subnet_id              = var.ec2_subnet_id
  vpc_security_group_ids = [aws_security_group.oort[0].id]
  key_name               = var.ssh_key_name
  user_data              = local.user_data
  tags                   = merge(local.common_tags, { Name = var.name })

  lifecycle {
    precondition {
      condition     = var.ec2_ami_id != "" && var.ec2_vpc_id != "" && var.ec2_subnet_id != ""
      error_message = "compute=ec2 requires ec2_ami_id, ec2_vpc_id, and ec2_subnet_id (operator session; no account id in the tree)."
    }
  }
}

resource "aws_ebs_volume" "data" {
  count = local.is_ec2 ? 1 : 0

  availability_zone = var.availability_zone
  size              = var.data_disk_gb
  type              = "gp3"
  tags              = merge(local.common_tags, { Name = "${var.name}-data" })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_volume_attachment" "data" {
  count = local.is_ec2 ? 1 : 0

  device_name = "/dev/xvdf"
  volume_id   = aws_ebs_volume.data[0].id
  instance_id = aws_instance.oort[0].id
}

resource "aws_eip" "oort" {
  count    = local.is_ec2 ? 1 : 0
  instance = aws_instance.oort[0].id
  domain   = "vpc"
  tags     = merge(local.common_tags, { Name = "${var.name}-ip" })
}

# ---------------------------------------------------------------------------
# Cost guard (both forks)
# ---------------------------------------------------------------------------

resource "aws_budgets_budget" "oort" {
  name         = "${var.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_alert_email]
  }
}
