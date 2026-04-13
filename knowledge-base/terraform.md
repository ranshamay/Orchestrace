# Terraform / HCL Best Practices

## Overview

Infrastructure lives under `infra/terraform` with standard files (`providers.tf`, `variables.tf`, `main.tf`, `outputs.tf`).

## Best Practices

### Keep structure predictable

- `providers.tf`: provider/version constraints
- `variables.tf`: typed inputs with descriptions
- `main.tf`: resources/modules
- `outputs.tf`: explicit outputs

### Pin versions

```hcl
terraform {
  required_version = ">= 1.6.0"
}
```

Pin providers to tested ranges.

### Use remote state + locking in real environments

Local state is fine for experiments, not for team production workflows.

### Prefer `for_each` over `count` for keyed resources

Improves stability when item ordering changes.

### Mark sensitive values

```hcl
variable "api_token" {
  type      = string
  sensitive = true
}
```

## Do and Don’t

### Do

- Run `terraform fmt`, `terraform validate`, and review `terraform plan` before apply.

### Don’t

- Commit secrets in tfvars.
- Skip plan review.
- Use lifecycle ignores as a blanket workaround.

## Common Pitfalls

- State drift from out-of-band changes.
- Circular references between modules/resources.
- Recreating resources unintentionally due to unstable keys.