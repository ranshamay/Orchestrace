# Turborepo (Orchestrace)

Turborepo orchestrates tasks across `packages/*` with dependency-aware execution and caching.

## Repository Reality

Current `turbo.json` tasks:

- `build`: depends on `^build`, outputs `dist/**`
- `typecheck`: depends on `^build`
- `lint`: no explicit deps
- `test`: depends on `^build`
- `dev`: `cache: false`, `persistent: true`
- `clean`: `cache: false`

Root scripts call Turbo:

- `pnpm build` → `turbo build`
- `pnpm dev` → `turbo dev`
- `pnpm test` → `turbo run test`
- `pnpm typecheck` → `turbo typecheck`

## Task Design Guidance

- `build` should emit deterministic artifacts into `dist/` to match cache outputs.
- `dev` must remain uncached and persistent.
- `clean` should be uncached.
- Keep task inputs deterministic (source files, config, lockfile).

## Do / Don’t

### Do

- **Do** declare `outputs` for cacheable tasks (already done for `build`).
- **Do** ensure package build scripts write to `dist` consistently.
- **Do** rely on `^build` when tests/typechecks require built upstream packages.
- **Do** run `turbo run <task> --filter=<pkg>` for targeted work.

### Don’t

- **Don’t** mark long-running watchers as cacheable.
- **Don’t** write build artifacts outside declared outputs.
- **Don’t** add nondeterministic behavior (timestamps/random) into build outputs.

## Common Pitfalls

- Cache misses because outputs differ from `dist/**`.
- Redundant package-level prebuild scripts duplicating Turbo graph behavior.
- Assuming `lint` or other tasks have upstream deps when none are configured.

## Performance & Caching Advice

- Keep `build` pure and deterministic for high cache hit rates.
- Co-locate build outputs in `dist/` for all packages.
- Use Turbo filters in CI for changed scope plus dependents.
- Include lockfile/config changes in cache invalidation strategy.

## Useful Commands

```bash
pnpm turbo run build
pnpm turbo run test --filter=@orchestrace/core
pnpm turbo run typecheck --filter=@orchestrace/cli...
pnpm turbo run lint
```