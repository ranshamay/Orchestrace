# Type Definitions (`@types/*`)

Type definition packages should be treated as first-class build inputs in this monorepo.

## Current repo shape

- Root uses:
  - `typescript@^5.6.0`
  - `@types/node@^22.0.0`
- UI package currently uses newer TS/type stack (including `typescript~5.9.3` and `@types/node^24`).

This split can work, but increases risk of editor/build mismatch if shared code or configs cross boundaries.

## Recommended alignment policy

For workspace-wide consistency:

1. Prefer a single TypeScript version baseline across packages.
2. Prefer a single `@types/node` major matching the Node runtime used in CI/dev.
3. Keep framework-specific type packages local to framework packages:
   - `@types/react`, `@types/react-dom` in UI package only.

## Practical package patterns

### Node package (library/CLI)

```json
{
  "type": "module",
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/node": "^22.0.0"
  }
}
```

### React package

```json
{
  "type": "module",
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0"
  }
}
```

## ESM + types best practices

- Keep `"type": "module"` in each ESM package.
- Use explicit `import`/`export` syntax only.
- Emit declarations (`declaration: true`) for reusable packages.
- Export types from package entrypoints so downstream packages avoid deep type imports.

## Monorepo safeguards

- Use workspace protocol for internal deps (`"@orchestrace/*": "workspace:*"`).
- Run typecheck at workspace level (`turbo typecheck`) and package level (`tsc --noEmit`).
- When upgrading TypeScript or `@types/node`, do it as a coordinated monorepo change.

## Upgrade playbook

1. Pick target versions (TS + `@types/node`) compatible with current Node runtime.
2. Update root + package overrides together.
3. Run `pnpm install`, `pnpm typecheck`, and package tests.
4. Fix new strictness/type errors before merging.