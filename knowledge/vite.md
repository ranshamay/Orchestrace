# Vite (Orchestrace UI)

Vite powers the `@orchestrace/ui` package for local development and production bundling.

## Repository Reality

`packages/ui/vite.config.ts`:

- Uses `@vitejs/plugin-react`
- Dev server port: `3000`
- Proxy pattern:
  - `'/api'` → `http://127.0.0.1:4310`
  - `changeOrigin: true`

UI scripts (`packages/ui/package.json`):

- `dev`: `vite`
- `build`: `tsc -b && vite build`
- `preview`: `vite preview`

## Why This Proxy Matters

The UI calls `/api` while the backend serves on `4310`; Vite proxy avoids CORS friction in local dev and keeps frontend API paths stable.

## Do / Don’t

### Do

- **Do** keep API calls relative (`/api/...`) instead of hardcoding hostnames.
- **Do** preserve proxy target alignment with backend port (`4310`) used by startup scripts.
- **Do** run typecheck before bundle (`tsc -b && vite build`), as currently configured.
- **Do** keep config minimal and explicit.

### Don’t

- **Don’t** duplicate backend URL constants across app code.
- **Don’t** use proxy settings as a production networking strategy.
- **Don’t** assume dev and preview modes are equivalent to deployed infra.

## Common Pitfalls

- Backend not running on `127.0.0.1:4310` causing proxy failures.
- Mixing absolute and relative API URLs (breaks portability).
- Silent drift between startup scripts and Vite `server.port` / proxy target.

## Performance Advice

- Keep plugin list small (currently React only) for fast startup/HMR.
- Avoid expensive runtime transforms in dev.
- Split large routes/components to improve production chunking and first-load performance.

## Quick Checks

```bash
pnpm --filter @orchestrace/ui dev
# verify http://127.0.0.1:3000 proxies /api to 4310
pnpm --filter @orchestrace/ui build
```