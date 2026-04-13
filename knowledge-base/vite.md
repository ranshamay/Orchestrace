# Vite & @vitejs/plugin-react Best Practices

## Overview

UI build/dev uses Vite with React plugin (`packages/ui/vite.config.ts`). Dev server runs on port 3000 and proxies `/api` to backend `127.0.0.1:4310`.

## Configuration Best Practices

```ts
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4310', changeOrigin: true },
    },
  },
});
```

## Best Practices

- Keep `VITE_` prefix for client-exposed env vars.
- Use `import.meta.env` (never `process.env` in browser code).
- Keep plugin list minimal; add only justified plugins.
- Split large modules to improve startup/HMR.

## Do and Don’t

### Do

```ts
const apiBase = import.meta.env.VITE_API_BASE_URL ?? '/api';
```

### Don’t

```ts
// leaks assumptions from Node runtime into browser
const key = process.env.SECRET_KEY;
```

## Common Pitfalls

- Accidentally exposing secrets via `VITE_` variables.
- Misconfigured proxy causing CORS confusion.
- Overusing alias patterns without consistent TS path config.