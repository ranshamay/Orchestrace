# Shell Deployment Scripts Best Practices

## Overview

Deployment scripts (e.g., `infra/scripts/deploy-compute.sh`) are critical automation paths. Prioritize safety and predictability.

## Baseline Safety

```bash
#!/usr/bin/env bash
set -euo pipefail
```

Use strict mode by default.

## Best Practices

### Validate required inputs early

```bash
: "${GITHUB_REPOSITORY_URL:?GITHUB_REPOSITORY_URL is required}"
: "${GITHUB_REF_NAME:?GITHUB_REF_NAME is required}"
```

### Quote variables

```bash
git clone "$GITHUB_REPOSITORY_URL" "$APP_DIR"
```

### Idempotency

Scripts should be safely re-runnable (existing dirs/processes handled gracefully).

### Process management

Handle existing processes (`pm2 delete ... || true`) and ensure startup commands are explicit.

### Logging

Print clear step boundaries and failure context.

## Do and Don’t

### Do

- Use `trap` for cleanup when temp files or background processes are used.
- Check command existence (`command -v`).

### Don’t

- Use `eval` for dynamic command assembly.
- Leave unquoted expansions.

## Common Pitfalls

- Word splitting bugs from unquoted variables.
- Partial deploys without rollback strategy.
- Silent failures from ignored exit codes.