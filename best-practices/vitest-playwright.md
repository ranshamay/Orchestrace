# Vitest + Playwright Best Practices

## Overview
Use **Vitest** for fast unit/integration coverage of TypeScript logic and **Playwright (`@playwright/test`)** for browser-level UI validation and end-to-end behavior.

In this repo, that split maps to:
- **Vitest**: primary automated test runner across packages (`packages/*/tests/**/*.test.ts`).
- **Playwright**: UI-focused validation, especially when frontend behavior changes and screenshot evidence is expected.

A strong workflow is:
1. Add/update unit tests first (Vitest).
2. Add/update integration tests where boundaries matter (Vitest).
3. Run focused UI scenarios for changed UX paths (Playwright).
4. Keep tests deterministic, isolated, and fast.

---

## DO

### General
- Keep tests **behavior-oriented** (what users/systems observe), not implementation-coupled.
- Make tests deterministic: fixed inputs, explicit setup/teardown, no hidden ordering dependencies.
- Prefer small, targeted tests over broad flaky end-to-end assertions.
- Run the smallest relevant subset locally before full-suite runs.

### Vitest
- Co-locate tests under package test folders that match workspace conventions.
- Use clear test names that encode scenario + expected result.
- Mock only true external boundaries (network, filesystem, time), not internal code structure.
- Cover error paths and edge cases, not only happy paths.
- Use coverage reports as a signal for missing risk areas, not a vanity metric.

### Playwright
- Use robust selectors (`getByRole`, `getByLabel`, `getByTestId`) over brittle CSS/XPath chains.
- Assert visible user outcomes (text, enabled/disabled state, URL, network result), not transient DOM noise.
- Wait on reliable conditions (`expect(...).toBeVisible()`, response waits), not arbitrary sleeps.
- Capture screenshots/traces/videos when debugging flaky UI behavior.
- Keep E2E scenarios focused on critical paths; push lower-level logic back to Vitest.

---

## DON'T

### General
- Don’t write tests that depend on execution order or leaked global state.
- Don’t merge code with only manual verification for behavior that can be automated.
- Don’t overfit assertions to exact wording/markup unless that is the actual contract.

### Vitest
- Don’t over-mock to the point tests no longer validate real behavior.
- Don’t rely on shared mutable fixtures across test files.
- Don’t ignore intermittent failures—fix root causes immediately.

### Playwright
- Don’t use `waitForTimeout` as a primary synchronization strategy.
- Don’t assert everything in one giant test; split by user intent.
- Don’t couple selectors to styling classes likely to change during refactors.
- Don’t treat Playwright as replacement for unit/integration tests.

---

## Configuration

### Vitest baseline in this repo
Current root config (`vitest.config.ts`) uses:
- `globals: true`
- `environment: 'node'`
- `include: ['packages/*/tests/**/*.test.ts']`
- `passWithNoTests: true`
- coverage provider/reports: `v8`, `text|json|html`

Coverage includes source files and excludes test/type barrel noise:
- include: `packages/*/src/**/*.ts`
- exclude: `**/*.test.ts`, `**/*.d.ts`, `**/index.ts`

### Recommended Vitest additions (when needed)
- Add per-package config overrides only for legitimate environment differences.
- Use fake timers explicitly in time-sensitive tests.
- Keep test timeout increases narrow and justified.

### Playwright baseline recommendations
- Separate Playwright config from unit test config.
- Use multiple projects (e.g., Chromium/Firefox/WebKit) only for critical flows; avoid multiplying runtime unnecessarily.
- Enable artifacts on failure (trace/screenshot/video) for debuggability.
- Use stable base URL/environment wiring for CI parity.

---

## Project-specific notes

- Root test script runs through Turbo (`pnpm test` -> `turbo run test`).
- Some packages require build prerequisites before test/typecheck (see `pretest`/`pretypecheck` hooks).
- `@orchestrace/tools` already depends on `@playwright/test` and `playwright`; keep UI test usage scoped to packages that need browser validation.
- Tester policy in this repo treats executed UI commands (`playwright` / `test:ui` patterns) as explicit evidence for UI validation.
- For UI-impacting changes, keep evidence strong:
  - run concrete Playwright commands,
  - record executed commands,
  - provide repository-relative screenshot paths when required.

---

## Examples

### Vitest: targeted package runs
```bash
# Full package tests
pnpm --filter @orchestrace/tools test

# Specific file
pnpm --filter @orchestrace/tools test -- tests/toolset.test.ts

# Specific test name
pnpm --filter @orchestrace/tools test -- tests/toolset.test.ts -t "createAgentToolset phase policy"
```

### Vitest: direct run in filtered context
```bash
pnpm --filter @orchestrace/tools exec vitest run tests/toolset.test.ts
```

### Playwright: focused UI validation
```bash
# Run all Playwright tests
pnpm exec playwright test

# Run smoke subset
pnpm exec playwright test --grep @smoke

# Debug a flaky case
pnpm exec playwright test --headed --trace on
```

### Test design pattern (recommended)
- **Vitest**: validate core orchestration logic, policy checks, and edge-case branching.
- **Playwright**: validate user-visible flows (settings updates, graph interactions, UI state transitions).
- **Both**: when fixing a bug, add the smallest persistent automated test that fails before and passes after the fix.