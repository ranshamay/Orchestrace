# JavaScript Best Practices

Even in a TypeScript-first codebase, runtime JavaScript behavior determines production correctness.

## Core Principles

- Write predictable, side-effect-aware code.
- Favor pure functions and explicit data flow.
- Use modern ECMAScript features that improve readability and safety.
- Treat async control flow as first-class design.

## Do / Don't

### 1) Make async flows explicit

```js
// ✅ Do
export async function loadUsers(client) {
  const [accounts, profiles] = await Promise.all([
    client.getAccounts(),
    client.getProfiles(),
  ]);
  return mergeAccountsWithProfiles(accounts, profiles);
}
```

```js
// ❌ Don't
export function loadUsers(client) {
  return client.getAccounts().then((accounts) => {
    return client.getProfiles().then((profiles) => {
      return mergeAccountsWithProfiles(accounts, profiles);
    });
  });
}
```

### 2) Avoid truthiness traps

```js
// ✅ Do
if (count === 0) {
  // handle empty case intentionally
}
```

```js
// ❌ Don't
if (!count) {
  // accidentally matches 0, "", null, undefined, NaN
}
```

### 3) Prefer immutable updates for shared state

```js
// ✅ Do
const next = { ...current, retries: current.retries + 1 };
```

```js
// ❌ Don't
current.retries += 1;
```

## Pitfalls

- Silent coercion (`==`, `+` with mixed types) creates hard-to-debug behavior.
- Implicit mutation of arrays/objects can break callers.
- Unhandled promise rejections can crash Node processes or hide failures.

## Performance Notes

- Avoid repeated deep cloning in hot paths.
- Batch async I/O with `Promise.all` when operations are independent.
- Use `Map`/`Set` for frequent membership checks instead of linear array scans.

## Practical Checklist

- [ ] `===`/`!==` used by default.
- [ ] Async functions always awaited or explicitly handled.
- [ ] Shared objects not mutated in-place unless intentional and documented.