# Terraform infrastructure (AWS + Cloudflare)

This folder provisions:

- **AWS compute** (single EC2 host) for Orchestrace backend/CLI runtime
- **Cloudflare Pages project** for the React UI (`packages/ui`)
- **SSH deploy key pair** used by GitHub Actions to deploy to EC2

## Prerequisites

- Terraform `>= 1.6`
- AWS credentials with VPC/EC2/IAM permissions
- Cloudflare API token with Pages project edit permission

## Usage

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# edit values
terraform init
terraform plan
terraform apply
```

After apply:

1. Copy output `ec2_public_dns` into GitHub secret `AWS_EC2_HOST`
2. Read the file at output `deploy_private_key_path` and store its contents in GitHub secret `AWS_EC2_SSH_KEY`
3. Set GitHub secret `AWS_EC2_USER` (default Ubuntu AMI user: `ubuntu`)
4. Set GitHub secret `CLOUDFLARE_API_TOKEN`
5. Set GitHub secret `CLOUDFLARE_ACCOUNT_ID`
6. Set GitHub secret `CLOUDFLARE_PAGES_PROJECT`

Then push to `main` (or run workflow manually) to deploy.

## Notes

- Current setup is intentionally minimal for first production baseline.
- Restrict `allowed_ssh_cidrs` and app ingress before production hardening.
- Consider ALB + Auto Scaling + SSM Session Manager for stronger posture.