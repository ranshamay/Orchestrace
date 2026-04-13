# Playwright Best Practices (Monorepo)

Use this guide for stable end-to-end and browser integration testing across workspace apps.

## 1) Goals and Scope

- Validate critical user journeys in real browsers.
- Keep tests independent, parallel-safe, and environment-aware.
- Minimize flake by using resilient selectors and explicit waits on conditions.

---

## 2) Recommended Monorepo Layout

```text
apps/
  web/
    playwright.config.ts
    tests/
      auth.spec.ts
      checkout.spec.ts
    tests/fixtures/
      auth.fixture.ts
    tests/pages/
      LoginPage.ts
packages/
  test-utils/
    playwright/
      data/
      helpers/
```

### Conventions

- Keep E2E tests close to each app that owns the UI.
- Share cross-app helpers in a common test-utils package.
- Avoid one giant global fixture file; compose small fixtures.

---

## 3) Base Config Pattern

Use a predictable baseline and override by environment.

```ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
```

---

## 4) Fixture Design

Create typed fixtures for reusable authenticated states and data setup.

```ts
import { test as base } from '@playwright/test'

type Fixtures = {
  authToken: string
}

export const test = base.extend<Fixtures>({
  authToken: async ({ request }, use) => {
    const resp = await request.post('/api/test/login', { data: { user: 'e2e' } })
    const { token } = await resp.json()
    await use(token)
  },
})

export { expect } from '@playwright/test'
```

### Do

- Keep fixtures cheap and scoped.
- Prefer API setup over UI setup for preconditions.
- Cleanup created entities when isolation requires it.

### Don’t

- Chain long UI flows in every test to create data.
- Hide expensive setup in auto fixtures without need.

---

## 5) Locator and Assertion Strategy

Prefer user-facing semantics.

### Priority order

1. `getByRole`
2. `getByLabel` / `getByPlaceholder`
3. `getByText` (carefully)
4. `getByTestId` for non-semantic or ambiguous elements

```ts
await page.getByRole('button', { name: 'Sign in' }).click()
await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
```

### Avoid

- Brittle CSS/XPath selectors tied to layout details.
- Manual `waitForTimeout` except temporary debugging.

---

## 6) Network and External Dependencies

- Stub third-party calls with `page.route` where needed.
- Keep at least one smoke path against real integrations in a dedicated environment.
- Fail fast on unexpected network errors.

```ts
await page.route('**/analytics/**', route => route.fulfill({ status: 204, body: '' }))
```

---

## 7) CI Reliability and Anti-Flake

### Core controls

- Use deterministic test data (unique IDs per test).
- Isolate account/state per worker when tests mutate shared resources.
- Enable trace/screenshot/video on failure for triage.
- Keep retries low; treat retry pass as flaky signal requiring follow-up.

### Practical anti-flake checklist

- No fixed sleeps.
- No cross-test dependency.
- Explicitly await navigation/requests tied to user actions.
- Avoid race-prone assertions immediately after click without condition wait.

---

## 8) Parallelism and Sharding (Monorepo CI)

- Split E2E by app/package and browser project.
- Use CI matrix for shard-based execution on large suites.
- Keep each shard runtime balanced; periodically rebalance heavy specs.

Pattern:

- `test:e2e:smoke` on every PR.
- `test:e2e:full` on merge/main schedule.

---

## 9) Do / Don’t Examples

### ✅ Do: condition-based waiting

```ts
await Promise.all([
  page.waitForURL('**/dashboard'),
  page.getByRole('button', { name: 'Sign in' }).click(),
])
```

### ❌ Don’t: sleep-based waiting

```ts
await page.getByRole('button', { name: 'Sign in' }).click()
await page.waitForTimeout(3000)
```

### ✅ Do: assert user-visible outcomes

```ts
await expect(page.getByText('Payment successful')).toBeVisible()
```

### ❌ Don’t: assert internal implementation artifacts only

```ts
await expect(page.locator('.step-4 > .done')).toBeVisible()
```

---

## 10) Debugging and Failure Triage

- Use trace viewer first (`trace.zip`) for timing/action context.
- Keep screenshots/video as supporting evidence.
- Attach request/response logs for API-heavy failures.
- Quarantine known flakes only with issue link + expiry date.

---

## 11) Review Heuristics

A strong Playwright suite is:

- Intentional: only high-value user journeys.
- Stable: minimal intermittent failures.
- Fast enough: feedback in PR workflows.
- Diagnosable: failures produce actionable artifacts.