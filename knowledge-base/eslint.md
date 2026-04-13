# ESLint & typescript-eslint Best Practices

## Overview

Orchestrace uses ESLint flat config and `typescript-eslint` at root, plus a UI-specific flat config with React plugins.

## Repo Configuration Highlights

### Root (`eslint.config.js`)

- Ignores `node_modules`, `dist`, and config files.
- Uses `typescript-eslint` recommended rules.
- Relaxes:
  - `@typescript-eslint/no-unused-vars` with `_` ignore pattern.
  - `@typescript-eslint/no-explicit-any` as warning.

### UI (`packages/ui/eslint.config.js`)

- `@eslint/js` recommended
- `typescript-eslint` recommended
- `react-hooks` recommended
- `react-refresh` Vite config

## Best Practices

- Treat warnings as actionable debt, not noise.
- Keep shared rule philosophy documented.
- Use targeted overrides per folder/package.
- Prefer lint autofix for style-level issues, not logic changes.

## Do and Don’t

### Do

```ts
function handler(_unused: string, value: number) {
  return value;
}
```

### Don’t

```ts
// disabling without explanation
// eslint-disable-next-line
const x = risky();
```

## Common Pitfalls

- Confusing lint and format responsibilities.
- Blanket disabling of rules instead of local refactor.
- Inconsistent editor integration across contributors.