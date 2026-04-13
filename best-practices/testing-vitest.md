# Testing Best Practices with Vitest

## Overview

Vitest should give **fast, deterministic feedback** about logic and contracts in your codebase. Great Vitest suites are:

- **Reliable** (same result on every machine)
- **Readable** (intent is obvious)
- **Focused** (test behavior, not implementation trivia)
- **Fast** (small setup, isolated scope)

Use Vitest primarily for unit and small integration tests; reserve browser workflows for Playwright.

---

## Key Principles

1. **Test behavior, not private internals**
2. **Keep tests deterministic** (control time, randomness, network, and environment)
3. **Use clear Arrange → Act → Assert structure**
4. **Isolate each test** (no hidden shared mutable state)
5. **Prefer realistic assertions** over brittle snapshots
6. **Fail loudly and specifically** (assert exact outcomes)

---

## Best Practices

### 1) Deterministic time handling

#### ✅ DO

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { isExpired } from './token';

afterEach(() => vi.useRealTimers());

describe('isExpired', () => {
  it('returns true after expiry time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    expect(isExpired('2025-12-31T23:59:59Z')).toBe(true);
  });
});
```

#### ❌ DON'T

```ts
it('sometimes passes depending on clock', () => {
  // Uses real clock; can fail near boundary times
  expect(isExpired('2025-12-31T23:59:59Z')).toBe(true);
});
```

---

### 2) Clear AAA structure

#### ✅ DO

```ts
it('calculates discount for premium users', () => {
  // Arrange
  const user = { tier: 'premium' as const };

  // Act
  const total = calculateTotal(100, user);

  // Assert
  expect(total).toBe(80);
});
```

#### ❌ DON'T

```ts
it('does things', () => {
  const total = calculateTotal(100, { tier: 'premium' as const });
  expect(total).toBe(80); // no context, unclear intent
});
```

---

### 3) Assert meaningful outcomes

#### ✅ DO

```ts
it('returns normalized email', () => {
  expect(normalizeEmail('  A.User@Example.COM  ')).toBe('a.user@example.com');
});
```

#### ❌ DON'T

```ts
it('returns a string', () => {
  expect(typeof normalizeEmail('x')).toBe('string'); // too weak
});
```

---

### 4) Table-driven tests for edge coverage

#### ✅ DO

```ts
it.each([
  ['0', true],
  ['42', true],
  ['-1', false],
  ['abc', false],
  ['', false],
])('isPositiveInteger(%s) -> %s', (input, expected) => {
  expect(isPositiveInteger(input)).toBe(expected);
});
```

#### ❌ DON'T

```ts
it('checks many values manually', () => {
  expect(isPositiveInteger('0')).toBe(true);
  expect(isPositiveInteger('42')).toBe(true);
  expect(isPositiveInteger('-1')).toBe(false);
  // Easy to miss cases and hard to scan
});
```

---

### 5) Restore mocks and spies

#### ✅ DO

```ts
import { afterEach, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
});

it('logs warning when quota exceeded', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  checkQuota(101);

  expect(warn).toHaveBeenCalledWith('quota exceeded');
});
```

#### ❌ DON'T

```ts
it('pollutes global console for later tests', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  checkQuota(101);
  // forgot restore; later tests may fail unexpectedly
});
```

---

### 6) Partial mocking with original behavior preserved

#### ✅ DO

```ts
vi.mock('./env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./env')>();
  return {
    ...actual,
    getEnv: vi.fn(() => ({ NODE_ENV: 'test', FEATURE_FLAG_X: 'on' })),
  };
});
```

#### ❌ DON'T

```ts
vi.mock('./env', () => ({
  // Replacing entire module often breaks unrelated exports
  getEnv: () => ({ NODE_ENV: 'test' }),
}));
```

---

### 7) Verify failures explicitly

#### ✅ DO

```ts
it('throws for invalid schema', async () => {
  await expect(parseConfig('{ invalid json }')).rejects.toThrow('Invalid configuration');
});
```

#### ❌ DON'T

```ts
it('fails somehow', async () => {
  try {
    await parseConfig('{ invalid json }');
  } catch {
    expect(true).toBe(true); // false-positive pattern
  }
});
```

---

### 8) Avoid implementation-detail assertions

#### ✅ DO

```ts
it('sends a welcome email for newly created users', async () => {
  await registerUser({ email: 'new@site.dev' });
  expect(emailGateway.send).toHaveBeenCalledWith(
    expect.objectContaining({ template: 'welcome' }),
  );
});
```

#### ❌ DON'T

```ts
it('calls private helper twice', async () => {
  await registerUser({ email: 'new@site.dev' });
  expect(internalBuildPayload).toHaveBeenCalledTimes(2); // brittle
});
```

---

### 9) Build fresh fixtures per test

#### ✅ DO

```ts
const makeUser = (overrides: Partial<User> = {}): User => ({
  id: crypto.randomUUID(),
  role: 'viewer',
  enabled: true,
  ...overrides,
});

it('disables viewer access', () => {
  const user = makeUser({ enabled: false });
  expect(canAccessDashboard(user)).toBe(false);
});
```

#### ❌ DON'T

```ts
const sharedUser = { id: '1', role: 'viewer', enabled: true };

it('mutates shared fixture', () => {
  sharedUser.enabled = false;
  expect(canAccessDashboard(sharedUser)).toBe(false);
});
```

---

### 10) Prefer focused integration over deep mocks

#### ✅ DO

```ts
it('stores and retrieves profile in repository', async () => {
  const repo = createInMemoryProfileRepository();
  await repo.save({ id: 'u1', name: 'Ana' });

  await expect(repo.get('u1')).resolves.toEqual({ id: 'u1', name: 'Ana' });
});
```

#### ❌ DON'T

```ts
it('mocks every repository method', async () => {
  const repo = {
    save: vi.fn(),
    get: vi.fn().mockResolvedValue({ id: 'u1', name: 'Ana' }),
  };
  // Tests mock wiring, not repository behavior
});
```

---

## Common Mistakes

- Using real timers and wall-clock assumptions
- Forgetting `vi.restoreAllMocks()` / `vi.useRealTimers()` cleanup
- Testing implementation internals instead of observable behavior
- Writing broad snapshots that hide intent
- Over-mocking dependencies until tests no longer represent real code paths
- Reusing mutable fixtures across tests
- Weak assertions (`toBeTruthy`, type checks only) where exact output is expected

---

## Checklist

- [ ] Test names describe behavior and expected outcome
- [ ] Each test is deterministic (time/random/network controlled)
- [ ] Arrange/Act/Assert sections are clear
- [ ] Assertions are specific and meaningful
- [ ] Mocks/spies/timers are reset after each test
- [ ] Happy path + edge cases + failure paths are covered
- [ ] Shared state between tests is eliminated
- [ ] Runtime stays fast enough for frequent local execution