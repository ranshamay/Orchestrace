# React Ecosystem Best Practices (React, React DOM, React Router DOM, Vite React Plugin)

## Overview

This project’s UI package (`packages/ui`) uses:

- **React 19** (`react@^19.2.4`)
- **React DOM 19** (`react-dom@^19.2.4`)
- **React Router DOM 7** (`react-router-dom@^7.14.0`)
- **Vite 8 + `@vitejs/plugin-react` 6**
- **TypeScript strict mode** with `jsx: react-jsx`

The current app bootstrap is standard and correct:

```tsx
// packages/ui/src/main.tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

The highest-value practices for this stack are:

1. Keep rendering and effects deterministic under `StrictMode`.
2. Centralize route state in React Router (avoid ad-hoc `window.history` logic).
3. Configure Vite React plugin intentionally (Fast Refresh, JSX runtime, optional compiler settings).
4. Preserve strong typing and stable component boundaries to reduce unnecessary rerenders.

---

## DO

### React

- **Do keep components pure**: derive UI from props/state; move side effects into hooks.
- **Do use functional state updates** when next state depends on previous state.
- **Do split large stateful components** into feature hooks + presentational components.
- **Do use `useMemo`/`useCallback` selectively** for expensive calculations or stable identities passed to memoized children.
- **Do handle async effect cleanup** (`AbortController`, flags, unsubscribes) to avoid race conditions.
- **Do treat `StrictMode` double-invocation in dev as a signal** that effects are not idempotent.

### React DOM

- **Do use `createRoot` from `react-dom/client`** (already done).
- **Do keep a single root per SPA mount point** unless there is a deliberate micro-frontend need.
- **Do keep hydration concerns explicit** if SSR is introduced later (`hydrateRoot`).

### React Router DOM

- **Do use Router APIs for navigation/query params** instead of direct `window.history` manipulation.
- **Do model route-driven UI in URL** (tabs, filters, selected entities) for shareability and back/forward correctness.
- **Do isolate route parsing/serialization utilities** and type the allowed params.

### `@vitejs/plugin-react`

- **Do keep plugin enabled first in plugin chain** unless another plugin explicitly requires precedence.
- **Do use environment-aware config** (dev proxy, production output, sourcemaps as needed).
- **Do pin major versions across Vite and plugin-react** to avoid transform/runtime mismatch.

---

## DON'T

### React

- **Don’t put non-trivial app orchestration in a single mega-component**; it becomes brittle and hard to test.
- **Don’t silence hook dependency warnings without proving correctness**.
- **Don’t derive state in effects when it can be derived during render**.
- **Don’t mutate objects/arrays in state**; always produce new references.

### React DOM

- **Don’t call `createRoot` repeatedly on the same element**.
- **Don’t perform DOM writes in render paths**; use refs/effects.

### React Router DOM

- **Don’t mix manual history writes and Router navigation** in the same flow.
- **Don’t parse raw `window.location` in many components**; centralize through Router hooks (`useLocation`, `useSearchParams`, `useNavigate`).

### `@vitejs/plugin-react`

- **Don’t add Babel/SWC transforms that duplicate plugin-react behavior** unless required and benchmarked.
- **Don’t rely on dev-only Fast Refresh behavior for production correctness**.

---

## Configuration

### Recommended `vite.config.ts`

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  plugins: [
    react({
      // Keep defaults unless you need custom Babel transforms.
      // babel: { plugins: [] },
    }),
  ],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4310',
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: mode !== 'production' ? true : false,
  },
}))
```

### Recommended React Router app shell pattern

```tsx
// src/main.tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)
```

```tsx
// src/app/routes.tsx
import { Navigate, Route, Routes } from 'react-router-dom'
import { LoginPage } from './pages/LoginPage'
import { HomePage } from './pages/HomePage'
import { SettingsPage } from './pages/SettingsPage'

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
```

### URL query state (typed and Router-native)

```tsx
import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

type Tab = 'chat' | 'graph' | 'settings'
const DEFAULT_TAB: Tab = 'chat'
const VALID_TABS = new Set<Tab>(['chat', 'graph', 'settings'])

export function useTabQueryState(): [Tab, (next: Tab) => void] {
  const [params, setParams] = useSearchParams()

  const tab = useMemo<Tab>(() => {
    const raw = params.get('tab')
    return raw && VALID_TABS.has(raw as Tab) ? (raw as Tab) : DEFAULT_TAB
  }, [params])

  const setTab = (next: Tab) => {
    const nextParams = new URLSearchParams(params)
    nextParams.set('tab', next)
    setParams(nextParams, { replace: false })
  }

  return [tab, setTab]
}
```

