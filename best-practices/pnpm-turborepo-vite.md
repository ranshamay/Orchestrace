# pnpm + Turborepo + Vite Best Practices (Orchestrace)

## Overview

This monorepo uses:

- **pnpm workspaces** for dependency and package graph management (`pnpm-workspace.yaml`)
- **Turborepo** for task orchestration/caching (`turbo.json`)
- **Vite** for the UI package (`packages/ui`)

In this repo, most packages are TypeScript libraries that publish from `dist/`, while `@orchestrace/ui` is a Vite app. The key operational rule is:

> **Internal packages must be built before strict typecheck/test flows in dependents.**

That rule is already reflected in root/package scripts (`pretest`, `pretypecheck`, `pnpm --filter <pkg>... build`).

---

## DO

- **Use `workspace:*` for internal package deps** (already used in `@orchestrace/*`).
- **Run from repo root** for cross-package workflows:
  - `pnpm build`
  - `pnpm typecheck`
  - `pnpm test`
- **Use pnpm filters for targeted work**:
  - `pnpm --filter @orchestrace/core test`
  - `pnpm --filter @orchestrace/ui dev`
- **Keep Turborepo task graph aligned with real build dependencies** (`dependsOn: ["^build"]` for build/test/typecheck).
- **Declare deterministic Turbo outputs** (e.g., `dist/**`) for cache correctness.
- **Keep UI/backend ports explicit and stable** (UI Vite on `3000`, API backend on `4310` via proxy).
- **Pin toolchain versions** (`packageManager: pnpm@10.8.1`, TypeScript/Vite major versions pinned per package).
- **Use `pnpm install --frozen-lockfile` in CI** to guarantee lockfile reproducibility.

## DON'T

- **Don’t use `npm`/`yarn` in this repo**; always use pnpm.
- **Don’t use relative file imports across packages** (e.g. `../../core/src/...`); consume via package name.
- **Don’t replace `workspace:*` with hardcoded versions** for internal packages.
- **Don’t rely on implicit build order**; ensure scripts and Turbo `dependsOn` enforce it.
- **Don’t cache long-running dev tasks** (`dev` should stay `cache: false`, `persistent: true`).
- **Don’t commit generated `dist/` artifacts** unless policy explicitly changes.
- **Don’t bypass pre-hooks** for package-local test/typecheck in library packages.

---

## Configuration

### 1) pnpm workspace and root discipline

Current workspace scope is intentionally tight:

```yaml
# pnpm-workspace.yaml
packages:
  - 'packages/*'
```

Use this dependency pattern for internal packages:

```json
{
  "dependencies": {
    "@orchestrace/core": "workspace:*"
  }
}
```

Recommended CI install:

```bash
pnpm install --frozen-lockfile
```

### 2) Turborepo pipeline conventions

Current root config is a good baseline:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] },
    "dev": { "cache": false, "persistent": true }
  }
}
```

Recommended enhancement for Vite UI cache accuracy (optional but useful):

```json
{
  "tasks": {
    "build": {
      "outputs": ["dist/**"]
    },
    "build#@orchestrace/ui": {
      "outputs": ["dist/**"]
    }
  }
}
```

(Keep outputs explicit for any package that writes outside defaults.)

### 3) Vite app configuration

Current UI proxy setup is correct for local full-stack development:

```ts
// packages/ui/vite.config.ts
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4310',
        changeOrigin: true,
      },
    },
  },
})
```

Recommended hardening for monorepo ergonomics:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.ORCHESTRACE_API_URL ?? 'http://127.0.0.1:4310',
        changeOrigin: true,
      },
    },
  },
})
```

### 4) TypeScript package boundaries

For library packages (`core`, `provider`, `context`, etc.):

- keep `main/types` pointing at `dist/*`
- run `tsc` for `build`
- run `tsc --noEmit` for `typecheck`

Pattern already used:

```json
{
  "scripts": {
    "build": "tsc",
    "pretypecheck": "pnpm --filter @orchestrace/core... build",
    "typecheck": "tsc --noEmit"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts"
}
```

---

## Project-specific notes

1. **This repo intentionally builds dependencies before test/typecheck**
   - Root: `pretest` and `pretypecheck` build key dependencies first.
   - Package level: `pretest` / `pretypecheck` with `pnpm --filter <pkg>... build`.

2. **UI is the only Vite package right now**
   - `packages/ui` runs `vite` for dev and `tsc -b && vite build` for prod builds.
   - Keep UI concerns isolated; don’t leak browser-specific deps into server packages.

3. **Top-level dev/start workflows are orchestrated**
   - `pnpm start` already coordinates backend CLI + frontend UI, including health-check wait loop.
   - Prefer this over ad-hoc parallel terminals when verifying integrated behavior.

4. **Security/perf stance on build-time binaries is explicit**
   - `onlyBuiltDependencies` is pinned for `esbuild` and `protobufjs` in both `package.json` and `.npmrc`.
   - Keep this list minimal and reviewed.

5. **Testing conventions**
   - Root Vitest includes `packages/*/tests/**/*.test.ts`.
   - When filtering package tests, keep the `--` separator before Vitest args.

---

## Practical commands & examples

### Targeted dependency-aware build

```bash
# Build a package and everything it depends on in workspace graph
pnpm --filter @orchestrace/cli... build
```

### Run one package test file correctly

```bash
pnpm --filter @orchestrace/tools test -- tests/toolset.test.ts
```

### Fast local loop for UI + API

```bash
# Repo-provided integrated workflow
pnpm start

# Or separate
pnpm --filter @orchestrace/cli dev ui --port 4310
pnpm --filter @orchestrace/ui dev
```

### CI-friendly sequence

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

---

## Suggested baseline checklist (copy/paste)

- [ ] Internal deps use `workspace:*`
- [ ] New package has `build`, `typecheck`, `test`, `clean` scripts
- [ ] Library package emits to `dist/` and exports from `dist/*`
- [ ] `pretypecheck`/`pretest` enforce dependency build where needed
- [ ] Turbo outputs include all generated artifacts
- [ ] Vite dev server ports/proxy match backend defaults
- [ ] CI uses `pnpm install --frozen-lockfile`
- [ ] No cross-package `src/` deep imports