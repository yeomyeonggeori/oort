# SH-11c / ADR-0184 D1 — AWS T1. Values come from the operator environment
# (aws configure / SSO profile) and from gitignored terraform.tfvars.
# No access keys, account ids, or email literals live in this tree.

variable "aws_region" {
  type        = string
  description = "AWS region for the provider and Lightsail/EC2 resources."
  default     = "us-east-1"
}

variable "aws_profile" {
  type        = string
  description = "Optional named profile from the local AWS config. Null uses the default credential chain (SSO session, env, shared credentials). Never a key."
  default     = null
}

variable "compute" {
  type        = string
  description = "T1 compute: lightsail (default, VPS-priced) or ec2 (same module, variable fork)."
  default     = "lightsail"

  validation {
    condition     = contains(["lightsail", "ec2"], var.compute)
    error_message = "compute must be lightsail or ec2."
  }
}

variable "name" {
  type        = string
  description = "Resource name prefix. Lightsail names must start with a letter."
  default     = "oort-selfhost"
}

variable "availability_zone" {
  type        = string
  description = "AZ for the instance and the data disk. Must sit in aws_region."
  default     = "us-east-1a"
}

variable "ssh_key_name" {
  type        = string
  description = "Existing Lightsail key pair (compute=lightsail) or EC2 key pair (compute=ec2). This recipe does not mint keys."
}

variable "oort_issue" {
  type        = string
  description = "Value for tag oort_issue (GitHub issue number or local label). Not an account id."
  default     = "unset"
}

variable "lightsail_bundle_id" {
  type        = string
  description = "Lightsail bundle. Allow-list is RAM >= 2 GiB (nano/micro refused)."
  default     = "small_3_0"

  validation {
    condition = contains([
      "small_3_0",
      "medium_3_0",
      "large_3_0",
      "xlarge_3_0",
      "2xlarge_3_0",
      "small_2_0",
      "medium_2_0",
      "large_2_0",
      "xlarge_2_0",
      "2xlarge_2_0",
    ], var.lightsail_bundle_id)
    error_message = "Lightsail bundle must have RAM >= 2 GiB. nano_* and micro_* are refused."
  }
}

variable "lightsail_blueprint_id" {
  type        = string
  description = "Ubuntu LTS blueprint id (aws lightsail get-blueprints)."
  default     = "ubuntu_24_04"

  validation {
    condition = contains([
      "ubuntu_24_04",
      "ubuntu_22_04",
    ], var.lightsail_blueprint_id)
    error_message = "Lightsail blueprint must be an Ubuntu LTS id in the allow-list."
  }
}

variable "data_disk_gb" {
  type        = number
  description = "Extra block disk size in GiB, mounted at /data."
  default     = 40

  validation {
    condition     = var.data_disk_gb >= 8
    error_message = "data_disk_gb must be at least 8."
  }
}

variable "monthly_budget_usd" {
  type        = number
  description = "AWS Budgets monthly COST limit in USD (cost guard)."
  default     = 25

  validation {
    condition     = var.monthly_budget_usd >= 5
    error_message = "monthly_budget_usd must be at least 5."
  }
}

variable "budget_alert_email" {
  type        = string
  description = "Subscriber for the Budgets notification (human approval point 3). Set only in gitignored terraform.tfvars — never commit it."

  validation {
    condition     = length(var.budget_alert_email) > 3 && can(regex("@", var.budget_alert_email))
    error_message = "budget_alert_email must be set (terraform.tfvars, gitignored)."
  }
}

variable "ec2_instance_type" {
  type        = string
  description = "EC2 instance type when compute=ec2. Allow-list is RAM >= 2 GiB."
  default     = "t3.small"

  validation {
    condition = contains([
      "t3.small",
      "t3.medium",
      "t3.large",
      "t3a.small",
      "t3a.medium",
      "t3a.large",
      "t4g.small",
      "t4g.medium",
      "t4g.large",
    ], var.ec2_instance_type)
    error_message = "EC2 instance type must have RAM >= 2 GiB. nano/micro types are refused."
  }
}

variable "ec2_ami_id" {
  type        = string
  description = "Ubuntu LTS AMI id for compute=ec2 in this region. Empty when compute=lightsail. Do not hard-code an account id; pass the AMI from the operator session."
  default     = ""
}

variable "ec2_vpc_id" {
  type        = string
  description = "VPC id for the EC2 security group. Empty when compute=lightsail."
  default     = ""
}

variable "ec2_subnet_id" {
  type        = string
  description = "Public subnet id for the EC2 instance and EIP. Empty when compute=lightsail."
  default     = ""
}
