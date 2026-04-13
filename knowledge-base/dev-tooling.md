# Dev/Process Tooling Best Practices (concurrently, dotenv)

## Overview

Orchestrace uses `concurrently` to run backend/frontend dev processes and `dotenv` patterns for environment config management.

## concurrently Best Practices

The root `start` script uses named processes and colors:

- `-n 'backend,frontend'`
- `-c 'blue,green'`

### Good pattern

```bash
concurrently \
  -n "backend,frontend" \
  -c "blue,green" \
  "pnpm --filter @orchestrace/cli dev ui --port 4310" \
  "pnpm --filter @orchestrace/ui dev"
```

- Use `--kill-others-on-fail` for fail-fast local loops.
- Ensure dependent processes wait for readiness when required.

## dotenv Best Practices

- Keep `.env` local and ignored.
- Provide `.env.example` with documented keys.
- Validate required vars at app startup.
- Separate local/dev/staging/prod config clearly.

### Type-safe env parsing example

```ts
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}
```

## Do and Don’t

### Do

- Document every env variable’s purpose and default.
- Keep secrets in secret managers for production.

### Don’t

- Commit real secrets to Git.
- Depend on implicit env load order across scripts.

## Common Pitfalls

- Race conditions between concurrent services at startup.
- Drifting env keys between code and `.env.example`.