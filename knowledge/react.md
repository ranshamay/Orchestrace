# React Best Practices (TypeScript, React 19)

Use this guide for modern, strict-TypeScript React applications with function components and Hooks.

## Core Principles

- Prefer **pure, composable components**.
- Keep state **minimal and local**; derive values instead of duplicating state.
- Use **strict TypeScript** for component props, events, and async flows.
- Treat Effects as **synchronization with external systems**, not data-flow tools.
- Design for **concurrent rendering safety** (no side effects during render).

## TypeScript-First Component Design

- Always type props explicitly with interfaces or type aliases.
- Use `readonly` where practical to signal immutability.
- Prefer union types/discriminated unions over optional booleans for variant logic.
- Avoid `React.FC` when you need precise `children` control or generic props.

```tsx
// ✅ Do
interface ButtonProps {
  readonly kind: 'primary' | 'secondary';
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}

export function Button({ kind, onClick, children }: ButtonProps) {
  return (
    <button data-kind={kind} onClick={onClick}>
      {children}
    </button>
  );
}
```

```tsx
// ❌ Don't
export const Button: React.FC<any> = (props) => (
  <button onClick={props.onClick}>{props.children}</button>
);
```

## State and Derived Data

- Keep source-of-truth state small.
- Compute derived values inline or with `useMemo` only when expensive.
- Use functional updates when next state depends on previous state.

```tsx
// ✅ Do
const [items, setItems] = useState<readonly string[]>([]);
const itemCount = items.length;

function addItem(next: string) {
  setItems((prev) => [...prev, next]);
}
```

```tsx
// ❌ Don't (duplicated derived state)
const [items, setItems] = useState<string[]>([]);
const [itemCount, setItemCount] = useState(0);
```

## Effects and Async Work

- Prefer event handlers, loaders/actions, or framework data APIs over ad hoc Effects.
- In Effects, handle cancellation/cleanup for async flows.
- Keep dependency arrays accurate; satisfy lint rules instead of suppressing them.

```tsx
// ✅ Do
useEffect(() => {
  const controller = new AbortController();

  void fetch('/api/profile', { signal: controller.signal })
    .then((r) => r.json())
    .then(setProfile)
    .catch((err: unknown) => {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setError('Failed to load profile');
      }
    });

  return () => controller.abort();
}, []);
```

```tsx
// ❌ Don't
useEffect(() => {
  fetch('/api/profile').then((r) => r.json()).then(setProfile);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

## Rendering and Performance

- Optimize only where profiling shows bottlenecks.
- Use `React.memo`, `useMemo`, and `useCallback` selectively.
- Stabilize props for memoized children only when useful.
- Use list keys from stable IDs, never array indexes for mutable lists.

## React 19-Oriented Guidance

- Use modern APIs and avoid legacy class component patterns for new code.
- For form submission workflows, prefer React 19 form/action patterns where applicable.
- Keep components compatible with concurrent rendering (idempotent render logic).
- Avoid reading/writing mutable globals during render.

## Error Boundaries

- Define error boundaries at route/layout boundaries and critical feature boundaries.
- Present fallback UI with retry affordances.
- Log structured error metadata in boundary handlers.

## Testing Implications

- Test behavior, not implementation details.
- Assert user-visible states and accessible roles/labels.
- Avoid brittle snapshot-only strategies.

## Common Pitfalls

- Using Effects for pure derivation.
- Overusing context for frequently changing state (causes broad re-renders).
- Passing `any` through props and event handlers.
- Mutating objects/arrays in state.
- Silencing hook dependency lint errors.