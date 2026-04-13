# Prettier Best Practices

## Overview

Prettier enforces consistent formatting across contributors and automation.

Root scripts:

- `pnpm format` → `prettier --write "packages/*/src/**/*.ts"`
- `pnpm format:check` → `prettier --check "packages/*/src/**/*.ts"`

## Best Practices

- Use format-on-save in editor.
- Keep Prettier as the sole source of formatting truth.
- Run `format:check` in CI.
- Keep `.prettierignore` updated for generated artifacts.

## Suggested Configuration

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

## Do and Don’t

### Do

- Let Prettier handle code layout automatically.

### Don’t

- Manually reformat code in ways that fight Prettier.
- Mix style rules in ESLint that conflict with Prettier intent.

## Common Pitfalls

- Partial formatting scope that excludes important files.
- CI failures from editor not running Prettier on save.