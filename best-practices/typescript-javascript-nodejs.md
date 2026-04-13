# TypeScript / JavaScript / Node.js Best Practices (Orchestrace)

## Overview

This repository is a **TypeScript-first Node.js monorepo** with:

- ESM (`"type": "module"`)
- strict TypeScript (`strict: true`, `isolatedModules: true`, `verbatimModuleSyntax: true`)
- pnpm workspaces + Turbo
- ESLint 9 + `typescript-eslint`
- Vitest for tests

Use these practices to keep code safe, maintainable, and aligned with existing package patterns under `packages/*/src`.

---

## DO

### 1) Prefer explicit, strict types at boundaries

**DO:** type all public APIs and I/O boundaries (CLI args, env vars, file data, network responses).

```ts
export interface RunOptions {
  workspace: string;
  maxParallel: number;
  autoApprove: boolean;
}

export function normalizeRunOptions(input: Partial<RunOptions>): RunOptions {
  return {
    workspace: input.workspace ?? process.cwd(),
    maxParallel: input.maxParallel ?? 4,
    autoApprove: input.autoApprove ?? false,
  };
}
```

### 2) Validate environment variables and parse once

Avoid reading raw `process.env.X` all over the code. Parse + normalize in one place.

```ts
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const settings = {
  maxParallel: parsePositiveInt(process.env.ORCHESTRACE_MAX_PARALLEL, 4),
  autoApprove: process.env.ORCHESTRACE_AUTO_APPROVE === 'true',
} as const;
```

### 3) Use `node:` imports for built-ins

This is consistent across the repo and avoids ambiguity.

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
```

### 4) Use `unknown` + narrowing instead of `any`

`any` is allowed as warning, but should be the exception.

```ts
function asErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}
```

### 5) Keep async flows cancellation-aware and error-safe

```ts
export async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([work, timeout]);
}
```

### 6) Return structured results for operational code

Prefer result objects when failures are expected.

```ts
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function readJsonFile(path: string): Promise<Result<unknown>> {
  try {
    const raw = await readFile(path, 'utf8');
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
```

### 7) Prefer small pure helpers for logic, thin side-effect wrappers

```ts
export function resolveTaskRoute(prompt: string): 'shell' | 'code' | 'investigation' {
  const text = prompt.toLowerCase();
  if (text.includes('investigate')) return 'investigation';
  if (text.includes('run') || text.includes('command')) return 'shell';
  return 'code';
}
```

### 8) Write tests for behavior, not implementation details

```ts
import { describe, expect, it } from 'vitest';
import { resolveTaskRoute } from '../src/router';

describe('resolveTaskRoute', () => {
  it('detects investigation prompts', () => {
    expect(resolveTaskRoute('Investigate flaky CI')).toBe('investigation');
  });
});
```

### 9) Keep logs actionable and safe

```ts
function logCommandStart(command: string, cwd: string): void {
  console.info('[command:start]', { command, cwd, at: new Date().toISOString() });
}
```

- Include context (`cwd`, IDs, attempt number)
- Avoid leaking secrets (auth tokens, keys)

### 10) Respect monorepo package boundaries

- Keep each package cohesive.
- Export from package entrypoints.
- Avoid deep imports into another package internals.

```ts
// ✅ preferred
import { createProvider } from '@orchestrace/provider';

// ❌ avoid
import { internalX } from '@orchestrace/provider/dist/internal/x.js';
```

---

## DON'T

### 1) Don’t bypass strict null checks

```ts
// ❌ avoid
const provider = config.provider!.toLowerCase();

// ✅ do
if (!config.provider) throw new Error('provider is required');
const provider = config.provider.toLowerCase();
```

### 2) Don’t scatter `process.env` access in core logic

```ts
// ❌ avoid
if (process.env.ORCHESTRACE_AUTO_PUSH === 'true') { ... }

// ✅ do
if (settings.autoPush) { ... }
```

### 3) Don’t swallow errors silently

```ts
// ❌ avoid
try {
  await runTask();
} catch {}

// ✅ do
try {
  await runTask();
} catch (error) {
  logger.error('runTask failed', { error: asErrorMessage(error) });
  throw error;
}
```

### 4) Don’t mix CJS and ESM patterns

```ts
// ❌ avoid in this repo
const fs = require('fs');
module.exports = { fs };

// ✅ use ESM
import { readFile } from 'node:fs/promises';
export { readFile };
```

### 5) Don’t create giant functions for orchestration flows

Break into focused functions (`parseInput`, `plan`, `execute`, `verify`, `persist`).

### 6) Don’t overuse classes where plain functions + data are enough

Prefer composable functions unless object lifecycle/state warrants a class.

---

## Configuration

### TypeScript (`tsconfig.base.json`)

Use and preserve current defaults unless a strong reason exists:

- `strict: true`
- `module: "ESNext"`
- `moduleResolution: "bundler"`
- `target/lib: ES2023`
- `isolatedModules: true`
- `verbatimModuleSyntax: true`

**Implications:**

- Use modern ESM syntax consistently.
- Avoid TS patterns that rely on non-isolated compilation behavior.
- Keep imports/exports explicit and runtime-correct.

### ESLint (`eslint.config.js`)

Current posture is pragmatic:

- `no-unused-vars` = warn (`_`-prefixed values ignored)
- `no-explicit-any` = warn

Treat warnings as “fix unless justified.” Use `_` for intentionally unused params.

```ts
function onEvent(_raw: string, parsed: unknown): void {
  // parsed is used, _raw intentionally ignored
  console.log(parsed);
}
```

### Package scripts and workflow

From repo root:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

For package-scoped work, use filter with dependency builds:

```bash
pnpm --filter @orchestrace/tools test
pnpm --filter @orchestrace/cli... build
```

---

## Project-specific notes

1. **Internal package outputs come from `dist/`**
   - Build dependent workspace packages before strict typecheck/test runs.

2. **Prefer Node native APIs and stdlib imports**
   - Existing code consistently uses `node:*` specifiers.

3. **Be disciplined with env-driven behavior**
   - This repo has many `ORCHESTRACE_*` flags.
   - Add new env vars with:
     - clear naming
     - parser/normalizer
     - default value
     - docs update (`README` or package docs)

4. **Validation-gated development is first-class**
   - New features should be compatible with `typecheck`, `vitest`, and lint pipelines.
   - If adding retry/timeout logic, make values explicit and test edge cases.

5. **Use deterministic filesystem and process handling**
   - Normalize paths, avoid implicit cwd assumptions, and guard external command execution.

```ts
import { resolve } from 'node:path';

export function resolveWorkspacePath(base: string, maybeRelative: string): string {
  return resolve(base, maybeRelative);
}
```

6. **Keep code generation and orchestration flows auditable**
   - Prefer structured event records over ad hoc string logs.
   - Include task IDs/session IDs for traceability.

---

If you follow this guide, your changes should integrate cleanly with the repo’s strict TS + ESM + monorepo orchestration architecture and reduce regressions in CI and runtime behavior.