# React Router DOM Best Practices

## Overview

React Router powers client-side navigation in the UI. Use route boundaries to keep screens modular and recoverable.

## Best Practices

### Prefer declarative route trees

Use layout routes and nested routes for shared shells.

### Use `Link`/`NavLink` instead of manual history mutation

```tsx
<NavLink to="/sessions" className="px-2 py-1">Sessions</NavLink>
```

### Validate route/search params

Treat URL params as untrusted input and parse safely.

### Protect auth-only routes

Redirect unauthenticated users and preserve intended destination (`next` style patterns).

### Lazy-load heavy route chunks

```tsx
const SettingsPage = React.lazy(() => import('./SettingsPage'));
```

## Do and Don’t

### Do

- Centralize route constants.
- Handle route-level errors with fallback UIs.

### Don’t

- Build URLs via fragile string concatenation.
- Depend on global mutable auth state without synchronization.

## Common Pitfalls

- Infinite redirects caused by route guards.
- Reading params without null checks.
- Missing 404 fallback routes.