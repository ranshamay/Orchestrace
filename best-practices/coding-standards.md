# Coding Standards (Modular, Maintainable, Testable Code)

## Overview

This document defines cross-cutting coding standards for the Orchestrace stack with emphasis on **modularity**, **testability**, and **long-term maintainability**.

These standards complement technology-specific guides in this folder (TypeScript, React, Node.js, ESLint, etc.).

---

## Key Principles

1. **Design for change**: separate policy/business rules from framework/infrastructure details.
2. **Small composable units**: each module has one clear responsibility.
3. **Explicit boundaries**: dependency direction should be obvious and intentional.
4. **Testability by design**: dependencies are injected, side effects are isolated.
5. **Deterministic behavior**: avoid hidden global state, ambient config, and implicit IO.
6. **Fail safely**: validate inputs, return typed errors, and expose actionable diagnostics.

---

## Standards

## 1) Module boundaries and dependency direction

### ✅ DO

- Keep domain logic independent from transport/UI/framework layers.
- Define stable interfaces (ports) for external systems (filesystem, HTTP, DB, AI provider).
- Keep module APIs small and explicit.

```ts
// domain/token-budget.ts
export interface TokenCounter {
  count(input: string): number;
}

export function fitsBudget(input: string, maxTokens: number, counter: TokenCounter): boolean {
  return counter.count(input) <= maxTokens;
}
```

### ❌ DON'T

- Couple domain logic directly to concrete SDKs/utilities.
- Import infra concerns deeply into business rules.

```ts
// DON'T: hard coupling makes this hard to test/replace
import { encodingForModel } from 'js-tiktoken';

export function fitsBudget(input: string, maxTokens: number): boolean {
  const enc = encodingForModel('gpt-4o-mini');
  return enc.encode(input).length <= maxTokens;
}
```

---

## 2) Dependency injection over hidden globals

### ✅ DO

- Inject clocks, random generators, environment access, network clients.
- Use small factories/composition roots at the boundary of the app.

```ts
export interface Clock { now(): Date }

export function isExpired(expiresAtIso: string, clock: Clock): boolean {
  return new Date(expiresAtIso).getTime() <= clock.now().getTime();
}
```

### ❌ DON'T

```ts
// DON'T: hard-wired Date.now() causes brittle tests
export function isExpired(expiresAtIso: string): boolean {
  return new Date(expiresAtIso).getTime() <= Date.now();
}
```

---

## 3) Pure logic first, side effects at edges

### ✅ DO

- Keep pure transformations in dedicated functions.
- Wrap side effects (IO, process env, network, filesystem) in adapter modules.

### ❌ DON'T

- Mix parsing, transformation, network calls, and rendering in one function.

---

## 4) Type-first contracts (TypeScript)

### ✅ DO

- Enable strict typing and model domain states explicitly (discriminated unions).
- Use `unknown` at boundaries and validate before use.
- Export named types for public module contracts.

```ts
type LoadResult =
  | { ok: true; value: Config }
  | { ok: false; reason: 'missing' | 'invalid'; message: string };
```

### ❌ DON'T

- Use `any` in core paths.
- Return ambiguous `null | undefined | false` mixtures.

---

## 5) Error handling and observability

### ✅ DO

- Convert low-level errors into domain-level errors with context.
- Keep logs structured and safe (no secrets).
- Include actionable fields: operation, correlation ID, environment, retryability.

### ❌ DON'T

- Swallow errors silently.
- Leak tokens/secrets in logs or thrown messages.

---

## 6) Configuration and environment handling

(Aligned with Twelve-Factor config guidance.)

### ✅ DO

- Read environment variables through a single config module.
- Validate config on startup and fail fast on invalid/missing required values.
- Keep defaults explicit and safe.

### ❌ DON'T

- Scatter `process.env.*` access across modules.
- Hardcode deploy-specific values in source code.

---

## 7) React/UI composition rules

### ✅ DO

- Keep presentational components mostly pure.
- Move data loading and side effects into hooks or route loaders.
- Co-locate component, styles, and tests by feature.
- Keep component props small and typed.

### ❌ DON'T

- Put business orchestration into large UI components.
- Trigger network side effects directly during render.

---

## 8) Monorepo and package boundaries (pnpm + Turborepo)

### ✅ DO

- Keep package public APIs intentional (`index.ts` barrel or explicit exports).
- Avoid importing package internals via deep private paths.
- Prefer acyclic dependency graphs between packages.

### ❌ DON'T

- Create cross-package circular dependencies.
- Share code via copy/paste when a package/module boundary is appropriate.

---

## Common Anti-Patterns

- “God modules” that own parsing + business logic + IO + formatting.
- Hidden singleton state that changes behavior across tests/runtime.
- Implicit cross-module contracts (“this string must look like X”).
- Over-abstracting too early (generic frameworks before real reuse appears).
- Default exports everywhere (harder refactors / inconsistent naming).

---

## PR Checklist (Coding Standards)

- [ ] Does each module have one clear responsibility?
- [ ] Are side effects isolated behind adapters/interfaces?
- [ ] Are external dependencies injected where determinism matters (time, random, IO)?
- [ ] Are input/output contracts explicit and strongly typed?
- [ ] Are errors contextual, safe, and actionable?
- [ ] Is config read/validated in a central place?
- [ ] Are package boundaries respected (no deep private imports)?
- [ ] Is new code easy to unit test without browser/network/process coupling?

---

## References (Web)

- Twelve-Factor App — Codebase: https://12factor.net/codebase
- Twelve-Factor App — Config: https://12factor.net/config
- Google JavaScript Style Guide (historical, TS migration note): https://google.github.io/styleguide/jsguide.html
- Martin Fowler — Test Pyramid (for testability implications in design): https://martinfowler.com/bliki/TestPyramid.html