# HCL (Terraform) Best Practices

Terraform configurations should be deterministic, reviewable, and environment-safe.

## Core Principles

- Keep modules small, composable, and versioned.
- Prefer explicit inputs/outputs with validation.
- Avoid drift by treating state as critical infrastructure.

## Do / Don't

### 1) Validate variable contracts

```hcl
# ✅ Do
variable "environment" {
  type = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev|staging|prod"
  }
}
```

```hcl
# ❌ Don't
variable "environment" {
  type = any
}
```

### 2) Use `for_each` with stable keys

```hcl
# ✅ Do
resource "aws_s3_bucket" "logs" {
  for_each = { for name in var.bucket_names : name => name }
  bucket   = each.value
}
```

```hcl
# ❌ Don't
resource "aws_s3_bucket" "logs" {
  count  = length(var.bucket_names)
  bucket = var.bucket_names[count.index]
}
```

### 3) Pin providers and modules

```hcl
# ✅ Do
terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
```

```hcl
# ❌ Don't
# Unpinned versions increase upgrade risk
```

## Pitfalls

- Hardcoding secrets in `.tf` files or variables.
- Mixing unrelated resources in one module.
- Ignoring plan diffs in CI/CD.

## Performance Notes

- Reduce data-source overuse that triggers extra API calls.
- Split large states/modules to improve plan/apply speed.
- Use targeted refresh/operations carefully; avoid masking real drift.

## Practical Checklist

- [ ] Providers/modules pinned.
- [ ] Variable validation present for critical inputs.
- [ ] Remote state with locking configured.
- [ ] Plans reviewed before apply.