# React & React DOM Best Practices

## Overview

Orchestrace UI uses React + React DOM with Vite. Priorities: predictable state, composable hooks, and render performance.

## Best Practices

### Compose with focused hooks

Break large pages into reusable hooks (`useSessionPolling`, `useThemePreference`, etc.) to isolate side effects.

### Keep components pure

Derive view data from props/state; avoid mutable module-level state.

### Use effect dependencies correctly

```tsx
useEffect(() => {
  void loadSession(sessionId);
}, [sessionId]);
```

### Memoize only when needed

Use `useMemo` / `useCallback` for expensive derivations or stable callback identity passed to memoized children.

### Prefer controlled boundaries for async state

Keep loading/error/data triplets explicit and co-located.

## Do and Don’t

### Do

```tsx
function SessionTitle({ name }: { name: string }) {
  return <h1 className="text-lg font-semibold">{name}</h1>;
}
```

### Don’t

```tsx
// side effect during render
if (!window.localStorage.getItem('x')) window.localStorage.setItem('x', '1');
```

## Common Pitfalls

- Stale closures in async callbacks.
- Unbounded effects causing loops.
- Overuse of context for rapidly changing state.
- Excessive memoization increasing complexity without gain.

## React DOM Notes

Use `createRoot` and keep `StrictMode` enabled in development for side-effect detection.