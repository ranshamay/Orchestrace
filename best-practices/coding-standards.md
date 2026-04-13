# Coding Standards (Modular, Maintainable, Testable Code)

## Overview

This document defines **cross-stack coding standards** for this repo (TypeScript/React/Node monorepo) with a strong focus on:

- modular design
- testability by default
- maintainability at scale
- predictable behavior in CI/production

It complements technology-specific guides in this folder.

---

## Source-backed Principles (Web-aligned)

1. **Separate config from code** (Twelve-Factor).
2. **Prefer small modules with explicit contracts** (low coupling, high cohesion).
3. **Push side effects to boundaries**; keep core logic mostly pure.
4. **Use named exports and clear module APIs** (better refactors and tooling).
5. **Design code to be easy to test** (dependency injection, deterministic inputs).
6. **Optimize for readability and changeability** over cleverness.

---

## 1) Module boundaries and architecture

### ✅ DO

- Organize by feature/domain first, then technical layers inside feature.
- Keep core business rules independent of UI/framework/IO.
- Make dependencies flow inward (domain should not depend on adapters).

```ts
// domain/budget.ts
export interface TokenCounter {
  count(text: string): number;
}

export function canFitPrompt(text: string, max: number, counter: TokenCounter) {
  return counter.count(text) <= max;
}
```

### ❌ DON'T

- Mix orchestration, transport, and domain rules in one module.
- Call SDKs directly from domain logic.

```ts
// DON'T: hard-coupled to specific provider
import { encodingForModel } from 'js-tiktoken';

export function canFitPrompt(text: string, max: number) {
  const enc = encodingForModel('gpt-4o-mini');
  return enc.encode(text).length <= max;
}
```

---

## 2) Dependency injection and deterministic behavior

### ✅ DO

- Inject time, randomness, env access, network clients, and filesystem adapters.
- Create a composition root (wire concrete deps at startup).

```ts
export interface Clock { nowMs(): number }

export function isExpired(expiresAtMs: number, clock: Clock) {
  return expiresAtMs <= clock.nowMs();
}
```

### ❌ DON'T

```ts
// DON'T: hidden global dependency
export const isExpired = (expiresAtMs: number) => expiresAtMs <= Date.now();
```

---

## 3) TypeScript standards for clarity and safety

### ✅ DO

- Use strict typing (`strict: true`) and avoid `any` in core paths.
- Model failures with discriminated unions.
- Use `unknown` at boundaries + runtime validation.
- Prefer named exports.

```ts
type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'invalid'; message: string };
```

### ❌ DON'T

- Return ambiguous values like `null | false | undefined` for errors.
- Overuse type assertions (`as X`) instead of fixing types.

---

## 4) Function and class design

### ✅ DO

- Keep functions small and focused.
- Prefer pure functions for transformation logic.
- Limit function arguments (group related inputs into typed objects).
- Keep classes for stateful behavior that must persist across calls.

### ❌ DON'T

- Create “god objects” or giant utility files.
- Use static container classes just for namespacing.

---

## 5) Error handling and observability

### ✅ DO

- Fail fast on invalid state.
- Wrap low-level errors with operation context.
- Use structured logs; redact secrets.

```ts
throw new Error(`token_budget_exceeded: max=${max} actual=${actual}`);
```

### ❌ DON'T

- Swallow errors (`catch {}`) without action.
- Leak API keys/tokens in logs or error messages.

---

## 6) Configuration and secrets

### ✅ DO

- Read config from environment via a single config module.
- Validate required env vars at startup.
- Keep `.env` for local development only; never commit secrets.

### ❌ DON'T

- Scatter `process.env.*` throughout business logic.
- Hardcode deployment-specific values in source.

---

## 7) React-specific coding standards

### ✅ DO

- Keep components focused and composable.
- Move side effects to hooks/route loaders.
- Prefer controlled data flow and explicit props.
- Co-locate component + test + styles per feature.

### ❌ DON'T

- Trigger network requests in render body.
- Store duplicated derived state.

---

## 8) Monorepo standards (pnpm + Turborepo)

### ✅ DO

- Define intentional package public APIs.
- Prefer internal imports through package entrypoints.
- Keep dependency graph acyclic.

### ❌ DON'T

- Deep import private internals from sibling packages.
- Copy/paste shared logic across apps/packages.

---

## 9) Naming and readability

### ✅ DO

- Use domain language in names (`TokenBudget`, `SessionState`).
- Use verb-based function names (`parseConfig`, `validateInput`).
- Keep boolean names readable (`isEnabled`, `hasAccess`).

### ❌ DON'T

- Use abbreviations that hide intent.
- Use vague names like `data`, `handleStuff`, `utils2`.

---

## 10) Security-aware coding

### ✅ DO

- Validate all untrusted input.
- Encode/escape output where needed.
- Keep markdown/rendering pipelines safe by default.

### ❌ DON'T

- Trust client-provided values for authorization logic.
- Concatenate shell commands with unsanitized input.

---

## Common anti-patterns

- Massive files with mixed concerns (IO + domain + formatting + CLI).
- Hidden shared mutable state.
- Premature abstraction without proven reuse.
- Over-mocking production code because boundaries are unclear.

---

## PR Checklist (Coding Standards)

- [ ] Is the module responsibility clear and singular?
- [ ] Are boundaries explicit (domain vs adapter vs UI)?
- [ ] Are side effects isolated and injectable?
- [ ] Are types explicit and error states modeled safely?
- [ ] Are secrets/config handled through central config module?
- [ ] Is the code easy to unit test without real network/time/fs?
- [ ] Are package boundaries respected (no private deep imports)?
- [ ] Are names clear and domain-oriented?

---

## References (Web)

- Twelve-Factor App — Config: https://12factor.net/config
- Twelve-Factor App — Codebase: https://12factor.net/codebase
- Google TypeScript Style Guide: https://google.github.io/styleguide/tsguide.html
- ESLint Core Concepts: https://eslint.org/docs/latest/use/core-concepts
- TypeScript Handbook: https://www.typescriptlang.org/docs/handbook/intro.html
- Martin Fowler — Test Pyramid (design-for-testability implication): https://martinfowler.com/bliki/TestPyramid.html