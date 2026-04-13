# Testing Standards (Unit, Integration, E2E)

## Overview

This document defines cross-cutting testing standards for the Orchestrace stack:

- **Vitest** for unit/integration tests
- **Playwright / @playwright/test** for end-to-end user journeys

Goal: fast, deterministic feedback with high confidence and low maintenance cost.

---

## Testing Strategy (Pyramid)

Follow a practical pyramid:

1. **Many unit tests** (fast, deterministic, behavior-focused)
2. **Some integration tests** (module + real collaborators or lightweight adapters)
3. **Few E2E tests** (critical user/business journeys only)

High-level UI tests are valuable but slower and more brittle; keep them targeted.

---

## Standards

## 1) Test selection by scope

### ✅ DO

- Use **Vitest unit tests** for pure/domain logic and edge cases.
- Use **Vitest integration tests** for internal module collaboration.
- Use **Playwright** for business-critical paths crossing frontend/backend boundaries.

### ❌ DON'T

- Push all confidence into E2E tests.
- Test trivial getter/setter internals with heavy integration/E2E harnesses.

---

## 2) Determinism first

### ✅ DO

- Control time (`vi.useFakeTimers`, `vi.setSystemTime`) where relevant.
- Stub randomness (`Math.random`, UUID providers) for reproducibility.
- Mock/route external network calls in tests.
- Isolate environment variables per test process.

### ❌ DON'T

- Depend on wall clock timing, real third-party APIs, or global mutable state.

---

## 3) Behavior over implementation details

### ✅ DO

- Assert outcomes visible to users/callers.
- Use meaningful assertions on domain outputs, API responses, and UI behavior.

### ❌ DON'T

- Assert private helper invocation counts unless behavior requires it.
- Snapshot huge outputs as a substitute for precise assertions.

---

## 4) Clean test structure and readability

### ✅ DO

- Use Arrange → Act → Assert.
- Name tests by behavior and expected outcome.
- Use table-driven tests for edge-case matrices.

```ts
it.each([
  ['0', true],
  ['42', true],
  ['-1', false],
])('isPositiveInteger(%s) => %s', (input, expected) => {
  expect(isPositiveInteger(input)).toBe(expected);
});
```

### ❌ DON'T

- Write vague test names like `works` or `handles data`.
- Mix multiple independent behaviors in one large test.

---

## 5) Mocking discipline

### ✅ DO

- Mock only unstable/out-of-process dependencies.
- Prefer integration with in-memory implementations over deep mocks.
- Reset mocks/spies between tests.

```ts
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
```

### ❌ DON'T

- Mock every collaborator by default.
- Keep global mocks active across test files.

---

## 6) Playwright reliability rules

### ✅ DO

- Prefer resilient locators (`getByRole`, `getByLabel`, `getByTestId`) over brittle CSS/XPath.
- Test user-visible outcomes, not implementation details.
- Keep auth setup reusable (fixtures/storage state).
- Capture traces/screenshots/videos on failure in CI.

### ❌ DON'T

- Rely on arbitrary sleeps/timeouts.
- Chain overly long “mega-flow” tests covering many unrelated scenarios.

---

## 7) Coverage policy (quality over vanity)

### ✅ DO

- Use coverage to discover blind spots, not to game percentages.
- Ensure critical paths have explicit tests: error handling, edge cases, retries, fallbacks.

### ❌ DON'T

- Treat line coverage alone as proof of correctness.
- Block pragmatic refactors because of brittle coverage coupling.

---

## 8) CI gates and local workflow

Use repository scripts consistently:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Before merging:

- Lint/typecheck pass
- Relevant Vitest tests pass
- Relevant Playwright tests pass for touched critical paths
- Flakes investigated (not blindly retried until green)

---

## Common Mistakes

- Test pyramid inversion (too many E2E tests, too few unit tests).
- Flaky tests due to real network/time/race assumptions.
- Assertions too weak (`toBeTruthy`) for critical logic.
- Cross-test pollution from shared mutable fixtures.
- Using retries to mask nondeterminism instead of fixing root causes.

---

## PR Checklist (Testing Standards)

- [ ] Are tests added at the right layer (unit/integration/E2E)?
- [ ] Are tests deterministic (time/random/network controlled)?
- [ ] Do assertions verify meaningful behavior?
- [ ] Are mocks minimal and reset properly?
- [ ] Are edge cases and failure paths covered?
- [ ] Are E2E tests scoped to critical journeys only?
- [ ] Do lint/typecheck/test commands pass locally?

---

## References (Web)

- Martin Fowler — Test Pyramid: https://martinfowler.com/bliki/TestPyramid.html
- Martin Fowler/Thoughtworks — Practical Test Pyramid: https://martinfowler.com/articles/practical-test-pyramid.html
- Google Testing Blog — “Just Say No to More End-to-End Tests”: https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html
- Playwright Best Practices: https://playwright.dev/docs/best-practices
- Vitest Guide (Mocking): https://vitest.dev/guide/mocking.html