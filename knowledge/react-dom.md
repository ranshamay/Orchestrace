# React DOM Best Practices (Client Rendering & Hydration)

Use React DOM APIs deliberately for mounting, hydration, portals, and escape hatches.

## Root Initialization

- Use `createRoot` for client-rendered apps.
- Use `hydrateRoot` only when hydrating server-rendered HTML.
- Initialize once at app entry; avoid remounting root during runtime.

```tsx
// ✅ Do (SPA)
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

```tsx
// ❌ Don't
import ReactDOM from 'react-dom';
ReactDOM.render(<App />, document.getElementById('root'));
```

## Hydration Safety

- Ensure server and client markup match.
- Avoid non-deterministic render output (`Date.now()`, random values) during initial render.
- Gate browser-only APIs (`window`, `localStorage`) behind effects or runtime checks.

## Portals

- Use portals for modals, toasts, and overlays that need DOM escape from stacking/overflow contexts.
- Keep accessibility intact: focus trapping, `aria-modal`, Escape handling.

```tsx
// ✅ Do
import { createPortal } from 'react-dom';

export function Modal({ children }: { readonly children: React.ReactNode }) {
  const el = document.getElementById('modal-root');
  if (!el) return null;
  return createPortal(children, el);
}
```

## `flushSync` and Imperative Escape Hatches

- Use `flushSync` rarely, only when synchronous DOM visibility is required for integrations.
- Prefer declarative state updates first.

```tsx
// ❌ Don't overuse flushSync for ordinary updates
```

## Unmounting and Micro-frontend Contexts

- If embedding React in non-React hosts, retain root reference and call `root.unmount()` on teardown.
- Clean event listeners and external subscriptions during unmount.

## Common Pitfalls

- Mixing legacy `ReactDOM.render` with modern root APIs.
- Hydration mismatch caused by client-only conditionals in render.
- Portal without keyboard/focus accessibility.
- Imperative DOM mutation that fights React ownership.