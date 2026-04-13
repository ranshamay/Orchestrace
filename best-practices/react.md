# React, React DOM, and React Router DOM Best Practices

## Overview

This guide defines practical, production-ready standards for **React**, **React DOM**, and **React Router DOM**.
It focuses on React 18+ and React Router 6.4+ (data routers), with patterns that improve correctness, performance, accessibility, and maintainability.

Use this guide when writing new UI code, reviewing pull requests, or refactoring legacy components.

---

## Key Principles

1. **Prefer clarity over cleverness**: readable code is easier to debug and scale.
2. **Keep components focused**: one component should solve one UI concern.
3. **Derive state when possible**: avoid storing values that can be computed.
4. **Use effects only for side effects**: do not use `useEffect` for normal render logic.
5. **Treat routing as data flow**: loaders/actions should own fetch/mutation where possible.
6. **Design for accessibility first**: semantic HTML and keyboard support are non-negotiable.
7. **Optimize after measuring**: use React DevTools profiler before adding memoization.
8. **Fail safely**: use error boundaries and route-level error UI.

---

## Best Practices

### 1) Component Design

#### DO: Keep components small and composable

```tsx
function UserCard({ user }: { user: User }) {
  return (
    <article>
      <h2>{user.name}</h2>
      <UserMeta user={user} />
      <UserActions userId={user.id} />
    </article>
  );
}
```

#### DON'T: Build massive “god components”

```tsx
function UserCard() {
  // fetch logic + form logic + permissions + analytics + UI + routing all together
  // hard to test, hard to review, hard to reuse
  return <div>{/* 400+ lines */}</div>;
}
```

#### DO: Co-locate related files (component, tests, styles)

```text
UserCard/
  UserCard.tsx
  UserCard.test.tsx
  UserCard.css
```

#### DON'T: Scatter one feature across unrelated folders without reason

```text
components/UserCard.tsx
hooks/useUserCardLogic.ts
styles/cards.css
tests/random/user-card.spec.ts
```

---

### 2) Props and State

#### DO: Derive values instead of duplicating state

```tsx
function CartSummary({ items }: { items: CartItem[] }) {
  const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  return <p>Total: ${total.toFixed(2)}</p>;
}
```

#### DON'T: Store derived values and manually sync them

```tsx
function CartSummary({ items }: { items: CartItem[] }) {
  const [total, setTotal] = useState(0);

  useEffect(() => {
    setTotal(items.reduce((sum, i) => sum + i.price * i.qty, 0));
  }, [items]);

  return <p>Total: ${total.toFixed(2)}</p>;
}
```

#### DO: Use controlled components for non-trivial forms

```tsx
function ProfileForm() {
  const [name, setName] = useState("");
  return <input value={name} onChange={(e) => setName(e.target.value)} />;
}
```

#### DON'T: Mix uncontrolled and controlled patterns unpredictably

```tsx
function ProfileForm() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  // unclear source of truth
  return <input ref={inputRef} defaultValue="" onChange={(e) => setName(e.target.value)} />;
}
```

---

### 3) Effects and Async Logic

#### DO: Use `useEffect` only for true side effects

```tsx
function PageTitle({ title }: { title: string }) {
  useEffect(() => {
    document.title = title;
  }, [title]);

  return <h1>{title}</h1>;
}
```

#### DON'T: Use effects for render-time computations

```tsx
function NameBadge({ first, last }: { first: string; last: string }) {
  const [fullName, setFullName] = useState("");

  useEffect(() => {
    setFullName(`${first} ${last}`);
  }, [first, last]);

  return <span>{fullName}</span>;
}
```

#### DO: Cancel stale async work

```tsx
function SearchResults({ query }: { query: string }) {
  const [results, setResults] = useState<Result[]>([]);

  useEffect(() => {
    const controller = new AbortController();

    fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
      .then((r) => r.json())
      .then(setResults)
      .catch((e) => {
        if (e.name !== "AbortError") throw e;
      });

    return () => controller.abort();
  }, [query]);

  return <ResultsList items={results} />;
}
```

#### DON'T: Ignore race conditions in effects

```tsx
useEffect(() => {
  fetch(`/api/search?q=${query}`)
    .then((r) => r.json())
    .then(setResults); // stale responses may overwrite newer query results
}, [query]);
```

---

### 4) Rendering Performance

#### DO: Memoize only when profiling shows value

```tsx
const ExpensiveChart = memo(function ExpensiveChart({ points }: { points: Point[] }) {
  return <Chart points={points} />;
});
```

#### DON'T: Blanket-wrap every component with `memo`

```tsx
const Button = memo(function Button(props: ButtonProps) {
  return <button {...props} />;
}); // usually unnecessary and adds cognitive overhead
```

#### DO: Stabilize callbacks passed to memoized children

```tsx
const handleSelect = useCallback((id: string) => {
  setSelectedId(id);
}, []);

return <ItemList onSelect={handleSelect} />;
```

#### DON'T: Recreate callback props every render without need

```tsx
return <ItemList onSelect={(id) => setSelectedId(id)} />;
```

---

### 5) Lists, Keys, and Identity

#### DO: Use stable, unique keys from data

```tsx
{todos.map((todo) => (
  <TodoRow key={todo.id} todo={todo} />
))}
```

