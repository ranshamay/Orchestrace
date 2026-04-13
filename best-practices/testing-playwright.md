# Testing Best Practices with Playwright

## Overview

Playwright tests should validate **real user workflows** in a browser with production-like behavior. Strong Playwright suites are:

- **User-centric** (assert what users see and can do)
- **Stable** (avoid race conditions and brittle selectors)
- **Isolated** (tests do not leak state into each other)
- **Debuggable** (trace/video/screenshot data available on failures)

Use Playwright for end-to-end and cross-page integration behavior that unit tests cannot prove.

---

## Key Principles

1. **Use semantic locators** (`getByRole`, `getByLabel`, `getByText`) first
2. **Rely on web-first assertions** and auto-waiting instead of sleeps
3. **Keep each test independent** (fresh context + deterministic data)
4. **Mock or control unstable external dependencies** when appropriate
5. **Capture diagnostics on failure** (trace, screenshots, video)
6. **Design tests around business-critical user journeys**

---

## DO / DON'T Code Samples

### 1) Prefer semantic locators over CSS implementation details

#### ✅ DO

```ts
await page.getByRole('button', { name: 'Create project' }).click();
await expect(page.getByRole('heading', { name: 'New Project' })).toBeVisible();
```

#### ❌ DON'T

```ts
await page.locator('div.modal > div:nth-child(2) > button.primary').click();
await expect(page.locator('.title')).toHaveText('New Project');
```

---

### 2) Wait for app state, not fixed time

#### ✅ DO

```ts
await page.getByRole('button', { name: 'Save' }).click();
await expect(page.getByText('Saved successfully')).toBeVisible();
```

#### ❌ DON'T

```ts
await page.getByRole('button', { name: 'Save' }).click();
await page.waitForTimeout(2000); // flaky and slow
```

---

### 3) Use web-first assertions

#### ✅ DO

```ts
await expect(page.getByRole('status')).toHaveText('Connected');
```

#### ❌ DON'T

```ts
const status = await page.locator('[role="status"]').textContent();
expect(status).toBe('Connected'); // misses auto-waiting benefits
```

---

### 4) Control network nondeterminism

#### ✅ DO

```ts
await page.route('**/api/billing/quote', async (route) => {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ subtotal: 100, total: 108 }),
  });
});

await page.goto('/checkout');
await expect(page.getByText('$108.00')).toBeVisible();
```

#### ❌ DON'T

```ts
await page.goto('/checkout');
// Hits unstable external service; intermittent failures likely
await expect(page.getByText('$108.00')).toBeVisible();
```

---

### 5) Reuse authenticated state safely

#### ✅ DO

```ts
import { test as setup } from '@playwright/test';

setup('authenticate', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('qa@example.com');
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.context().storageState({ path: 'playwright/.auth/user.json' });
});
```

#### ❌ DON'T

```ts
test.beforeEach(async ({ page }) => {
  // Full UI login before every test = slow and fragile
  await page.goto('/login');
  // ... repeated steps
});
```

---

### 6) Keep test data isolated

#### ✅ DO

```ts
test('creates a project with unique name', async ({ page }) => {
  const name = `project-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await page.goto('/projects/new');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
});
```

#### ❌ DON'T

```ts
test('creates project', async ({ page }) => {
  await page.goto('/projects/new');
  await page.getByLabel('Project name').fill('My Test Project');
  // collisions across parallel runs
});
```

---

### 7) Encapsulate repeated interactions with helper objects

#### ✅ DO

```ts
class LoginPage {
  constructor(private page: Page) {}

  async signIn(email: string, password: string) {
    await this.page.goto('/login');
    await this.page.getByLabel('Email').fill(email);
    await this.page.getByLabel('Password').fill(password);
    await this.page.getByRole('button', { name: 'Sign in' }).click();
  }
}
```

#### ❌ DON'T

```ts
// Duplicated login flow in many tests; harder to maintain consistently
await page.goto('/login');
await page.getByLabel('Email').fill('qa@example.com');
await page.getByLabel('Password').fill('secret');
await page.getByRole('button', { name: 'Sign in' }).click();
```

---

### 8) Assert visible behavior instead of internal JS state

#### ✅ DO

```ts
await page.getByRole('button', { name: 'Enable dark mode' }).click();
await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
await expect(page.getByRole('banner')).toBeVisible();
```

#### ❌ DON'T

```ts
const theme = await page.evaluate(() => (window as any).__store.theme);
expect(theme).toBe('dark'); // implementation detail
```

---

### 9) Configure retries and tracing for debuggability

#### ✅ DO

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  retries: 1,
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
```

#### ❌ DON'T

```ts
export default defineConfig({
  retries: 0,
  use: { trace: 'off', screenshot: 'off', video: 'off' },
  // Failures become hard to investigate
});
```

---

### 10) Keep tests independent and order-agnostic

#### ✅ DO

```ts
test('archives a project', async ({ page, request }) => {
  const project = await request.post('/api/test/projects', { data: { name: 'archive-me' } });
  const { id } = await project.json();

  await page.goto(`/projects/${id}`);
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByText('Project archived')).toBeVisible();
});
```

#### ❌ DON'T

```ts
test('archives a project', async ({ page }) => {
  // Assumes project created by previous test
  await page.goto('/projects/known-id');
});
```

---

## Common Mistakes

- Using brittle selectors tied to DOM structure
- Calling `waitForTimeout` for synchronization
- Sharing state between tests (data, accounts, browser context)
- Running full UI login on every test instead of using `storageState`
- Asserting internal store values through `page.evaluate`
- Not capturing trace/screenshot/video on failures
- Covering low-value UI details while missing critical user journeys

---

## Checklist

- [ ] Selectors are semantic and user-facing
- [ ] No fixed sleeps (`waitForTimeout`) for core synchronization
- [ ] Assertions use Playwright expect auto-waiting
- [ ] External dependency instability is controlled (route mocks or test env)
- [ ] Tests are independent and parallel-safe
- [ ] Auth setup uses reusable, secure strategy (`storageState`, fixtures)
- [ ] Failure artifacts (trace/screenshot/video) are enabled
- [ ] Suite focuses on high-value user flows and regression risks