# eslint-plugin-react-hooks Best Practices

## Overview
`eslint-plugin-react-hooks` enforces the Rules of Hooks and dependency correctness for React Hooks. It is enabled in `packages/ui/eslint.config.js` via `reactHooks.configs.flat.recommended`.

## Why It Matters
Incorrect Hook usage can create subtle runtime bugs (stale closures, conditional Hook calls, missed effects). This plugin catches those early.

## Recommended Flat Config Usage
```js
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    files: ['**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
  },
];
```

## High-Value Rules
- `react-hooks/rules-of-hooks`: Hook call order and top-level placement.
- `react-hooks/exhaustive-deps`: dependency array completeness for `useEffect`, `useMemo`, `useCallback`.

## ✅ Do / ❌ Don’t

### ✅ Do: Keep Hook calls top-level
```tsx
function Component({ enabled }: { enabled: boolean }) {
  const [count, setCount] = useState(0);
  if (!enabled) return null;
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
```

### ❌ Don’t: Call hooks conditionally
```tsx
if (enabled) {
  const [count] = useState(0); // invalid
}
```

### ✅ Do: Include all referenced dependencies
```tsx
useEffect(() => {
  fetchUser(userId);
}, [userId]);
```

### ❌ Don’t: Silence `exhaustive-deps` without reasoning
```tsx
// eslint-disable-next-line react-hooks/exhaustive-deps
useEffect(() => sync(value), []);
```

## Handling False Positives Safely
- Prefer refactoring to stable callbacks (`useCallback`) or derived values (`useMemo`).
- If suppression is necessary, keep it local and explain why in a comment.

## Common Pitfalls
- Missing function dependencies captured by closures.
- Recreating objects/arrays inline and triggering unnecessary effects.
- Blanket disabling `exhaustive-deps` across files.

## Practical Policy for This Repo
- Keep `react-hooks` enabled as `recommended` in UI.
- Treat `rules-of-hooks` as non-negotiable.
- Allow limited, documented suppressions for `exhaustive-deps` only when refactoring would worsen clarity or correctness.