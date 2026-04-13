# concurrently Best Practices

## Why use concurrently

Use `concurrently` to run multiple long-lived dev commands (API, web app, watcher, mock services) from one entry point with readable output and reliable shutdown behavior.

## Naming and coloring output

Use explicit process names and colors so logs are scannable.

```json
{
  "scripts": {
    "dev": "concurrently --names api,web,worker --prefix name --prefix-colors blue,green,magenta \"pnpm --filter @app/api dev\" \"pnpm --filter @app/web dev\" \"pnpm --filter @app/worker dev\""
  }
}
```

Guidelines:
- Keep names short and stable (`api`, `web`, `worker`).
- Use consistent colors across scripts and docs.
- Prefer `--prefix name` (or timestamp+name if needed during incidents).

## Shutdown and failure behavior

Pick shutdown behavior intentionally:

- `--kill-others` / `-k`: if one command exits, terminate siblings.
- `--kill-others-on-fail`: terminate siblings only when a process fails.
- `--success first|last|all`: define success semantics for CI-like flows.

Examples:

```json
{
  "scripts": {
    "dev": "concurrently -k --names api,web \"pnpm dev:api\" \"pnpm dev:web\"",
    "test:watch": "concurrently --kill-others-on-fail --success all --names unit,e2e \"pnpm test:unit\" \"pnpm test:e2e\""
  }
}
```

Recommended defaults:
- Local dev: `-k` to avoid orphaned processes.
- Validation pipelines: `--kill-others-on-fail --success all` for deterministic failure.

## Integration with env loading

If commands rely on env files, make env loading explicit per command rather than assuming global shell state.

```json
{
  "scripts": {
    "dev": "concurrently --names api,web \"dotenv -e .env.local -- pnpm dev:api\" \"dotenv -e .env.local -- pnpm dev:web\""
  }
}
```

## Operational hygiene

- Avoid very long one-liners; split into `dev:api`, `dev:web`, etc.
- Keep command order stable (left-to-right critical path).
- Document each named process in README/dev docs.
- Prefer workspace filters over `cd` chains in monorepos.

## Anti-patterns

- Running processes without names/colors in team scripts.
- Depending on manual Ctrl+C cleanup of child processes.
- Mixing unrelated ephemeral tasks with long-running dev services in one command.

## Quick template

```json
{
  "scripts": {
    "dev:api": "tsx watch packages/api/src/index.ts",
    "dev:web": "vite",
    "dev": "concurrently -k --names api,web --prefix-colors blue,green \"pnpm dev:api\" \"pnpm dev:web\""
  }
}
```