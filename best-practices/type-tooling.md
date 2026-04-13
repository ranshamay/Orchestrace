# TypeScript, tsx, and @types Tooling Best Practices

## Overview

Preserve strict type safety and predictable runtime behavior while keeping local developer workflows fast.

## Key Principles

- Use a **shared root base config** (`tsconfig.base.json`) for language/runtime defaults.
- Each package `tsconfig.json` must:
  - `extends` the base config
  - set package-local `rootDir` and `outDir`
  - include only package source (`"include": ["src"]`)
- Use root scripts for lifecycle consistency:
  - `pnpm build`
  - `pnpm typecheck`
- Use `tsx` for local TS entrypoints and tooling scripts (e.g., CLI dev/start scripts), not as a replacement for package build artifacts.

## Best Practices

### TypeScript Practices

### DO

- Keep `strict: true` enabled.
- Prefer `unknown` + narrowing over `any`.
- Keep `isolatedModules` and `verbatimModuleSyntax` compatible code patterns.
- Export/import types with explicit `type` modifiers where appropriate.

```ts
// DO: unknown + narrowing
export function getRunId(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const maybeId = (value as { id?: unknown }).id;
    if (typeof maybeId === 'string') return maybeId;
  }
  throw new Error('Invalid run id');
}
```

### DON'T

- Don’t weaken compiler options per package unless there is a documented, temporary exception.
- Don’t use `skipLibCheck: false` flips or module setting overrides ad hoc across packages.
- Don’t hide unsafe casts in utility wrappers.

```ts
// DON'T
export function getRunId(value: any): string {
  return value.id;
}
```

## tsx Practices

### DO

- Use `tsx` for developer ergonomics in local commands (`dev`, one-off scripts, evaluators).
- Keep production/package outputs compiled via `tsc`/build pipeline.
- Use ESM-compatible imports consistent with repo `"type": "module"`.

```json
{
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc -p tsconfig.json"
  }
}
```

### DON'T

- Don’t depend on `tsx` execution in published runtime artifacts.
- Don’t mix CommonJS-only patterns into ESM TS codepaths.

## @types Dependency Practices

### DO

- Add `@types/*` only when a dependency does not ship its own types.
- Keep ambient type packages version-aligned with the runtime major version.
- Prefer package-local `@types/*` when only one workspace package needs it.
- Keep `@types/node` aligned with target Node runtime assumptions.

```bash
# DO: install missing type declarations for one package
pnpm --filter @orchestrace/cli add -D @types/some-legacy-lib
```

### DON'T

- Don’t add duplicate `@types/*` at root and package level without reason.
- Don’t leave stale `@types/*` after dependency removal.

## Common Mistakes

- Relaxing strict compiler settings per package without temporary exception rationale.
- Using `any` in core paths instead of narrowing `unknown`.
- Relying on `tsx` for production runtime execution.
- Keeping stale `@types/*` packages after dependency changes.

## Checklist

- `pnpm build` passes.
- `pnpm typecheck` passes.
- No new `any` usage without explicit, documented justification.
- New scripts use `tsx` only for dev-time execution.