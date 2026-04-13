# TypeScript Tooling Best Practices

## Overview

This guide covers **advanced TypeScript configuration** and runtime/tooling choices used in this repo, with emphasis on:

- Shared `tsconfig` architecture in a monorepo
- Safe usage of `tsx` for local/dev script execution
- Correct management of:
  - `@types/node`
  - `@types/react`
  - `@types/react-dom`

The goal is predictable builds, clean editor IntelliSense, and minimal cross-package type leakage.

---

## DO

- **Use a layered `tsconfig` strategy**:
  - Keep cross-repo defaults in `tsconfig.base.json`.
  - Add package-local overrides (`tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`) for environment-specific types and libs.
- **Prefer strictness-first defaults** (`strict`, `isolatedModules`, `verbatimModuleSyntax`) and only relax rules with package-specific justification.
- **Scope ambient types explicitly** when needed:
  - Use `types: ["node"]` in Node-only configs (e.g., `tsconfig.node.json`).
  - Avoid exposing Node globals in browser bundles.
- **Pin compatible major versions** between runtime libraries and type packages:
  - `react` ↔ `@types/react`
  - `react-dom` ↔ `@types/react-dom`
  - Node runtime target ↔ `@types/node`
- **Use `tsx` for fast iteration and operational scripts**, not as a replacement for production build output.
- **Separate typecheck from execution**:
  - `tsc --noEmit` for CI/type safety
  - `tsx` for local script runtime
- **Keep module semantics consistent** across repo (`"type": "module"`, `module: "ESNext"`, `moduleResolution: "bundler"` where bundler-driven).

---

## DON'T

- **Don’t use one universal `tsconfig` for browser + Node + tooling**. It causes incorrect libs/types (`DOM` vs Node globals) and false IntelliSense.
- **Don’t rely on implicit global types** from transitive dependencies.
  - If a package needs Node globals, declare them via `types` and package deps.
- **Don’t treat `skipLibCheck` as a fix** for incompatible type package versions.
  - It can hide real breakage until runtime or publish time.
- **Don’t execute production CLIs directly with `tsx` in deployment paths**.
  - Build with `tsc` and run emitted JS for reproducibility.
- **Don’t drift TypeScript versions heavily between packages** without validation.
  - Mixed compiler behavior can produce inconsistent diagnostics.
- **Don’t include `@types/react*` in non-React packages**.
  - Keep dependency surface package-local.

---

## Configuration

### 1) Base config (repo-wide)

Use base config for shared language behavior only:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "esModuleInterop": true
  }
}
```

**Recommended additions for advanced setups (case-by-case):**

- `exactOptionalPropertyTypes: true`
- `noUncheckedIndexedAccess: true`
- `noImplicitOverride: true`
- `useUnknownInCatchVariables: true`

### 2) Browser React app config

For React UI packages, include DOM libs and JSX transform:

```json
{
  "compilerOptions": {
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "moduleResolution": "bundler",
    "noEmit": true,
    "strict": true
  }
}
```

Keep React type dependencies in that package:

```json
{
  "devDependencies": {
    "@types/react": "^19.x",
    "@types/react-dom": "^19.x"
  }
}
```

### 3) Node/tooling config

For Node-specific files (e.g., `vite.config.ts`, scripts):

```json
{
  "compilerOptions": {
    "lib": ["ES2023"],
    "types": ["node"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmit": true
  }
}
```

This prevents accidental mixing of DOM globals into server/tool code.

### 4) `tsx` usage pattern

Good pattern:

```json
{
  "scripts": {
    "dev": "tsx src/index.ts",
    "run": "tsx src/run-evals.ts",
    "typecheck": "tsc --noEmit",
    "build": "tsc"
  }
}
```

Use `tsx` for:

- local CLIs
- eval runners
- utility scripts
- tests bootstrap scripts

Use compiled JS for:

- published binaries
- production entrypoints
- reproducible CI runtime stages

---

## Project-specific notes and examples

### A) Monorepo baseline

Current repo baseline is strong:

- Root `tsconfig.base.json` already sets strict ESM-oriented options (`strict`, `isolatedModules`, `verbatimModuleSyntax`, `moduleResolution: "bundler"`).
- Root `package.json` includes shared tooling (`typescript`, `tsx`, `@types/node`).

**Best practice:** keep root types minimal and avoid assuming root dev dependencies satisfy package-local type needs.

### B) UI package (`packages/ui`)

The UI package correctly keeps React typings local:

- `@types/react`
- `@types/react-dom`
- local `@types/node` for tooling config

It also splits configs:

- `tsconfig.app.json` for browser app code (`DOM`, `react-jsx`)
- `tsconfig.node.json` for Node config files (`types: ["node"]`)

**Keep this split.** It is the right pattern for Vite + React projects.

### C) CLI and evals (`packages/cli`, `packages/evals`)

Both packages use `tsx` for local execution workflows:

- `packages/cli`: `dev` via `tsx src/index.ts`
- `packages/evals`: `run` via `tsx src/run-evals.ts`

**Recommended refinement:** ensure each Node-runtime package has explicit Node typing via either:

1. local `@types/node` in `devDependencies`, and/or
2. `types: ["node"]` in package `tsconfig`

This avoids dependence on hoisted workspace state and improves portability.

### D) Version alignment matrix

Use this rule:

- React 19.x → `@types/react` 19.x
- ReactDOM 19.x → `@types/react-dom` 19.x
- Node runtime target (e.g., Node 22/24 in CI/dev) → matching modern `@types/node` major

When upgrading major versions, do it as one change set:

1. runtime package
2. corresponding `@types/*`
3. TypeScript compiler if required
4. full `typecheck` + test run

### E) Example: clean package-local TypeScript setup (Node package)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023"],
    "types": ["node"],
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["src"]
}
```

And package manifest:

```json
{
  "devDependencies": {
    "typescript": "^5.9.0",
    "tsx": "^4.0.0",
    "@types/node": "^24.0.0"
  }
}
```

---

## Quick checklist

- [ ] Shared defaults in root `tsconfig.base.json`
- [ ] Browser and Node configs split where both environments exist
- [ ] `types` explicitly scoped for Node-only contexts
- [ ] React type packages only in React packages
- [ ] `tsx` used for dev/runtime convenience, not production build artifacts
- [ ] Runtime libraries and `@types/*` majors kept in sync
- [ ] `tsc --noEmit` enforced in CI for every package