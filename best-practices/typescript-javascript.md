# TypeScript & JavaScript Best Practices

## Overview
Use JavaScript for flexibility and TypeScript for safety at scale. The goal is predictable, testable code with clear contracts, strong tooling, and low maintenance cost.

## Key Principles
- Prefer clarity over cleverness.
- Make invalid states unrepresentable.
- Keep side effects explicit and isolated.
- Optimize for maintainability first, performance second (unless proven otherwise).
- Enforce consistency via linting, formatting, and CI.

## Best Practices

### 1) Type boundaries explicitly
**DO**
```ts
interface CreateUserInput {
  email: string;
  displayName: string;
}

export async function createUser(input: CreateUserInput): Promise<{ id: string }> {
  // ...
  return { id: crypto.randomUUID() };
}
```

**DON'T**
```ts
export async function createUser(input: any): Promise<any> {
  return db.insert(input);
}
```

### 2) Prefer `unknown` + narrowing over `any`
**DO**
```ts
function parseCount(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  throw new Error('Invalid count');
}
```

**DON'T**
```ts
function parseCount(value: any): number {
  return Number(value.trim());
}
```

### 3) Keep functions focused and mostly pure
**DO**
```ts
function calculateSubtotal(prices: number[]): number {
  return prices.reduce((sum, p) => sum + p, 0);
}
```

**DON'T**
```ts
let subtotal = 0;
function calculateSubtotal(prices: number[]) {
  prices.forEach(p => (subtotal += p));
  console.log('subtotal', subtotal);
  return subtotal;
}
```

### 4) Handle async errors intentionally
**DO**
```ts
async function loadProfile(userId: string) {
  try {
    return await api.get(`/users/${userId}`);
  } catch (error) {
    logger.error({ error, userId }, 'failed to load profile');
    throw new Error('Profile unavailable');
  }
}
```

**DON'T**
```ts
function loadProfile(userId) {
  return api.get('/users/' + userId).then(r => r.data);
  // no error handling
}
```

### 5) Use immutable update patterns
**DO**
```ts
const updated = users.map(u => (u.id === id ? { ...u, active: false } : u));
```

**DON'T**
```ts
for (const user of users) {
  if (user.id === id) user.active = false;
}
```

### 6) Prefer `===` and nullish coalescing
**DO**
```ts
const pageSize = input.pageSize ?? 25;
if (status === 'ready') start();
```

**DON'T**
```ts
const pageSize = input.pageSize || 25;
if (status == 'ready') start();
```

## Common Mistakes
- Using `any` to bypass compiler guidance.
- Mixing data transformation with I/O and logging in the same function.
- Silent promise rejections and missing `await`.
- Mutating objects passed between modules.
- Overusing classes where simple functions and modules are enough.

## Checklist
- [ ] Public APIs and module boundaries have explicit types.
- [ ] `any` usage is avoided or justified with comments.
- [ ] Async flows include error handling and useful logs.
- [ ] State updates avoid mutation unless intentional.
- [ ] Linting, formatting, and tests run in CI.
- [ ] Complexity is controlled (small functions, clear naming).