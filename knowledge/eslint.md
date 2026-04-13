# ESLint (Flat Config) Best Practices

## Overview
ESLint is the primary static-analysis linter for this monorepo. The repo uses ESLint 9 flat config (`eslint.config.js`) and composes rule presets with scoped overrides.

## Current Orchestrace Pattern
- Root config uses `typescript-eslint` and `tseslint.configs.recommended`.
- Global ignores are declared in flat config (not `.eslintignore`).
- TypeScript package sources are targeted with `files` globs and rule relaxations:
  - `@typescript-eslint/no-unused-vars` allows `_` prefixes.
  - `@typescript-eslint/no-explicit-any` is `warn`.

## Flat Config Composition Principles
1. **Start with ignore-only entry first** so expensive file trees are skipped early.
2. **Compose shared presets next** (`...tseslint.configs.recommended`).
3. **Add narrow file-scoped overrides last** for package- or runtime-specific policy.
4. **Prefer additive config blocks over giant monolithic rule maps**.

```js
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/*.config.*'] },
  ...tseslint.configs.recommended,
  {
    files: ['packages/*/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
```

## ✅ Do / ❌ Don’t

### ✅ Do: Scope rules with `files`
```js
{ files: ['packages/ui/src/**/*.{ts,tsx}'], rules: { 'no-console': 'warn' } }
```

### ❌ Don’t: Apply app-specific rules globally
```js
{ rules: { 'react-refresh/only-export-components': 'error' } } // affects non-React packages
```

### ✅ Do: Keep ignores in flat config
```js
{ ignores: ['**/dist/**', '**/coverage/**'] }
```

### ❌ Don’t: Rely on deprecated `.eslintignore`

## Monorepo Guidance
- Keep root config minimal and language-focused.
- Put framework/runtime plugins (React, browser globals, Vite) in package-local config.
- Standardize severity strategy:
  - `error` for correctness/safety issues.
  - `warn` for migration and ergonomics rules.

## Migration Notes (Legacy → Flat)
- Replace `extends` chains from `.eslintrc` with ordered config array entries.
- Replace `overrides` with flat config blocks containing `files`.
- Replace `.eslintignore` with `ignores` / `globalIgnores`.

## Performance Practices
- Keep `files` globs tight (`src/**`) instead of `**/*` where possible.
- Avoid type-aware linting globally unless needed (use selective blocks).
- Exclude generated files and build output aggressively.

## Common Pitfalls
- Wrong config order causing later presets to override custom rules.
- Over-broad globs accidentally linting transpiled output.
- Mixing Node/browser globals in one shared block.

## Practical Policy for This Repo
- Use root config for baseline TypeScript safety.
- Use package configs for React and Vite-specific rules.
- Keep lint and format responsibilities separate (Prettier handles formatting).