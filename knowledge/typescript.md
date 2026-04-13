# TypeScript Best Practices

TypeScript in this monorepo runs in **strict mode** with **ESM modules**. Optimize for correctness first, then ergonomics.

## Core Principles

- Keep `strict` guarantees intact (`noImplicitAny`, `strictNullChecks`, etc.).
- Model domain concepts with explicit types, not ad-hoc object literals.
- Prefer narrowing and safe parsing at boundaries (I/O, JSON, env vars).
- Use `unknown` for untrusted input; avoid `any`.

## Do / Don't

### 1) Validate unknown input at boundaries

```ts
// ✅ Do
function parsePort(value: unknown): number {
  if (typeof value !== "string") throw new Error("PORT must be string");
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0) throw new Error("Invalid PORT");
  return port;
}
```

```ts
// ❌ Don't
const port: number = Number(process.env.PORT as any);
```

### 2) Use discriminated unions for state machines

```ts
// ✅ Do
type JobState =
  | { kind: "queued" }
  | { kind: "running"; startedAt: number }
  | { kind: "failed"; error: Error }
  | { kind: "completed"; durationMs: number };

function describe(state: JobState): string {
  switch (state.kind) {
    case "queued":
      return "Waiting";
    case "running":
      return `Running since ${state.startedAt}`;
    case "failed":
      return state.error.message;
    case "completed":
      return `${state.durationMs}ms`;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}
```

```ts
// ❌ Don't
type JobState = { status: string; data?: any };
```

### 3) Keep function signatures precise

```ts
// ✅ Do
interface RetryOptions {
  retries: number;
  backoffMs: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  // ...
  return fn();
}
```

```ts
// ❌ Don't
export async function withRetry(fn: Function, options: object): Promise<any> {
  return fn();
}
```

## Pitfalls

- **Type assertions (`as`) as escape hatch**: use only after runtime checks.
- **Leaky `any`**: one `any` can silently disable type safety downstream.
- **Overuse of enums**: string literal unions are often simpler and more composable.
- **Ambient globals**: avoid hidden runtime dependencies.

## Performance Notes

- Heavy conditional and mapped types can slow type-checking; keep utility types focused.
- Use explicit return types on exported APIs to avoid expensive inferred widening.
- Prefer simpler generic constraints over deeply recursive type machinery.

## Practical Checklist

- [ ] No new `any` in public APIs.
- [ ] Boundary inputs parsed from `unknown`.
- [ ] Switches over unions are exhaustive.
- [ ] Exported function/variable types are explicit where clarity matters.