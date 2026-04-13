# Vitest Best Practices

## Overview

Root `vitest.config.ts` sets:

- `globals: true`
- `environment: 'node'`
- `include: ['packages/*/tests/**/*.test.ts']`
- Coverage via `v8`

## Best Practices

### Keep tests deterministic

- No hidden network calls.
- No reliance on local clock/timezone without control.

### Structure tests by behavior

```ts
describe('scheduler', () => {
  it('runs ready nodes in dependency order', async () => {
    // arrange
    // act
    // assert
  });
});
```

### Mock deliberately

Use `vi.mock`, `vi.spyOn`, and reset mocks in `afterEach`.

```ts
afterEach(() => {
  vi.restoreAllMocks();
});
```

### Async testing

Always `await` promises and assert rejection paths explicitly.

## Do and Don’t

### Do

- Use factories/builders for repetitive fixtures.
- Keep unit tests fast and isolated.

### Don’t

- Couple tests to internal implementation details.
- Leave fake timers enabled across tests.

## Common Pitfalls

- Mock leakage between tests.
- Flaky assertions on unordered async events.
- Overreliance on snapshots for logic-heavy behavior.