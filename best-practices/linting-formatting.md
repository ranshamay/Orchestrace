# ESLint & Prettier Best Practices

## Purpose

Keep code quality and style consistent across all packages with fast feedback locally and deterministic checks in CI.

## Required Structure

- Keep a **single root ESLint flat config** (`eslint.config.js`) for monorepo-wide defaults.
- Run lint through the root script:
  - `pnpm lint` → `eslint .`
- Run formatting through root scripts:
  - `pnpm format` → applies formatting
  - `pnpm format:check` → CI-safe formatting validation
- Scope formatting targets intentionally (current repo target: `packages/*/src/**/*.ts`).

## ESLint Practices

### DO

- Use `typescript-eslint` recommended config as baseline.
- Keep ignores explicit (`node_modules`, `dist`, generated files).
- Use `warn` (not `off`) for migration-phase rules such as `no-explicit-any`.
- Use underscore-prefix conventions for intentionally unused args/vars.
- Treat lint failures as merge blockers once rule maturity is stable.

```ts
// DO: intentionally unused parameter marked with underscore
function onEvent(_rawPayload: string, parsed: { id: string }) {
  return parsed.id;
}

// DO: prefer specific type or unknown over any
function parseJson(input: string): unknown {
  return JSON.parse(input);
}
```

### DON'T

- Don’t disable rules globally to fix one file.
- Don’t use `any` when `unknown`, generics, or discriminated unions fit.
- Don’t mix formatting concerns into ESLint rules when Prettier already owns style.

```ts
// DON'T
/* eslint-disable @typescript-eslint/no-explicit-any */
function handle(data: any) {
  return data.value;
}
```

## Prettier Practices

### DO

- Let Prettier own whitespace, wrapping, quotes, commas, and semicolons.
- Use `format:check` in CI and `format` locally before commit.
- Keep formatting command deterministic and scoped to source files.

```bash
# DO
pnpm format
pnpm format:check
```

### DON'T

- Don’t hand-format code and fight auto-format output.
- Don’t run partially different formatter settings across packages.
- Don’t block linting on stylistic rules already guaranteed by Prettier.

```bash
# DON'T: ad-hoc one-off formatting paths that drift from team scripts
prettier --write "some/random/path/**/*.ts"
```

## Recommended Workflow

1. Write/update code.
2. Run `pnpm lint`.
3. Run `pnpm format`.
4. Re-run `pnpm format:check` and `pnpm lint` before push.

## Maintenance Rules

- Prefer incremental rule tightening (`warn` -> `error`) over abrupt hard-fail rollouts.
- Revisit ignore patterns quarterly to avoid silently skipping new code paths.
- Document any rule exceptions inline with rationale and issue link.