# Testing Standards Best Practices

## Overview
This guide defines cross-cutting testing standards for the repo, independent of specific frameworks.

Framework-specific guidance (Vitest/Playwright) remains in `vitest-playwright.md`; this document defines **how we design, structure, and review tests**.

Primary goals:
- **Fast feedback** for developers
- **Reliable signal** in CI (low flakiness)
- **Risk-focused coverage** (critical behavior protected)
- **Maintainable tests** that evolve with the product

---

## DO

### 0) Treat testing as a release gate (strict mode)
- No merge on failing tests in affected packages.
- For bug fixes, add a regression test in the same PR.
- For critical flows, require at least one integration/e2e assertion path.
- Flaky test tolerance is **zero**: triage immediately, quarantine only with owner + due date.


### 1) Follow a testing pyramid strategy
- Many unit tests for pure logic.
- Targeted integration tests for boundaries/contracts.
- Few high-value end-to-end tests for critical user journeys.

### 2) Test behavior, not implementation details
- Assert outcomes users/systems care about.
- Avoid asserting private internals unless they are contractually exposed.

### 3) Use clear test structure
- Arrange / Act / Assert (AAA).
- One primary behavior per test.
- Name tests with scenario + expectation.

```ts
it('returns fallback status when upstream status is unknown', () => {
  // Arrange
  const raw = { id: 'a1', status: 'mystery' };

  // Act
  const summary = toSummary(raw);

  // Assert
  expect(summary.status).toBe('idle');
});
```

### 4) Keep tests deterministic
- Control time/randomness/network/filesystem through mocks/stubs/fixtures.
- Remove order dependencies; tests must pass independently.
- Prefer explicit setup/teardown over shared mutable global state.

### 5) Cover happy path + failure path + edge cases
- Success behavior
- Invalid inputs / missing dependencies
- Boundary conditions (empty arrays, nulls, large values, retries/timeouts)

### 6) Keep fixtures small and realistic
- Use minimal data needed to exercise behavior.
- Reuse canonical fixture builders for complex domain objects.

### 7) Treat flaky tests as production incidents
- Investigate root cause immediately.
- Quarantine only as temporary mitigation with owner and follow-up ticket.

### 8) Use coverage as a heuristic, not a goal by itself
- High coverage with weak assertions is not quality.
- Prioritize coverage of critical workflows and regression-prone paths.

---

## DON'T

- Don’t write giant end-to-end tests for everything.
- Don’t assert every field if only a subset forms the behavior contract.
- Don’t use fixed sleeps/timeouts as synchronization strategy in UI tests.
- Don’t share mutable fixtures across tests.
- Don’t ignore intermittent failures in CI.
- Don’t couple tests tightly to refactor-prone markup/styling details.

```ts
// Avoid: weak assertion (test passes without validating behavior)
it('works', async () => {
  const result = await runThing();
  expect(result).toBeTruthy();
});
```

---

## Configuration

### Execution standards
- Local dev: run focused tests for changed area first.
- Before merge: run affected package tests + critical cross-package checks.
- CI: lint + typecheck + tests are mandatory required gates.
- PRs should include test evidence summary (what levels were run and why).

Minimum expectations by change type:
- **Pure logic change**: unit tests updated/added.
- **Boundary/integration change** (API, DB, file, env): integration test updated/added.
- **User-flow/UI change**: at least one high-value e2e or component-level behavior test.


### Suggested command discipline
```bash
# all tests in monorepo
pnpm test

# focused package test loop
pnpm --filter <package-name> test

# file/name targeting where supported
pnpm --filter <package-name> test -- <path-or-pattern>
```

### Flake prevention defaults
- Keep per-test timeout realistic and minimal.
- Prefer explicit waits on conditions/events in UI tests.
- Record traces/artifacts for failed browser tests.

---

## Project-specific notes

- This repo uses **Vitest** broadly and **Playwright** for browser-level scenarios.
- Follow `vitest-playwright.md` for framework mechanics; use this guide for test design/review standards.
- When fixing a bug, add a regression test that fails pre-fix and passes post-fix.
- For user-facing changes, include at least one test/evidence artifact validating the intended behavior.

---

## Review checklist (for PRs)

- [ ] Does each new behavior have automated test coverage at the right level?
- [ ] Are tests deterministic and independent?
- [ ] Are failure/error paths covered?
- [ ] Are assertions meaningful (not just truthy/existence)?
- [ ] Are test names descriptive and behavior-focused?
- [ ] Are flaky patterns (sleeps, brittle selectors, hidden state) avoided?
- [ ] Is bugfix work paired with a regression test?
- [ ] Did the author run lint + typecheck + test for affected scope?
- [ ] If UI/flow changed, is there at least one behavior-level test proving outcome?
- [ ] If a test is quarantined, is there an owner + due date + ticket reference?