# Vite + `@vitejs/plugin-react` Best Practices

## 1) Scope and baseline

These practices target modern React + TypeScript apps using:

- `vite` (current major)
- `@vitejs/plugin-react`
- ESM-first tooling
- Monorepo-friendly setups

Use this as a production baseline, not just a scaffold default.

---

## 2) Baseline configuration (keep it explicit)

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: mode === 'development'
      ? {
          '/api': {
            target: 'http://127.0.0.1:4310',
            changeOrigin: true,
          },
        }
      : undefined,
  },
  build: {
    sourcemap: mode !== 'production',
  },
}))
```

### Why

- Keeps development behavior (proxy, sourcemaps) separate from production.
- Makes environment-dependent behavior reviewable in one place.

---

## 3) Environment and secrets

### DO

- Use `import.meta.env` in client code.
- Prefix client-exposed variables with `VITE_`.
- Keep secrets in server/runtime systems, never in bundle-time client vars.

```ts
const apiBase = import.meta.env.VITE_API_BASE_URL
```

### DON'T

- Don’t use `process.env` in browser code.
- Don’t place private tokens in `.env` variables that ship to clients.

```ts
// ❌ Browser bundle anti-pattern
const token = process.env.API_TOKEN
```

---

## 4) `@vitejs/plugin-react` usage

### DO

- Keep plugin list minimal unless a transform is required.
- Use plugin options intentionally (e.g., custom Babel only when needed).
- Let Fast Refresh work by default; avoid wrappers that break component boundaries.

```ts
plugins: [
  react({
    // Add babel config only for concrete use-cases
    babel: {
      plugins: [],
    },
  }),
]
```

### DON'T

- Don’t add Babel transforms “just in case”; every transform costs build/dev time.
- Don’t mix overlapping React transforms across multiple tools.

---

## 5) Performance and bundle strategy

### DO

- Use route/component-level lazy loading for heavy screens.
- Audit large dependencies before adding them.
- Split vendor chunks only when measurements justify it.

```tsx
import { lazy, Suspense } from 'react'

const AdminPage = lazy(() => import('./pages/AdminPage'))

export function App() {
  return (
    <Suspense fallback={<div>Loading…</div>}>
      <AdminPage />
    </Suspense>
  )
}
```

### DON'T

- Don’t prematurely over-customize Rollup chunking without profiling.
- Don’t import heavyweight libraries in root layout if used in rare flows.

---

## 6) Dev server proxy and API boundaries

### DO

- Treat Vite proxy as local-development convenience.
- Keep real backend URLs configured in deployment environments.
- Document which paths are proxied (`/api`, `/ws`, etc.).

### DON'T

- Don’t rely on Vite dev proxy behavior as your production routing strategy.

---

## 7) Monorepo and import hygiene

### DO

- Keep path alias strategy consistent between TS and Vite.
- Prefer explicit package boundaries over deep relative imports (`../../../`).
- Ensure shared packages are ESM-compatible and tree-shakable.

### DON'T

- Don’t create alias definitions in Vite only; TS/editor and runtime must agree.

---

## 8) CI/CD and reproducibility

### DO

- Run at least: typecheck, lint, unit tests, and `vite build` in CI.
- Pin Node/pnpm versions in CI to reduce build drift.
- Track bundle regressions with a size budget or report artifact.

### DON'T

- Don’t treat successful dev server startup as build correctness.

---

## 9) DO / DON'T quick reference

### ✅ DO

- Keep `vite.config.ts` environment-aware and minimal.
- Use `import.meta.env.VITE_*` for public runtime config.
- Lazy-load large routes/components.
- Keep plugin-react transforms intentional.
- Validate with production build in CI.

### ❌ DON'T

- Expose secrets via Vite env vars.
- Assume dev proxy equals production networking.
- Add transforms/plugins without measurable value.
- Fragment alias settings between TS and Vite.

---

## 10) PR review checklist

- [ ] New env vars follow `VITE_` exposure rules.
- [ ] No secret leaked into client-accessible code.
- [ ] `vite build` succeeds locally/CI.
- [ ] Added dependencies were checked for size/runtime cost.
- [ ] Any plugin customization includes a concrete rationale.