#### DON'T: Use array index as key for dynamic lists

```tsx
{todos.map((todo, index) => (
  <TodoRow key={index} todo={todo} />
))}
```

---

### 6) React DOM Best Practices

#### DO: Initialize app with `createRoot` and `StrictMode`

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

#### DON'T: Keep using deprecated root API in new apps

```tsx
import ReactDOM from "react-dom";

ReactDOM.render(<App />, document.getElementById("root"));
```

#### DO: Use portals for modals/tooltips that must escape stacking context

```tsx
return createPortal(
  <dialog open aria-modal="true">...</dialog>,
  document.getElementById("modal-root")!
);
```

#### DON'T: Fight z-index in deeply nested DOM trees for overlays

```tsx
return <div style={{ position: "absolute", zIndex: 999999 }}>{/* fragile modal */}</div>;
```

#### DO: Match server and client markup when hydrating

```tsx
import { hydrateRoot } from "react-dom/client";
hydrateRoot(document, <App />);
```

#### DON'T: Render non-deterministic content on first paint

```tsx
function App() {
  return <p>{Math.random()}</p>; // hydration mismatch risk
}
```

---

### 7) Accessibility and Semantics

#### DO: Prefer semantic elements and accessible names

```tsx
<button type="button" aria-label="Close settings" onClick={onClose}>
  ×
</button>
```

#### DON'T: Rebuild native controls with generic divs

```tsx
<div role="button" onClick={onClose}>
  Close
</div>
```

#### DO: Connect labels and inputs

```tsx
<label htmlFor="email">Email</label>
<input id="email" name="email" type="email" />
```

#### DON'T: Rely on placeholders as labels

```tsx
<input placeholder="Email" />
```

---

### 8) React Router DOM Best Practices

#### DO: Use data routers (`loader`, `action`) for route data and mutations

```tsx
import { createBrowserRouter } from "react-router-dom";

const router = createBrowserRouter([
  {
    path: "/projects/:projectId",
    loader: async ({ params }) =>
      fetch(`/api/projects/${params.projectId}`).then((r) => r.json()),
    element: <ProjectPage />,
    errorElement: <ProjectErrorPage />,
  },
]);
```

#### DON'T: Fetch all route data in component effects by default

```tsx
function ProjectPage() {
  const { projectId } = useParams();
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    fetch(`/api/projects/${projectId}`).then((r) => r.json()).then(setProject);
  }, [projectId]);

  return <ProjectView project={project} />;
}
```

#### DO: Use nested routes + `<Outlet />` for layout composition

```tsx
<Route path="/settings" element={<SettingsLayout />}>
  <Route path="profile" element={<ProfileSettings />} />
  <Route path="security" element={<SecuritySettings />} />
</Route>
```

#### DON'T: Duplicate layout wrappers across sibling pages

```tsx
<Route path="/settings/profile" element={<SettingsLayout><ProfileSettings /></SettingsLayout>} />
<Route path="/settings/security" element={<SettingsLayout><SecuritySettings /></SettingsLayout>} />
```

#### DO: Use `<Link>`/`<NavLink>` for in-app navigation

```tsx
<NavLink to="/dashboard" end>
  Dashboard
</NavLink>
```

#### DON'T: Use `<a href>` for client-side internal routes

```tsx
<a href="/dashboard">Dashboard</a>
```

#### DO: Handle pending/error states with router hooks

```tsx
function SaveButton() {
  const navigation = useNavigation();
  return <button disabled={navigation.state === "submitting"}>Save</button>;
}
```

#### DON'T: Ignore network states and allow duplicate submissions

```tsx
<button onClick={submitForm}>Save</button>
```

---

## Common Mistakes

1. **Putting business logic directly in JSX** (hard to test and maintain).
2. **Using `useEffect` as a default tool** for anything dynamic.
3. **Mutating state directly** instead of immutable updates.
4. **Using unstable keys** in lists.
5. **Over-memoizing prematurely** without profiling evidence.
6. **Forgetting accessibility basics** (labels, keyboard nav, focus management).
7. **Using `<a>` instead of `<Link>`** for internal routing.
8. **Fetching route data inside components** rather than loaders/actions.
9. **Missing route-level `errorElement`** and graceful fallbacks.
10. **Ignoring StrictMode warnings** that expose unsafe patterns.

---

## Checklist

- [ ] Components are focused, composable, and reasonably small.
- [ ] No duplicated derived state (`useMemo`/inline derivation preferred over effect + state).
- [ ] Effects are used only for side effects and clean up correctly.
- [ ] Async logic handles cancellation/race conditions.
- [ ] List keys are stable and unique.
- [ ] Accessibility basics are present (semantic HTML, labels, keyboard support).
- [ ] React DOM uses `createRoot`/`hydrateRoot` appropriately.
- [ ] Portals are used for overlays/modals where needed.
- [ ] Router uses loaders/actions for data flow and mutations.
- [ ] Nested routes are used with shared layouts and `<Outlet />`.
- [ ] Internal navigation uses `<Link>`/`<NavLink>`.
- [ ] Pending/error UI exists for route transitions and submissions.
- [ ] Error boundaries / `errorElement` are defined for critical routes.
- [ ] Performance optimizations are justified by profiling.