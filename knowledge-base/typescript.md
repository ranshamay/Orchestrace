# TypeScript Best Practices

## Overview

Orchestrace uses strict TypeScript with ESM defaults (`type: module`) and `tsconfig.base.json` settings such as:

- `target: ES2023`
- `module: ESNext`
- `moduleResolution: bundler`
- `strict: true`
- `isolatedModules: true`
- `verbatimModuleSyntax: true`

Goal: catch bugs at compile time and keep runtime behavior explicit.

## Configuration Best Practices

- Extend `tsconfig.base.json` from package-level `tsconfig.json` files.
- Keep strict mode enabled; do not relax globally.
- Use `import type` for type-only imports.
- Keep emitted code ESM-friendly.

```ts
import type { RunRecord } from './types.js';
import { loadRun } from './load-run.js';
```

## Best Practices

### 1) Prefer `unknown` over `any`

```ts
function parse(input: string): unknown {
  return JSON.parse(input);
}
```

Narrow before use with type guards.

### 2) Use discriminated unions for workflow states

```ts
type Status =
  | { kind: 'idle' }
  | { kind: 'running'; startedAt: number }
  | { kind: 'failed'; reason: string };
```

### 3) Enforce exhaustiveness

```ts
function assertNever(x: never): never {
  throw new Error(`Unexpected: ${JSON.stringify(x)}`);
}
```

### 4) Encode invariants in types

Use branded IDs, readonly arrays, and literal unions instead of free-form strings.

## Do and Don’t

### Do

```ts
const nodeTypes = ['plan', 'code', 'review'] as const;
type NodeType = (typeof nodeTypes)[number];
```

### Don’t

```ts
// bad: no guardrails
function execute(kind: string, data: any) {}
```

## Common Pitfalls

- Using `as` casts to silence real type mismatches.
- Mixing runtime imports and type imports under `verbatimModuleSyntax`.
- Skipping narrowing for parsed JSON.
- Ignoring `undefined`/`null` in API response types.

## Repo-Specific Notes

- Keep `.ts` source in `src/`, emit to `dist/`.
- Prefer package-local types exported from stable boundaries (`index.ts`).
- Run `pnpm typecheck` before finalizing large refactors.