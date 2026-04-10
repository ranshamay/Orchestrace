locals {
  name = "${var.project_name}-${var.environment}"
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_vpc" "main" {
  cidr_block           = "10.80.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${local.name}-vpc"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${local.name}-igw"
  }
}

resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.80.1.0/24"
  map_public_ip_on_launch = true
  availability_zone       = "${var.aws_region}a"

  tags = {
    Name = "${local.name}-public-a"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${local.name}-public-rt"
  }
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "compute" {
  name        = "${local.name}-compute-sg"
  description = "Compute access rules"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.allowed_ssh_cidrs
  }

  ingress {
    description = "App"
    from_port   = var.app_port
    to_port     = var.app_port
    protocol    = "tcp"
    cidr_blocks = var.github_actions_cidr_blocks
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name}-compute-sg"
  }
}

resource "tls_private_key" "deploy" {
  algorithm = "ED25519"
}

resource "aws_key_pair" "deploy" {
  key_name   = "${local.name}-gha-deploy"
  public_key = tls_private_key.deploy.public_key_openssh
}

resource "local_file" "deploy_key_pem" {
  filename        = "${path.module}/${local.name}-gha-deploy.pem"
  content         = tls_private_key.deploy.private_key_openssh
  file_permission = "0600"
}


resource "aws_iam_role" "ec2" {
  name = "${local.name}-ec2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Principal = {
          Service = "ec2.amazonaws.com"
        },
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "ec2" {
  name = "${local.name}-ec2-profile"
  role = aws_iam_role.ec2.name
}

resource "aws_instance" "compute" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.aws_instance_type
  subnet_id                   = aws_subnet.public_a.id
  vpc_security_group_ids      = [aws_security_group.compute.id]
  associate_public_ip_address = true
  key_name                    = aws_key_pair.deploy.key_name
  iam_instance_profile        = aws_iam_instance_profile.ec2.name

  user_data = <<-EOF
    #!/usr/bin/env bash
    set -euxo pipefail

    apt-get update
    apt-get install -y ca-certificates curl git build-essential

    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs

    npm install -g pnpm pm2

    mkdir -p /opt/orchestrace
    chown ubuntu:ubuntu /opt/orchestrace
  EOF

  tags = {
    Name = "${local.name}-compute"
  }
}

resource "cloudflare_pages_project" "ui" {
  account_id        = var.cloudflare_account_id
  name              = var.cloudflare_pages_project_name
  production_branch = "main"
}