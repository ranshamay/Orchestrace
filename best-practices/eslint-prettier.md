# ESLint 9 + TypeScript + React + Prettier Best Practices

## Overview

This guide covers a production-ready approach for:

- **ESLint 9 flat config** (`eslint.config.js` / `eslint.config.mjs`)
- **TypeScript linting** with `typescript-eslint`
- Base JavaScript rules from **`@eslint/js`**
- React correctness rules via **`eslint-plugin-react-hooks`**
- Fast Refresh safety via **`eslint-plugin-react-refresh`**
- Formatting with **Prettier 3**

Core principle: **Use ESLint for code-quality and correctness, use Prettier for formatting only.**

---

## DO

- **Use flat config only** (ESLint 9 default). Keep all lint logic in one exported config array.
- **Start from `@eslint/js` and `typescript-eslint` presets**, then add project-specific overrides.
- **Enable type-aware linting only where needed** (e.g., app/library `src`), not for every file in a monorepo.
- **Layer configs by file patterns**:
  - JS/TS shared base
  - TS-only rules
  - React-only rules (`tsx`)
  - test/tooling overrides
- **Use `react-hooks` recommended rules** to prevent stale closure and dependency bugs.
- **Use `react-refresh/only-export-components`** in Vite/React projects to avoid Fast Refresh breakage.
- **Run Prettier separately** (`prettier --write` / `--check`) and let ESLint focus on non-formatting rules.
- **Ignore generated/build artifacts** (`dist`, `coverage`, generated code, declaration bundles).
- **Keep rule severity intentional**:
  - `error` for correctness/safety
  - `warn` for migration ergonomics and team adoption

---

## DON'T

- Don’t use legacy `.eslintrc*` in new ESLint 9 setups.
- Don’t turn on every strict `typescript-eslint` rule globally on day 1—adopt in phases.
- Don’t run type-aware rules across huge globs (performance killer).
- Don’t duplicate formatter rules in ESLint while also using Prettier.
- Don’t disable `react-hooks/exhaustive-deps` broadly; fix code shape first.
- Don’t rely on linting `node_modules`, build output, or config transpilation artifacts.
- Don’t overuse inline `eslint-disable`; prefer narrow scoped config overrides with comments.

---

## Configuration

## 1) Install

```bash
pnpm add -D eslint @eslint/js typescript-eslint eslint-plugin-react-hooks eslint-plugin-react-refresh prettier
```

## 2) Example ESLint 9 flat config

> Use this as a strong baseline for TS + React monorepos.

```js
// eslint.config.js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/*.gen.*',
    ],
  },

  // Base JS recommendations
  js.configs.recommended,

  // TypeScript recommendations (non type-aware)
  ...tseslint.configs.recommended,

  // Type-aware rules only for app/library source
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    extends: [...tseslint.configs.recommendedTypeChecked],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // React hooks + Fast Refresh
  {
    files: ['packages/*/src/**/*.{tsx,jsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // Node/tooling files
  {
    files: ['**/*.{config,setup}.{js,ts,mjs,cjs}'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
    },
  }
);
```

## 3) Prettier setup

Create `.prettierrc` (minimal, stable):

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

Create `.prettierignore`:

```txt
node_modules
dist
build
coverage
.turbo
pnpm-lock.yaml
```

Package scripts:

```json
{
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  }
}
```

---

## Project-specific notes (this repo)

- Current repo already uses **flat config** and `typescript-eslint` with a relaxed baseline (`no-unused-vars`, `no-explicit-any` as warnings).
- Current lint target is mostly `packages/*/src/**/*.ts`; if UI React code exists (or is added), extend globs to include `tsx` and apply React plugins only there.
- Keep existing ignore strategy (`node_modules`, `dist`, `*.config.*`) and add more generated folders as needed (`coverage`, `.turbo`).
- Prefer **incremental strictness**:
  1. Keep migration-friendly warnings.
  2. Fix hot paths and recurring issues.
  3. Promote stable rules to `error`.
- For monorepo performance, avoid turning on type-aware linting for non-source folders (scripts, infra, examples) unless required.

---

## Examples

### Example A: Scoped relax rules for migration

```js
{
  files: ['packages/legacy/src/**/*.ts'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/ban-ts-comment': 'warn'
  }
}
```

### Example B: Enforce stricter rules in core package

```js
{
  files: ['packages/core/src/**/*.ts'],
  rules: {
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }]
  }
}
```

### Example C: React refresh-safe export pattern

```tsx
// ✅ preferred
export function Widget() {
  return <div />;
}

export const WIDGET_VERSION = '1.0.0'; // allowed with allowConstantExport

// ❌ avoid exporting non-component mutable values from component modules
```

### Example D: Hooks dependency correctness

```tsx
useEffect(() => {
  fetchData(userId);
}, [userId]); // include all external values used inside effect
```

---

## Practical adoption checklist

- [ ] Flat config only, no `.eslintrc*`
- [ ] `@eslint/js` + `typescript-eslint` presets in place
- [ ] Type-aware linting scoped to `src`
- [ ] React hooks + react-refresh enabled for `tsx/jsx`
- [ ] Prettier run separately (not competing with ESLint)
- [ ] Ignores set for generated/build artifacts
- [ ] Rule severities aligned with team migration stage