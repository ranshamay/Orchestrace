# Shell Deployment Script Best Practices

Shell scripts are effective deployment glue when written defensively and made observable.

## Reliability

- Use strict mode in Bash:

```sh
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
```

- Fail fast on missing prerequisites (`command -v`, required env vars).
- Use explicit timeouts for network calls (`curl --max-time`, `timeout` wrapper).
- Print step-level logs with timestamps and correlation ids.

## Retries

- Retry only transient operations (artifact download, registry push, API polling).
- Use exponential backoff + jitter + max attempts.

```sh
retry() {
  local max=$1; shift
  local attempt=1
  until "$@"; do
    if [ "$attempt" -ge "$max" ]; then return 1; fi
    sleep $(( (RANDOM % 3) + attempt * 2 ))
    attempt=$((attempt + 1))
  done
}
```

- Do not retry deterministic failures (invalid args, auth denied, missing files).

## Security

- Never echo secrets; disable xtrace around sensitive commands.
- Prefer short-lived credentials (OIDC, STS) over static keys.
- Quote variables to prevent globbing/word-splitting bugs: `"$VAR"`.
- Validate inputs (branch names, environment names) before use.

## State Management

- Track deployment state explicitly:
  - release id/version
  - target environment
  - artifact digest
  - start/end timestamp
- Write checkpoints to durable store (artifact metadata, DB, or deployment API).
- Use lock mechanisms to prevent concurrent deploys to same environment.

## Idempotency

- Scripts must be safe to rerun:
  - `mkdir -p`
  - `kubectl apply`/declarative commands over imperative create
  - check-before-create for resources
- Use immutable artifact identifiers (content digest, versioned tags).
- Gate irreversible steps with explicit confirmation flags in prod.

## Do / Don’t

### Do

- Do include `trap` handlers for cleanup/rollback hooks.
- Do run shellcheck in CI.
- Do separate build and deploy stages, passing immutable artifacts between them.

### Don’t

- Don’t rely on local machine state (`~/.kube/config`, unstaged files) in CI deploys.
- Don’t parse JSON with grep/sed; use `jq`.
- Don’t continue after failed critical steps.