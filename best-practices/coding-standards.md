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

### 5) Keep modules cohesive
- Group files by feature/domain over technical layer when practical.
- Avoid giant utility files with unrelated helpers.
- Export stable public APIs from package boundaries.

### 6) Use modular file design (hard limit: no more than 200 LOC per file)
- **Rule:** **no more than 200 lines of code (LOC) per source file**.
- Count LOC as non-empty, non-comment source lines.
- If a file approaches ~160–180 LOC, proactively split it.

- Split by responsibility: UI, state, domain logic, I/O adapters, and types.
- Keep a small public API (`index.ts`) and avoid deep imports into internals.
- Prefer **high cohesion + low coupling**: things that change together stay together; unrelated concerns are separated.

Recommended layout:
```text
feature-x/
  index.ts           # public exports only
  feature-x.types.ts
  feature-x.logic.ts
  feature-x.ui.tsx
  feature-x.api.ts
```

Industry-backed modular suggestions to apply:
- **Package by feature/domain** first, not by technical layer only.
- **Stable dependencies rule**: domain logic must not depend on UI/framework internals.
- **Dependency direction inward**: UI/infrastructure depend on domain, not vice versa.
- **One module = one reason to change** (SRP at module level).
- **No deep imports** across module internals (`feature-a/internal/*` is private).
- **Prefer composition over inheritance** for reusable behavior.

Exceptions (must be documented in-file):
- Generated code
- Schema/migration snapshots
- Intentional composition roots (kept readable and reviewed)

```ts
// DO: split responsibilities
// user.logic.ts
export function normalizeUserName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

// user.api.ts
export async function fetchUser(id: string) {
  // network boundary only
}
```

```ts
// DON'T: one "god file" handling UI + fetch + validation + mapping + storage
// user.ts (350+ LOC)
```



### 7) Write code for diffs and reviews
- Prefer smaller PR-sized changes over massive rewrites.
- Include comments only when intent is non-obvious.
- Keep comments aligned with code reality (delete stale comments quickly).

### 8) Use async patterns safely

- Use `await` for sequencing when order matters.
- Use `Promise.all` only for truly independent operations.
- Ensure promise rejections are surfaced and handled.

### 9) Respect linting and formatting as guardrails

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
- Don’t allow any file to exceed **200 LOC** without approved/documented exception.



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
- Add/enable a file-length check in linting or CI to enforce the **200 LOC** limit for source files.
- Require a short justification comment for any file-length exception.
- Block merges if new/modified source files exceed 200 LOC without approved exception.

Example ESLint rule:
```js
// eslint.config.js (flat config example)
export default [
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    rules: {
      'max-lines': ['error', { max: 200, skipBlankLines: true, skipComments: true }],
    },
  },
];
```

Example CI gate:
```bash
pnpm lint && pnpm typecheck && pnpm test
```



---

## Project-specific notes

- This monorepo uses **pnpm workspaces + Turborepo**: keep package boundaries clean and avoid accidental cross-package coupling.
- Favor shared utilities in dedicated packages only when reuse is real; avoid premature abstraction.
- For agent/tooling code, keep policy logic explicit and auditable (clear naming, minimal magic behavior).
- For frontend code, align with existing React/Tailwind patterns and avoid introducing parallel styling/state patterns without agreement.

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

### DON'T: mixed concerns
```ts
// Avoid: fetch + parse + mutate + log + return random shape in one place
async function process(input: any) {
  const data = await fetch(input.url).then(r => r.json());
  input.status = 'done';
  console.log(data);
  return { ok: true, d: data };
}
```