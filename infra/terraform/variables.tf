variable "project_name" {
  type        = string
  description = "Project name prefix for created resources."
  default     = "orchestrace"
}

variable "environment" {
  type        = string
  description = "Deployment environment label."
  default     = "prod"
}

variable "aws_region" {
  type        = string
  description = "AWS region for compute resources."
  default     = "us-east-1"
}

variable "aws_instance_type" {
  type        = string
  description = "EC2 instance type for compute host."
  default     = "t3.small"
}

variable "allowed_ssh_cidrs" {
  type        = list(string)
  description = "CIDR blocks allowed to SSH to EC2."
  default     = ["0.0.0.0/0"]
}

variable "github_actions_cidr_blocks" {
  type        = list(string)
  description = "Optional CIDR allow-list for inbound app traffic if you only want CI probes."
  default     = ["0.0.0.0/0"]
}

variable "app_port" {
  type        = number
  description = "Public app port exposed from EC2."
  default     = 4310
}

variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account id where the Pages project will be created."
}

variable "cloudflare_api_token" {
  type        = string
  description = "Cloudflare API token with Pages edit permissions."
  sensitive   = true
}

variable "cloudflare_pages_project_name" {
  type        = string
  description = "Cloudflare Pages project name for UI deploys."
  default     = "orchestrace-ui"
}