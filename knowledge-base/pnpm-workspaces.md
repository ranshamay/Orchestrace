# pnpm Workspaces Best Practices

## Overview

This repo uses `pnpm-workspace.yaml` with `packages/*`. pnpm gives deterministic installs, workspace linking, and efficient monorepo dependency management.

## Workspace Configuration

```yaml
packages:
  - 'packages/*'
```

## Best Practices

### Use `workspace:` for internal dependencies

```json
{
  "dependencies": {
    "@orchestrace/core": "workspace:*"
  }
}
```

### Keep root scripts orchestration-focused

Use root scripts for cross-package workflows (`turbo build`, `turbo test`) and package scripts for local behavior.

### Use filtering for targeted work

```bash
pnpm --filter @orchestrace/ui dev
pnpm --filter @orchestrace/core... build
```

### Respect lockfile integrity

- Commit `pnpm-lock.yaml`
- Avoid manual lockfile edits

### onlyBuiltDependencies

Root `package.json` includes `pnpm.onlyBuiltDependencies`; keep this explicit and reviewed.

## Do and Don’t

### Do

- Keep dependency versions aligned for shared tooling.
- Prefer workspace protocol for internal packages.

### Don’t

- Duplicate internal code across packages.
- Install transitive-only deps directly without reason.

## Common Pitfalls

- Running commands in wrong workspace context.
- Version drift across package-level toolchains.
- Forgetting to build internal dependencies before typecheck/test in isolated workflows.