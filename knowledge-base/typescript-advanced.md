# TypeScript Advanced Patterns

## Overview

Advanced TS patterns improve API safety and reduce runtime bugs when modeling orchestration, events, and provider abstractions.

## Best Practices

### Constrained generics

```ts
function byId<T extends { id: string }>(items: T[]): Record<string, T> {
  return Object.fromEntries(items.map((i) => [i.id, i]));
}
```

### Conditional types + `infer`

```ts
type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;
```

### Utility types for API contracts

Use `Pick`, `Omit`, `Partial`, `Required`, `Readonly`, `Record` intentionally.

### `satisfies` for literal safety

```ts
const providers = {
  anthropic: { streaming: true },
  openai: { streaming: true },
} satisfies Record<string, { streaming: boolean }>;
```

### Discriminated unions + exhaustive checks

Model state transitions explicitly; fail compilation on missing cases.

### Branded types for IDs

```ts
type SessionId = string & { readonly __brand: 'SessionId' };
```

## Do and Don’t

### Do

- Build domain-level type aliases.
- Keep advanced types readable and documented.

### Don’t

- Use type gymnastics where simple interfaces suffice.
- Hide complexity in deeply nested conditional types without tests.

## Common Pitfalls

- Over-abstracted generic helpers nobody can maintain.
- Inference surprises when constraints are too loose.