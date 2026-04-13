# Testing Standards (Unit, Integration, E2E)

## Overview

This document defines **testing standards** for this repo’s stack:

- **Vitest** for unit and integration tests
- **Playwright / @playwright/test** for end-to-end tests

Primary goals:

1. fast feedback
2. deterministic tests
3. high confidence with low flake rate
4. maintainable test suite over time

---

## Source-backed strategy

Use a practical **test pyramid**:

- many unit tests
- some integration tests
- few E2E tests on critical journeys

This aligns with Martin Fowler and Google testing guidance: broad UI/E2E tests are useful but expensive and brittle if overused.

---

## 1) Choosing the right test layer

### Decision guide

- **Unit (Vitest):** pure logic, transformations, branching, error mapping.
- **Integration (Vitest):** module collaboration, adapters with local test doubles/in-memory infra.
- **E2E (Playwright):** cross-boundary business-critical journeys.

### ✅ DO

- Test behavior at the lowest layer that gives confidence.

### ❌ DON'T

- Use E2E for scenarios already proven at unit/integration layers.

---

## 2) Determinism rules (non-negotiable)

### ✅ DO

- Control time (`vi.useFakeTimers`, `vi.setSystemTime`).
- Stub randomness/IDs when asserting exact outputs.
- Mock or route external network calls.
- Isolate env vars and global state per test.

```ts
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
```

### ❌ DON'T

- Depend on real wall-clock waits, third-party APIs, or shared mutable globals.

---

## 3) Assertions: behavior over implementation

### ✅ DO

- Assert externally visible behavior and outcomes.
- Use precise assertions (`toEqual`, `toMatchObject`, domain-specific checks).

### ❌ DON'T

- Over-assert internals (private function call counts) when output is sufficient.
- Overuse broad assertions like `toBeTruthy()` for critical logic.

---

## 4) Unit testing standards (Vitest)

### ✅ DO

- Keep tests small, focused, and table-driven for edge matrices.
- Prefer real logic + fake boundaries over deep mocking everything.

```ts
it.each([
  ['0', true],
  ['10', true],
  ['-1', false],
  ['abc', false],
])('isPositiveInteger(%s)', (input, expected) => {
  expect(isPositiveInteger(input)).toBe(expected);
});
```

### ❌ DON'T

- Put multiple unrelated behaviors in one test.
- Snapshot giant payloads as a substitute for meaningful assertions.

---

## 5) Integration testing standards

### ✅ DO

- Test module boundaries with realistic collaborators.
- Use in-memory adapters when possible.
- Cover failure paths (timeouts, invalid payloads, retries).

### ❌ DON'T

- Rebuild full E2E setup for integration tests.
- Depend on shared test data that can be mutated by other tests.

---

## 6) E2E testing standards (Playwright)

### ✅ DO

- Prefer resilient locators: `getByRole`, `getByLabel`, `getByTestId`.
- Keep tests short and scenario-focused.
- Use reusable auth state/fixtures.
- Capture traces/screenshots/videos on failure in CI.

```ts
await page.getByRole('button', { name: 'Sign in' }).click();
await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
```

### ❌ DON'T

- Use arbitrary `waitForTimeout` sleeps.
- Build giant “mega tests” that verify too many concerns at once.

---

## 7) Flake prevention and management

### ✅ DO

- Treat flaky tests as defects.
- Quarantine + root-cause + fix quickly.
- Track flake rate trend in CI.

### ❌ DON'T

- Hide instability with excessive retries.
- Normalize random failures as acceptable.

---

## 8) Test data and fixtures

### ✅ DO

- Create explicit test data builders/factories.
- Keep fixtures minimal and scenario-specific.
- Reset state between tests.

### ❌ DON'T

- Share mutable fixtures across suites.
- Depend on execution order.

---

## 9) CI quality gates

Before merge, require:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

And additionally:

- relevant Playwright suites for touched critical flows
- no unresolved flaky failures
- traces attached for E2E failures

---

## 10) Coverage policy

### ✅ DO

- Use coverage to identify blind spots.
- Ensure critical risk paths are tested: validation, authz/authn checks, retries/fallbacks, error mapping.

### ❌ DON'T

- Treat coverage percentage alone as quality proof.

---

## Common anti-patterns

- Test pyramid inversion (too much E2E).
- Assertions that are too weak to catch regressions.
- Mock-heavy tests coupled to internals.
- State leakage between tests.

---

## PR Checklist (Testing Standards)

- [ ] Are tests added at the correct layer (unit/integration/E2E)?
- [ ] Are tests deterministic (time/random/network controlled)?
- [ ] Do assertions verify user-visible or contract-visible behavior?
- [ ] Are failure/edge cases covered?
- [ ] Are mocks minimal, reset, and justified?
- [ ] Are E2E tests scoped to critical journeys only?
- [ ] Do lint/typecheck/test commands pass locally?

---

## References (Web)

- Martin Fowler — Test Pyramid: https://martinfowler.com/bliki/TestPyramid.html
- Martin Fowler — The Practical Test Pyramid: https://martinfowler.com/articles/practical-test-pyramid.html
- Google Testing Blog — Just Say No to More End-to-End Tests: https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html
- Playwright Best Practices: https://playwright.dev/docs/best-practices
- Vitest Mocking Guide: https://vitest.dev/guide/mocking.html
- Testing Library Guiding Principles: https://testing-library.com/docs/guiding-principles/