# eslint-plugin-react-refresh Best Practices

## Overview
`eslint-plugin-react-refresh` protects Fast Refresh behavior in Vite React apps. It is enabled in UI config via `reactRefresh.configs.vite`.

## Why It Matters
Fast Refresh relies on module export patterns to preserve state during HMR. Invalid exports can cause full reloads or inconsistent dev behavior.

## Recommended Flat Config Usage
```js
import reactRefresh from 'eslint-plugin-react-refresh';

export default [
  {
    files: ['**/*.{ts,tsx}'],
    extends: [reactRefresh.configs.vite],
  },
];
```

## Core Rule Focus
- `react-refresh/only-export-components`: encourages files exporting React components (or explicitly allowed constants) so refresh can work predictably.

## ✅ Do / ❌ Don’t

### ✅ Do: Keep component modules focused
```tsx
export function UserCard() {
  return <div>User</div>;
}
```

### ❌ Don’t: Mix component exports with unrelated runtime objects
```tsx
export const cache = new Map();
export function UserCard() { return <div>User</div>; }
```

### ✅ Do: Move shared constants/helpers to separate modules
```ts
// user-card.constants.ts
export const USER_CARD_VARIANTS = ['compact', 'full'] as const;
```

## Integration Notes with Vite
- `@vitejs/plugin-react` + this plugin together improve HMR reliability.
- Keep rule scope to React source files (`*.tsx` primarily, `*.ts` only when needed).

## Common Pitfalls
- Disabling the rule to “fix” noisy warnings instead of restructuring exports.
- Storing singleton mutable state in component files.
- Applying plugin rules to backend/non-React packages.

## Practical Policy for This Repo
- Keep `reactRefresh.configs.vite` in `packages/ui` only.
- Prefer one responsibility per module: component vs utility/state.
- Treat refresh warnings as developer-experience correctness issues worth fixing.