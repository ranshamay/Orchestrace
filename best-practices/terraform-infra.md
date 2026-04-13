# Terraform Infrastructure Best Practices

## Overview

This guide is tuned for the current Orchestrace infra shape (`infra/terraform`): AWS EC2 compute + Cloudflare Pages + GitHub Actions deploy.

## Key Principles

- Keep Terraform deterministic and reviewable.
- Secure infrastructure by default.
- Protect secrets and state.
- Ensure bootstrap/deploy paths are idempotent.

## Best Practices

### 1) Keep Terraform deterministic and reviewable

### DO

- Pin Terraform and provider major versions.
- Keep variables explicit and typed.
- Require `terraform plan` review before apply.

```hcl
terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 5.0" }
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 4.0" }
  }
}
```

### DON'T

- Use unpinned providers in production.
- Mix ad-hoc console-created resources with managed Terraform resources.

---

## 2) Secure by default (not later)

The current baseline uses permissive ingress (`0.0.0.0/0`) for speed. That is acceptable only as a temporary bootstrap.

### DO

- Restrict SSH CIDRs immediately.
- Restrict app ingress to known ranges or front with ALB/API gateway.
- Prefer SSM Session Manager over SSH keys for long-term ops.

### DON'T

- Leave SSH exposed globally.
- Assume “single instance” means “low risk.”

---

## 3) Secrets and state hygiene

### DO

- Keep secrets out of committed tfvars.
- Use sensitive variables for API tokens.
- Use remote backend + state locking for team workflows.

```hcl
variable "cloudflare_api_token" {
  type      = string
  sensitive = true
}
```

### DON'T

- Commit real values in `terraform.tfvars`.
- Rely on local state in multi-operator production environments.

---

## 4) EC2 bootstrap and deploy reliability

### DO

- Keep `user_data` idempotent and minimal.
- Move complex provisioning to versioned scripts/config management.
- Make deploy scripts fail fast (`set -euo pipefail`) and log clearly.

### DON'T

- Put large mutable app logic into Terraform `user_data` heredocs.
- Depend on manual fixes on the instance after each deploy.

---

## 5) CI/CD + Terraform workflow

Recommended flow:

1. Open infra PR.
2. Run `terraform fmt -check` and `terraform validate`.
3. Generate and review plan artifact.
4. Apply only from reviewed, trusted pipelines/environments.

## Common Mistakes

- Leaving broad ingress (`0.0.0.0/0`) in place beyond bootstrap.
- Committing secret values in tfvars.
- Using local state for collaborative production operations.
- Embedding large mutable deploy logic directly in `user_data`.

## Checklist

- [ ] Provider and Terraform versions are pinned.
- [ ] Secrets are externalized and marked sensitive.
- [ ] State backend and locking are configured for team usage.
- [ ] Ingress rules are restricted to necessary ranges.
- [ ] Deploy scripts are idempotent and fail fast.