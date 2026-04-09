# Deployment design (Cloudflare UI + AWS compute + GitHub Actions + IaC)

This repository now includes a full **infrastructure-as-code baseline** and **CI/CD flow**:

- **UI** (`packages/ui`) is deployed to **Cloudflare Pages**
- **Compute** (Orchestrace backend process) is deployed to a single **AWS EC2** host
- **Provisioning** is done with **Terraform** under `infra/terraform`
- **Deployment automation** runs from **GitHub Actions** in `.github/workflows/deploy.yml`

## Topology

1. Users access the UI via Cloudflare Pages.
2. UI talks to backend endpoint hosted on EC2 (port `4310` in this baseline).
3. GitHub Actions builds UI and deploys both UI + compute on each push to `main`.

## Infrastructure (Terraform)

`infra/terraform` provisions:

- VPC + public subnet + route table + internet gateway
- Security group (SSH + app port)
- EC2 instance with Node 22, pnpm, pm2 preinstalled via `user_data`
- SSH key pair for CI deploy access (private key exported locally as output)
- Cloudflare Pages project

### Key files

- `providers.tf` — provider requirements + provider config
- `variables.tf` — all configurable inputs
- `main.tf` — AWS and Cloudflare resources
- `outputs.tf` — host info + deploy key path + pages project
- `terraform.tfvars.example` — example variable values

## GitHub Actions deployment

Workflow: `.github/workflows/deploy.yml`

On `push` to `main` (or manual dispatch):

1. Install deps
2. Build UI package
3. Deploy static assets in `packages/ui/dist` to Cloudflare Pages
4. SSH into EC2 and run `infra/scripts/deploy-compute.sh`:
   - clone/fetch repo on host
   - checkout target branch
   - install/build
   - run backend via pm2 (`@orchestrace/cli dev ui --port 4310`)

## Required GitHub secrets

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_PAGES_PROJECT`
- `AWS_EC2_HOST`
- `AWS_EC2_USER` (usually `ubuntu`)
- `AWS_EC2_SSH_KEY` (from Terraform output file contents)
- `GITHUB_DEPLOY_TOKEN` (recommended for private repos; PAT with repo read)

## Rollout checklist

1. `cd infra/terraform`
2. `cp terraform.tfvars.example terraform.tfvars` and edit values
3. `terraform init && terraform apply`
4. Add Terraform outputs/secrets to GitHub repo secrets
5. Push to `main` and verify `Deploy` workflow passes

## Suggested hardening (next iteration)

- Restrict SSH/app CIDRs
- Move to SSM Session Manager (remove SSH keys)
- Replace single EC2 with ASG + ALB
- Add HTTPS + custom domain for API
- Add health checks and rollback strategy
- Split environments (`staging`/`prod`) with separate tfvars/workflows