# Playwright Best Practices

## Overview

Playwright is used for end-to-end browser validation. Prioritize reliability and accessibility-based selectors.

## Best Practices

### Use resilient locators

```ts
await page.getByRole('button', { name: 'Run task' }).click();
await expect(page.getByText('Running')).toBeVisible();
```

Prefer `getByRole`, `getByLabel`, `getByTestId` over brittle CSS selectors.

### Avoid hard waits

Use Playwright’s auto-waiting assertions.

```ts
await expect(page.getByRole('status')).toHaveText(/completed/i);
```

### Isolate auth/session state

Use `storageState` for authenticated test projects when appropriate.

### Keep tests independent

Each test should create/cleanup its own data; no order dependency.

### Capture diagnostics

Enable traces/screenshots/video on failure in CI.

## Do and Don’t

### Do

- Use page objects for complex flows.
- Keep network mocking explicit when external dependencies are unstable.

### Don’t

- Depend on test execution order.
- Assert transient text without wait conditions.
- Use `waitForTimeout` as a primary sync mechanism.

## Common Pitfalls

- Flaky tests from race conditions.
- Non-deterministic test data collisions in parallel runs.
- Overly broad selectors matching multiple elements.