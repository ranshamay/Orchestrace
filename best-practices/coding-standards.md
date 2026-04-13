# Coding Standards Best Practices

## Overview
This guide defines repo-wide coding standards that apply across TypeScript/JavaScript, frontend code, scripts, and infrastructure-adjacent automation.

Use this as the default quality bar for new code and refactors.

Primary goals:
- **Readability first** (future maintainers can understand intent quickly)
- **Correctness by design** (types, validation, clear contracts)
- **Consistency** (same patterns across packages)
- **Low change risk** (small composable units, deterministic behavior)

---

## DO

### 1) Prefer explicit, typed contracts
- Use precise TypeScript types/interfaces for inputs/outputs.
- Model invalid states out of existence where possible (discriminated unions, literal types).
- Validate external/untrusted input at boundaries.

```ts
// Good: clear contract + explicit return type
export type AgentStatus = 'idle' | 'running' | 'failed';

export interface AgentSummary {
  id: string;
  status: AgentStatus;
  lastRunAt: string | null;
}

export function toSummary(raw: { id: string; status?: string; lastRunAt?: string }): AgentSummary {
  const status: AgentStatus =
    raw.status === 'running' || raw.status === 'failed' ? raw.status : 'idle';

  return {
    id: raw.id,
    status,
    lastRunAt: raw.lastRunAt ?? null,
  };
}
```

### 2) Keep functions small and single-purpose
- One function should do one thing well.
- Split orchestration from pure transformation logic.
- Isolate side effects (I/O, env, network) for testability.

### 3) Use meaningful names
- Use names that reveal intent, not implementation details.
- Prefer domain terms from the repo (agent, run, phase, provider, toolset).

### 4) Handle errors deliberately
- Throw/use structured errors with actionable context.
- Fail early for invalid input.
- Avoid silent catches unless intentionally swallowing with comment + metric/log.

```ts
try {
  await runDeployment(plan);
} catch (error) {
  throw new Error(`Deployment failed for environment=${envName}: ${String(error)}`);
}
```

### 5) Use modular file design (explicit file boundaries)

Modular code means splitting by **responsibility** and **change frequency**, not by arbitrary file count.

#### File/module boundary rules
- Keep one primary responsibility per file.
- Keep feature/domain code grouped together.
- Keep side effects in boundary modules (`api.ts`, `repository.ts`, `cli.ts`) and pure logic in separate modules.
- Prefer many small cohesive modules over one “god file”.

#### Recommended feature-oriented structure
```txt
packages/app/src/features/runs/
  index.ts              # public exports for this feature
  types.ts              # feature-local types/contracts
  constants.ts          # stable constants only
  run-label.ts          # pure domain logic
  run-service.ts        # orchestration/use-case logic
  run-repository.ts     # I/O layer (DB/API/fs)
  run-service.test.ts   # tests close to implementation
```

#### Export/import standards
- Use `index.ts` as the **public API** of a folder/package.
- Keep internals unexported unless required by another module.
- Import from stable boundaries (`features/runs`) rather than deep internals (`features/runs/run-repository/internal-x`).
- Avoid circular imports by separating shared types/constants into neutral modules.

```ts
// Good: stable public import
import { createRun, type RunInput } from '@/features/runs';

// Avoid: deep coupling to implementation details
import { persistRunRecord } from '@/features/runs/run-repository';
```

#### What to split into separate files
- Split when code has different reasons to change (e.g., parsing vs rendering vs I/O).
- Split when a file exceeds readability (roughly >200-300 LOC or multiple conceptual sections).
- Split when parts need different test styles (unit vs integration).

#### What not to split
- Don’t fragment tiny, tightly-coupled logic across many files “for purity”.
- Don’t create generic `utils.ts` buckets with unrelated helpers.
- Don’t create abstraction layers until at least 2-3 real call sites need them.

### 6) Write code for diffs and reviews
- Prefer smaller PR-sized changes over massive rewrites.
- Include comments only when intent is non-obvious.
- Keep comments aligned with code reality (delete stale comments quickly).

### 7) Use async patterns safely
- Use `await` for sequencing when order matters.
- Use `Promise.all` only for truly independent operations.
- Ensure promise rejections are surfaced and handled.

### 8) Respect linting and formatting as guardrails
- Treat ESLint + Prettier warnings/errors as quality gates, not suggestions.
- Auto-fix where safe; discuss rule changes before disabling rules.

---

## DON'T

- Don’t use `any` when a real type can be defined.
- Don’t mix unrelated concerns in one function (validation + DB + rendering + logging).
- Don’t introduce hidden global state that makes behavior order-dependent.
- Don’t suppress lints with broad disables (`eslint-disable`) without scoped reason.
- Don’t write clever one-liners that reduce readability.
- Don’t hardcode environment-specific paths, URLs, or credentials.
- Don’t mutate inputs unless mutation is explicit and intentional.
- Don’t create “god modules” that own unrelated responsibilities.
- Don’t import deeply into another module’s internals unless there is no stable public API.

```ts
// Avoid: unclear behavior, mutates input, weak typing
function normalize(config: any) {
  config.mode = config.mode || 'default';
  return config;
}
```

---

## Configuration

### Lint/format execution
Use repo scripts and package filters rather than ad-hoc commands:

```bash
pnpm lint
pnpm format
pnpm typecheck
```

When iterating in a single package:

```bash
pnpm --filter <package-name> lint
pnpm --filter <package-name> typecheck
```

### Recommended enforcement
- Keep CI failing on lint/typecheck/test failures.
- Prefer pre-commit or pre-push checks for fast feedback loops.
- Keep tsconfig strictness aligned across packages unless deviation is justified.

---

## Project-specific notes

- This monorepo uses **pnpm workspaces + Turborepo**: keep package boundaries clean and avoid accidental cross-package coupling.
- Favor shared utilities in dedicated packages only when reuse is real; avoid premature abstraction.
- For agent/tooling code, keep policy logic explicit and auditable (clear naming, minimal magic behavior).
- For frontend code, align with existing React/Tailwind patterns and avoid introducing parallel styling/state patterns without agreement.
- Prefer `feature/index.ts` exports to make agent-generated code consume stable module boundaries.

---

## Examples

### DO: pure transform + side-effect wrapper
```ts
// Pure logic (easy to test)
export function buildRunLabel(id: string, phase: 'plan' | 'apply'): string {
  return `${phase.toUpperCase()}::${id}`;
}

// Side-effect boundary
export async function logRunLabel(logger: { info: (msg: string) => void }, id: string) {
  logger.info(buildRunLabel(id, 'plan'));
}
```

### DO: modular feature boundary
```ts
// features/runs/index.ts
export { createRun } from './run-service';
export type { RunInput, RunResult } from './types';

// features/runs/run-service.ts
import type { RunInput, RunResult } from './types';
import { saveRun } from './run-repository';

export async function createRun(input: RunInput): Promise<RunResult> {
  // orchestrate; keep logic readable
  return saveRun(input);
}
```

### DON'T: mixed concerns / god module
```ts
// Avoid: fetch + parse + mutate + log + return random shape in one place
async function process(input: any) {
  const data = await fetch(input.url).then(r => r.json());
  input.status = 'done';
  console.log(data);
  return { ok: true, d: data };
}
```