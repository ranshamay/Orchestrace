# typescript-eslint Best Practices

## Overview
`typescript-eslint` provides TypeScript parsing plus TS-specific lint rules. In this repo, it is the core linting layer in both root and UI package configs.

## Baseline Setup
- Parser: `tseslint.parser`
- Base rules: `tseslint.configs.recommended`
- Strict TS compiler options already exist in `tsconfig.base.json` (`strict`, `isolatedModules`, `verbatimModuleSyntax`).

## Config Tiers and When to Use
- `recommended`: syntax + non-type-aware correctness checks; fast default.
- `recommendedTypeChecked`: adds type-aware rules; better signal, slower.
- `strictTypeChecked`: stronger correctness constraints; use for mature codebases.
- `stylisticTypeChecked`: style-oriented TS rules (often redundant with Prettier + team conventions).

## Type-Aware Linting Tradeoffs

### Benefits
- Detects unsafe promise handling, misuse of `any`, incorrect narrowing assumptions.
- Catches bugs not visible from syntax-only linting.

### Costs
- Requires `parserOptions.project` and valid tsconfig graph.
- Higher memory and runtime in monorepos.
- More false positives during migrations or generated-type transitions.

## Recommended Monorepo Strategy
1. Keep `recommended` as repo-wide default.
2. Enable type-aware configs only for critical packages (e.g., UI/app surfaces).
3. Use package-local `project` settings and controlled globs.

```js
{
  files: ['packages/ui/src/**/*.{ts,tsx}'],
  extends: [tseslint.configs.recommendedTypeChecked],
  languageOptions: {
    parserOptions: {
      project: ['./packages/ui/tsconfig.app.json'],
      tsconfigRootDir: import.meta.dirname,
    },
  },
}
```

## ✅ Do / ❌ Don’t

### ✅ Do: Use `_` convention for intentionally unused values
```js
function handler(_event: Event, value: string) {
  return value;
}
```

### ❌ Don’t: Disable unused-vars globally
```js
'@typescript-eslint/no-unused-vars': 'off'
```

### ✅ Do: Downgrade migration-heavy rules to `warn` temporarily
```js
'@typescript-eslint/no-explicit-any': 'warn'
```

### ❌ Don’t: Turn off `no-explicit-any` forever without review

## Rule Customization Principles
- Prefer narrow exceptions over global disable.
- Use severity as migration tool (`warn` first, later `error`).
- Document why a relaxed rule exists.

## Common Pitfalls
- Using type-aware presets without `parserOptions.project`.
- Pointing `project` to overly broad tsconfig that includes build artifacts.
- Duplicating checks already enforced by `tsc` without clear value.

## Practical Policy for This Repo
- Root: fast `recommended` profile for all TS packages.
- UI or higher-risk packages: opt into type-aware linting when ready.
- Keep rule relaxations explicit and reviewed periodically.