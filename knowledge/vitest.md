# Vitest Best Practices (Monorepo)

Use this guide for reliable, fast, and maintainable unit/integration tests across a pnpm/turborepo workspace.

## 1) Goals and Scope

- Keep tests deterministic and side-effect isolated.
- Run package-local tests quickly in watch mode.
- Support workspace-wide CI with stable sharding/caching.
- Prefer behavior-focused tests over implementation snapshots.

---

## 2) Recommended Monorepo Structure

Use local test files near source, and shared helpers in a dedicated test utilities package or folder.

```text
packages/
  app-web/
    src/
      components/
        Button.tsx
        Button.test.tsx
    vitest.config.ts
  core-utils/
    src/
      math.ts
      math.test.ts
    vitest.config.ts
  test-utils/
    src/
      fixtures/
      setup/
      factories/
```

### Conventions

- `*.test.ts` / `*.test.tsx` for unit/integration tests.
- `*.spec.ts` is acceptable if already standardized; avoid mixing styles randomly.
- Keep package-level `vitest.config.ts` minimal; share common defaults via a base config module.

---

## 3) Configuration Pattern

### Shared base config

Create a reusable base (e.g., `packages/test-utils/src/vitest.base.ts`):

```ts
import { defineConfig } from 'vitest/config'

export const baseVitestConfig = defineConfig({
  test: {
    globals: false,
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    passWithNoTests: true,
    setupFiles: [],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['**/*.d.ts', '**/dist/**', '**/generated/**'],
    },
  },
})
```

### Package-level extension

```ts
import { mergeConfig } from 'vitest/config'
import { baseVitestConfig } from '@repo/test-utils/vitest-base'

export default mergeConfig(baseVitestConfig, {
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
})
```

---

## 4) Fixtures and Test Data

Use factory helpers to avoid brittle inline objects.

```ts
// test/factories/user.ts
export function makeUser(overrides: Partial<{ id: string; role: 'admin' | 'user' }> = {}) {
  return {
    id: 'user-1',
    role: 'user' as const,
    ...overrides,
  }
}
```

### Do

- Build minimal valid objects, then override per test.
- Keep factories pure and deterministic.
- Version fixtures when contracts change.

### Don’t

- Share mutable fixture objects across tests.
- Load large JSON blobs when small builders suffice.

---

## 5) Mocking Strategy

Prefer dependency injection and thin mocks.

### Module mock example

```ts
import { describe, it, expect, vi } from 'vitest'
import { loadProfile } from './service'
import * as api from './api'

vi.mock('./api', () => ({
  fetchProfile: vi.fn(),
}))

describe('loadProfile', () => {
  it('returns mapped profile', async () => {
    vi.mocked(api.fetchProfile).mockResolvedValue({ id: '1', name: 'A' })

    await expect(loadProfile('1')).resolves.toEqual({ id: '1', displayName: 'A' })
  })
})
```

### Mocking rules

- Mock only true external boundaries (network, time, random, filesystem when possible).
- Use `vi.useFakeTimers()` only when needed; always restore timers.
- Reset/restore mocks between tests with config + explicit cleanup where needed.

---

## 6) Async and Timing Reliability

### Do

- Assert on outcomes, not delays.
- Use `await` for all async expectations.
- Control time with fake timers for timeout/retry logic.

### Don’t

- Use arbitrary sleeps (`setTimeout(100)`) in tests.
- Leave unresolved promises running beyond test completion.

---

## 7) CI Reliability in Monorepos

- Run tests per package with workspace filters to reduce blast radius.
- Enable cacheable tasks (e.g., Turborepo test pipeline).
- Separate fast unit tests from slower integration tests using naming/globs.
- Configure retries sparingly; fix flaky root causes first.

Example task split:

- `test:unit` → deterministic, no network.
- `test:integration` → controlled IO, isolated env.
- `test:ci` → aggregate command for CI.

---

## 8) Anti-Flake Checklist

- No test order dependence.
- No shared mutable global state.
- No real network calls in unit tests.
- Deterministic random seeds when randomness is required.
- Stable timezone/locale assumptions (set explicitly in setup when relevant).

---

## 9) Do / Don’t Examples

### ✅ Do: behavior-focused assertions

```ts
expect(result).toEqual({ status: 'ok' })
```

### ❌ Don’t: over-couple to internal calls

```ts
expect(internalHelper).toHaveBeenCalledTimes(7)
```

(Only assert internal interactions when they are the actual contract.)

### ✅ Do: isolate global state

```ts
const OLD_ENV = process.env
beforeEach(() => {
  process.env = { ...OLD_ENV }
})
afterEach(() => {
  process.env = OLD_ENV
})
```

### ❌ Don’t: mutate process globals without cleanup

```ts
process.env.FEATURE_FLAG = '1' // and never restore
```

---

## 10) Suggested Command Patterns

- Local package: `pnpm --filter @repo/pkg test`
- Watch mode: `pnpm --filter @repo/pkg test -- --watch`
- Workspace CI: `pnpm -r test`

Adapt commands to your workspace script conventions.

---

## 11) Review Heuristics

A test suite is healthy when it is:

- Fast: developers run it frequently.
- Deterministic: same inputs produce same results.
- Focused: failures point to a clear behavior regression.
- Maintainable: minimal brittle snapshots and implementation coupling.