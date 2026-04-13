# pnpm Workspaces (Orchestrace)

Use pnpm workspaces to manage all packages under a single lockfile and shared dependency graph.

## Repository Reality

- Workspace root is defined in `pnpm-workspace.yaml`:

```yaml
packages:
  - 'packages/*'
```

- All first-party packages live in `packages/` and use names like `@orchestrace/*`.
- Internal dependencies are linked via `workspace:*` (for example `@orchestrace/core`, `@orchestrace/provider`).
- Root package manager pin: `pnpm@10.8.1` in root `package.json`.

## Recommended Workflow

- Install once at root:

```bash
pnpm install
```

- Run filtered commands for a specific package:

```bash
pnpm --filter @orchestrace/ui dev
pnpm --filter @orchestrace/cli build
```

- Include dependents/dependencies when needed:

```bash
pnpm --filter @orchestrace/cli... build
```

## Do / Don’t

### Do

- **Do** declare internal package deps with `workspace:*`.
- **Do** run commands from repo root to keep lockfile/state consistent.
- **Do** use `--filter` for focused local iteration.
- **Do** keep package names stable (`@orchestrace/<name>`) to avoid broken filters.

### Don’t

- **Don’t** use relative `file:` links between workspace packages.
- **Don’t** run separate package-manager installs inside individual `packages/*` folders.
- **Don’t** commit changes that desync `package.json` and `pnpm-lock.yaml`.

## Common Pitfalls

- Missing package discovery because folder is outside `packages/*`.
- Accidentally publishing assumptions from `private: true` packages.
- Forgetting to build required internal packages before typecheck/test in packages with custom `pre*` scripts.

## Performance & CI Advice

- Prefer filtered installs/commands in CI jobs targeting changed packages.
- Keep dependency graph explicit; avoid hidden runtime coupling.
- Minimize redundant prebuild chains in package scripts where Turbo can already coordinate task dependencies.
- Use the shared lockfile as cache key input for dependency cache restoration.

## Quick Verification

```bash
pnpm -r list --depth -1
pnpm --filter @orchestrace/ui build
pnpm --filter @orchestrace/tools test
```