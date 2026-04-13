# Terraform/HCL + Shell Deployment Scripts Best Practices

## Overview

This project deploys:

- Infrastructure with Terraform in `infra/terraform`
- Compute updates with shell script `infra/scripts/deploy-compute.sh`
- CI/CD orchestration with `.github/workflows/deploy.yml`

Because Terraform and shell are both powerful and risky, treat them as **production code**:

- deterministic
- reviewable
- least-privilege
- idempotent
- observable

Use Terraform for **desired state infrastructure** and shell for **imperative host/bootstrap steps** that are hard to model declaratively.

---

## DO

### Terraform / HCL

- **Pin versions intentionally** (Terraform + providers), and update on a schedule.
  - Already done in `providers.tf`; keep this pattern.
- **Keep inputs typed and documented** in `variables.tf` with descriptions and sane defaults.
- **Mark sensitive values** (`sensitive = true`) and avoid outputting secrets.
- **Use locals for naming conventions** (`local.name`) to keep resources consistent.
- **Run quality gates in CI and locally**:
  - `terraform fmt -check`
  - `terraform validate`
  - `terraform plan` (for reviewed changes)
- **Use remote state + locking** for team usage (S3 + DynamoDB or Terraform Cloud), not local state in shared workflows.
- **Restrict network ingress aggressively** (SSH and app ports).
- **Prefer immutable replacements** over in-place mutation when risk is high.
- **Tag resources consistently** (owner, env, service, cost center).
- **Separate environments** (`staging`/`prod`) with distinct state + tfvars.

### Shell deployment scripts

- Start with strict mode:
  - `set -euo pipefail`
- **Fail early on missing required env vars**:
  - `: "${GITHUB_REPOSITORY_URL:?required}"`
- **Quote all variable expansions** and paths.
- **Design scripts to be idempotent** (safe to re-run).
- **Use explicit logging** for each major step.
- **Check command existence** before use (`command -v`).
- **Use non-interactive commands** suitable for CI.
- **Pin runtime/toolchain versions** where practical (Node/pnpm/pm2 strategy).
- **Prefer atomic deploy flow** (fetch, checkout, install, build, restart).
- **Run scripts through `shellcheck`** in CI.

---

## DON'T

### Terraform / HCL

- Don’t commit `terraform.tfstate`, `.terraform/`, or generated private keys.
- Don’t keep permissive defaults like `0.0.0.0/0` for production SSH/app ingress.
- Don’t hardcode secrets in `.tf` or `terraform.tfvars` that might be committed.
- Don’t rely on ad-hoc manual apply in team environments without plan review.
- Don’t mix unrelated infrastructure concerns in one root module as the system grows.
- Don’t expose private key material as routine outputs unless absolutely necessary.

### Shell deployment scripts

- Don’t assume environment variables exist without validation.
- Don’t run destructive commands (`rm`, `git reset --hard`) outside a controlled directory.
- Don’t suppress all errors; only suppress expected non-critical failures.
- Don’t rely on mutable “latest” behavior if reproducibility matters.
- Don’t embed long-lived secrets directly in scripts or command history.

---

## Configuration

Recommended baseline for this repo:

### Terraform configuration model

- Keep:
  - `providers.tf` for required providers and provider config
  - `variables.tf` for typed inputs
  - `main.tf` for resources
  - `outputs.tf` for non-sensitive outputs
- Add:
  - `backend.tf` for remote backend + state locking
  - `versions.tf` (optional split from providers)
  - `terraform.tfvars.example` only (never commit real `terraform.tfvars`)

### CI checks (Terraform)

Add a CI job equivalent to:

```bash
cd infra/terraform
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
```

For deploy branches/environments:

```bash
terraform plan -var-file=env/prod.tfvars
```

### CI checks (Shell)

```bash
shellcheck infra/scripts/deploy-compute.sh
bash -n infra/scripts/deploy-compute.sh
```

### Secret/config boundaries

- Terraform variables: cloud/account IDs, region, instance shape, CIDRs.
- GitHub Secrets: API tokens, SSH key, deploy token.
- Runtime env vars passed from workflow to host script only when needed.

---

## Project-specific notes

1. **Ingress defaults are currently broad**:
   - `allowed_ssh_cidrs` and `github_actions_cidr_blocks` default to `0.0.0.0/0`.
   - Tighten these immediately for production.

2. **Generated deploy key handling**:
   - `tls_private_key` + `local_file` writes PEM to module directory.
   - Ensure PEM file is gitignored, access-restricted, and rotated.
   - Prefer moving toward SSM Session Manager to remove SSH key dependency.

3. **Single-host compute deployment**:
   - Current `pm2 delete && pm2 start` works but causes restart interruption.
   - Consider `pm2 reload` with ecosystem config for smoother restarts.

4. **Git-based deploy safety** (`deploy-compute.sh`):
   - Current `git reset --hard origin/$GITHUB_REF_NAME` is acceptable in dedicated deploy dir.
   - Keep deploy path isolated (`/opt/orchestrace/app`) and never repurpose it.

5. **Cloudflare Pages + EC2 split**:
   - Keep interface contract explicit: UI API base URL, port (`4310`), health endpoint.
   - Add post-deploy smoke checks from workflow after SSH deploy step.

6. **Environment strategy**:
   - Introduce separate Terraform states and secrets per environment.
   - Avoid sharing key pairs or hostnames between staging and prod.

---

## Examples

### Terraform: safer variable validation

```hcl
variable "allowed_ssh_cidrs" {
  type        = list(string)
  description = "CIDR blocks allowed to SSH to EC2."

  validation {
    condition     = length(var.allowed_ssh_cidrs) > 0
    error_message = "At least one SSH CIDR must be provided."
  }
}
```

### Terraform: common tags pattern

```hcl
locals {
  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_vpc" "main" {
  cidr_block = "10.80.0.0/16"
  tags       = merge(local.common_tags, { Name = "${local.name}-vpc" })
}
```

### Shell: required variable guards + structured logging

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_REPOSITORY_URL:?GITHUB_REPOSITORY_URL is required}"
: "${GITHUB_REF_NAME:?GITHUB_REF_NAME is required}"

log() { printf '[deploy] %s\n' "$*"; }

log "Fetching latest code"
git fetch --all --prune
```

### Shell: safer restart flow with fallback

```bash
if pm2 describe orchestrace-backend >/dev/null 2>&1; then
  pm2 reload orchestrace-backend --update-env
else
  pm2 start "pnpm --filter @orchestrace/cli dev ui --port ${ORCHESTRACE_PORT:-4310}" --name orchestrace-backend
fi
pm2 save
```

---

## Quick checklist (use before merging infra/deploy changes)

- [ ] Terraform formatted and validated
- [ ] Plan reviewed for destructive changes
- [ ] No secrets or key material committed
- [ ] Ingress CIDRs minimized
- [ ] Shell script passes `shellcheck`
- [ ] Script is idempotent and env vars validated
- [ ] Post-deploy verification step defined
- [ ] Rollback path documented