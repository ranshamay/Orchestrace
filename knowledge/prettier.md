# Prettier Best Practices

## Overview
Prettier is the repo formatter. ESLint is for correctness and code-quality rules. Keep responsibilities separate:
- **Prettier**: formatting only.
- **ESLint**: bugs, unsafe patterns, architecture constraints.

## Current Orchestrace Pattern
- Root scripts:
  - `format`: `prettier --write "packages/*/src/**/*.ts"`
  - `format:check`: `prettier --check "packages/*/src/**/*.ts"`
- Linting runs independently via ESLint.

## Formatter/Linter Separation
1. Avoid stylistic ESLint rules that conflict with Prettier output.
2. Do not use Prettier for semantic correctness checks.
3. Keep CI stages distinct:
   - `pnpm lint`
   - `pnpm format:check`

## ✅ Do / ❌ Don’t

### ✅ Do: Let Prettier own whitespace, wrapping, commas
```ts
const data = { id: 1, name: 'alpha' };
```

### ❌ Don’t: Manually “align” formatting against Prettier
```ts
const data = { id: 1,    name: 'alpha' };
```

### ✅ Do: Run formatter before committing
```sh
pnpm format
```

### ❌ Don’t: Add ESLint style rules that duplicate Prettier
```js
'indent': ['error', 2], // generally unnecessary when Prettier is enforced
```

## Scope and Workflow Guidance
- Expand formatting globs as more file types are standardized (tsx, md, json).
- Use `format:check` in CI to enforce deterministic formatting.
- If teams need file-specific behavior, prefer `.prettierignore` and minimal overrides.

## Common Pitfalls
- Expecting Prettier to catch unused vars or unsafe TypeScript patterns.
- Running only lint in CI and forgetting format checks.
- Combining formatter-like ESLint rules that cause churn.

## Practical Policy for This Repo
- Prettier is the canonical formatter.
- ESLint remains focused on correctness and maintainability.
- Keep both fast and predictable by avoiding overlap.