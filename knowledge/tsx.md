# tsx

`tsx` is the repo-standard way to execute TypeScript directly in development without a build step.

## Current monorepo pattern

- Root dev dependency: `tsx@^4.0.0`
- Used directly in package scripts (example: `packages/cli` and `packages/evals`)
- Used with Node ESM loader style in runtime paths:
  - `node --import tsx packages/cli/src/runner.ts ...`

## When to use `tsx`

Use `tsx` for:

- Local/dev entrypoints (`dev`, one-off scripts, smoke tests)
- Tooling CLIs that should run `.ts` files fast
- ESM-first workflows where `type: "module"` is set

Prefer `tsc` build output for:

- Published/runtime artifacts (`dist/*.js`)
- Production startup paths where deterministic build outputs are required

## Recommended scripts

```json
{
  "scripts": {
    "dev": "tsx src/index.ts",
    "run:task": "tsx src/tasks/run-task.ts",
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  }
}
```

## ESM execution guidance

This monorepo is ESM-first (`"type": "module"`), so prefer one of these patterns:

```bash
# Preferred direct form
pnpm tsx packages/cli/src/index.ts

# Node + import hook form (used in this repo)
node --import tsx packages/cli/src/runner.ts <sessionId> <workspaceRoot>
```

Notes:

- Keep import syntax ESM (`import ... from ...`), not CommonJS `require`.
- Keep `module` as `ESNext` and `moduleResolution` as `bundler` aligned with `tsconfig.base.json`.
- For cross-package imports, depend on workspace packages (`"workspace:*"`) instead of relative deep links.

## Monorepo version alignment

To avoid runtime and type drift:

- Keep `tsx` pinned at root and reuse it from package scripts.
- Avoid mixing significantly different major versions of `tsx` across packages.
- Align `typescript` and `@types/node` versions with runtime expectations for Node execution.

Practical check list when adding a new package script:

1. Add `"type": "module"` to `package.json`.
2. Add `"dev": "tsx src/index.ts"` (or equivalent entrypoint).
3. Ensure package `tsconfig.json` extends shared base config.
4. Keep `build`/`typecheck` scripts present (`tsc`, `tsc --noEmit`).