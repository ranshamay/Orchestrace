# Terraform Best Practices (Operations-Focused)

Use Terraform for declarative infrastructure with strict state controls, safe rollout mechanisms, and repeatable automation.

## Reliability

- Pin provider and module versions (`required_providers`, module refs/tags).
- Use CI to run `terraform fmt -check`, `validate`, and `plan` on every change.
- Keep modules small, composable, and environment-agnostic.
- Prefer immutable infrastructure patterns where practical.

## State Management

- Use remote backends (e.g., S3 + DynamoDB lock, Terraform Cloud, GCS).
- Enable state locking to prevent concurrent apply corruption.
- Encrypt state at rest and in transit.
- Restrict state access with least privilege IAM.
- Never commit `terraform.tfstate` or `.tfvars` with secrets.

## Retries & Concurrency

- Let Terraform/provider handle transient API retries; tune provider retry config where available.
- Serialize `apply` per workspace/environment.
- Retry failed applies only after root-cause review (avoid blind loops).

## Security

- Mark outputs/variables as `sensitive` where applicable.
- Use secret managers (Vault, AWS Secrets Manager, SSM) instead of plaintext variables.
- Run policy checks (OPA/Conftest/Sentinel/tfsec/checkov) in CI.
- Enforce least privilege for CI runner credentials.

## Idempotency & Drift

- Ensure resources converge with repeated `apply` (no timestamp/random side effects without keepers).
- Detect drift via scheduled `plan` and alert on non-empty diffs.
- Use `lifecycle` arguments (`prevent_destroy`, targeted `ignore_changes`) intentionally and sparingly.

## Safe Deployment Pattern

1. `terraform init -upgrade=false`
2. `terraform validate`
3. `terraform plan -out=tfplan`
4. Manual/automated approval gate
5. `terraform apply tfplan`

This guarantees the applied change matches the reviewed plan.

## Do / Don’t

### Do

- Do separate environments/workspaces and isolate state.
- Do import pre-existing resources before managing them.
- Do tag resources consistently for ownership and cost visibility.

### Don’t

- Don’t run `apply` from developer laptops for production.
- Don’t use `-target` for normal operations (only break-glass scenarios).
- Don’t store long-lived cloud keys in CI variables when OIDC/workload identity is available.