---

## Robust Code Examples

### 1) Idempotent async effect with cleanup

```tsx
import { useEffect, useState } from 'react'

type Profile = { id: string; name: string }

export function useProfile(userId: string | null) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!userId) {
      setProfile(null)
      return
    }

    const controller = new AbortController()
    let active = true

    setLoading(true)
    setError(null)

    ;(async () => {
      try {
        const res = await fetch(`/api/users/${userId}`, { signal: controller.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as Profile
        if (active) setProfile(data)
      } catch (err) {
        if (!active) return
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        if (active) setLoading(false)
      }
    })()

    return () => {
      active = false
      controller.abort()
    }
  }, [userId])

  return { profile, loading, error }
}
```

### 2) Safe post-login redirect with Router (no raw history writes)

```tsx
import { useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

function useSafeNextPath() {
  const { search } = useLocation()

  return useMemo(() => {
    const params = new URLSearchParams(search)
    const next = (params.get('next') ?? '').trim()

    if (!next.startsWith('/')) return '/'
    if (next.startsWith('//')) return '/'
    if (next === '/login') return '/'

    return next
  }, [search])
}

export function LoginSuccessHandler() {
  const navigate = useNavigate()
  const nextPath = useSafeNextPath()

  const onLoginSuccess = () => {
    navigate(nextPath, { replace: true })
  }

  return <button onClick={onLoginSuccess}>Continue</button>
}
```

### 3) Performance-safe derived view model

```tsx
import { useMemo } from 'react'

type Session = { id: string; status: 'idle' | 'running' | 'failed'; title: string }

export function SessionList({ sessions }: { sessions: Session[] }) {
  const grouped = useMemo(() => {
    return sessions.reduce(
      (acc, s) => {
        acc[s.status].push(s)
        return acc
      },
      { idle: [] as Session[], running: [] as Session[], failed: [] as Session[] }
    )
  }, [sessions])

  return (
    <>
      <h3>Running ({grouped.running.length})</h3>
      {grouped.running.map((s) => (
        <div key={s.id}>{s.title}</div>
      ))}
    </>
  )
}
```

---

## Project-specific Notes

1. **Current state:** `react-router-dom` is installed, but routing is largely handled manually via `window.history` and URL helpers (`viewRoute.ts`, `runUrl.ts`, and direct calls in `App.tsx`).
   - Recommended migration path: wrap app in `BrowserRouter`, move tab/query/url synchronization to `useSearchParams`, and replace direct history writes with `useNavigate`.

2. **`App.tsx` is very large and orchestration-heavy.**
   - Continue extracting domain hooks/components (`auth`, `session streams`, `preferences`, `routing`) to reduce cognitive load and make test boundaries clearer.

3. **Strict TypeScript is enabled (`strict`, `noUnusedLocals`, `noUnusedParameters`).**
   - Keep this posture. Prefer explicit types at module boundaries (API responses, URL params, app state selectors).

4. **Vite dev proxy is configured for `/api` → `127.0.0.1:4310`.**
   - Keep API base paths relative (`/api/...`) in frontend code to avoid environment-specific branching.

5. **React StrictMode is enabled in `main.tsx`.**
   - Ensure effects and subscriptions remain idempotent; avoid “run once” assumptions that break under dev double-invoke.

6. **ESLint currently has broad TypeScript rules at root, but React-specific linting is not enabled globally.**
   - Consider adding React + hooks + React DOM lint rules for `packages/ui/src/**/*.{ts,tsx}` to catch stale closures, unsafe DOM usage, and refresh issues earlier.

---

## Quick Adoption Checklist

- [ ] Introduce `BrowserRouter` and route definitions in a dedicated module.
- [ ] Replace direct `window.history.*` usage with Router hooks.
- [ ] Extract remaining cross-cutting concerns from `App.tsx` into focused hooks.
- [ ] Add/strengthen React-specific lint rules in UI package.
- [ ] Keep `@vitejs/plugin-react` config minimal and benchmark before adding transforms.