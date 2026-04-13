# @vitejs/plugin-react Best Practices

Use `@vitejs/plugin-react` for fast React development with Fast Refresh and production-ready transforms.

## Installation and Baseline Config

- Keep Vite config small and explicit.
- Use ESM + strict TypeScript in config and source.
- Register React plugin early in plugin list unless another plugin requires precedence.

```ts
// ✅ Do
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
```

## Fast Refresh Safety

- Export React components consistently from module files.
- Avoid side-effectful module top-level code that interferes with HMR.
- Keep stateful logic inside components/hooks, not in mutable module singletons.

```tsx
// ✅ Do
export function Counter() {
  // component logic
  return <button>Increment</button>;
}
```

```tsx
// ❌ Don't
let count = 0; // mutable module singleton for UI state
export function Counter() {
  return <button onClick={() => count++}>{count}</button>;
}
```

## Babel / JSX Transform Options

- Only customize plugin options when required (e.g., JSX runtime, Babel plugins).
- Document non-default Babel transforms to avoid surprising build behavior.
- Prefer TypeScript + ESLint for most code quality rules instead of heavy Babel-only transforms.

## Environment Variables

- Use `import.meta.env` for client-safe env values.
- Prefix exposed variables with `VITE_`.
- Never leak secrets into client bundles.

## SSR and Hydration Contexts

- If using SSR, ensure server/client entry points are separated and deterministic.
- Keep plugin and alias config aligned across test/build/SSR tools.

## Common Pitfalls

- Over-customizing Vite config early.
- Depending on Node-only APIs in browser code.
- Assuming all env vars are available client-side.
- Confusing `@vitejs/plugin-react` with `@vitejs/plugin-react-swc` tradeoffs without benchmarking.