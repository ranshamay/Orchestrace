# tsx Runner, @types Packages, and globals Best Practices

## Overview

Orchestrace uses `tsx` for script execution and `@types/*` packages for compile-time typing where runtime packages do not ship types.

## tsx Best Practices

- Use `tsx` for local script execution and rapid iteration.
- Prefer explicit script entrypoints over ad-hoc shell eval.

```bash
pnpm tsx get_log.ts
pnpm tsx smoke_test.ts
```

- For production builds, rely on compiled output where appropriate.

## @types Package Practices

- Keep `@types/node` aligned with Node major version used in CI/runtime.
- Keep `@types/react` and `@types/react-dom` aligned with React major.
- Treat `@types/*` as dev dependencies.

## `globals` Package (ESLint)

In flat config, use `globals.browser` / `globals.node` intentionally per target.

```js
languageOptions: {
  globals: globals.browser,
}
```

## Do and Don’t

### Do

- Keep script shebangs and usage docs clear.
- Separate runtime and type-only dependencies.

### Don’t

- Depend on outdated type packages.
- Assume browser globals in Node-targeted files.

## Common Pitfalls

- Version skew between runtime libs and type packages.
- Running tsx scripts with missing env assumptions.