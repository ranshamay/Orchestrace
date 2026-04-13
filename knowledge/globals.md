# globals (ESLint environment globals)

The `globals` package provides curated sets of runtime global variables for ESLint flat config.

## Current monorepo usage

Used in `packages/ui/eslint.config.js`:

```js
import globals from 'globals'

languageOptions: {
  ecmaVersion: 2020,
  globals: globals.browser,
}
```

This prevents false `no-undef` errors for browser globals like `window`, `document`, and `navigator`.

## Recommended usage pattern

Choose globals per execution environment:

```js
import globals from 'globals'

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['src/**/*.tsx'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
]
```

## ESM config guidance

- Keep ESLint config files ESM-compatible when package has `"type": "module"`.
- Use `import globals from 'globals'` instead of CommonJS `require`.
- Scope globals by file patterns so Node and browser assumptions do not leak into each other.

## Monorepo version alignment

- Prefer one `globals` version baseline for all packages that use ESLint flat config.
- Keep `eslint`, `typescript-eslint`, and `globals` versions compatible as a set.
- If a package needs a newer ESLint stack (like UI), isolate config there and avoid copying incompatible settings to Node-only packages.

## Common pitfalls

- Applying `globals.browser` to backend code (hides real undefined errors).
- Applying `globals.node` to frontend code (permits Node-only globals in browser code).
- Mixing old `.eslintrc` assumptions with flat-config-only plugins without compatibility checks.