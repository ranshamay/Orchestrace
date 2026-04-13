# pnpm Workspaces Best Practices

## Overview

`pnpm` workspaces provide fast, deterministic dependency management for monorepos. The biggest wins come from explicit workspace relationships, immutable installs in CI, and precise filtered execution.

This guide emphasizes reproducibility, safe dependency boundaries, and efficient package-level workflows.

## Key Principles

- **Use the workspace protocol** for internal package dependencies.
- **Keep installs deterministic** with a committed lockfile and frozen CI installs.
- **Run targeted commands** with `--filter` to reduce unnecessary work.
- **Avoid hidden dependency coupling** through hoisting assumptions.
- **Keep root and package scripts intentional** to preserve clear ownership.

## Best Practices

### 1) Reference internal packages with `workspace:*`

**DO**

```json
{
  "name": "@orchestrace/cli",
  "dependencies": {
    "@orchestrace/core": "workspace:*",
    "@orchestrace/provider": "workspace:*"
  }
}
```

**DON'T**

```json
{
  "dependencies": {
    "@orchestrace/core": "^1.0.0"
  }
}
```

### 2) Use filtered commands intentionally

**DO**

```bash
# Build a package and its local dependents/dependencies as needed
pnpm --filter @orchestrace/cli... build

# Pass args after -- when invoking underlying tools
pnpm --filter @orchestrace/tools test -- tests/toolset.test.ts
```

**DON'T**

```bash
# Runs much more than intended
pnpm -r test

# Missing -- can swallow arguments
pnpm --filter @orchestrace/tools test tests/toolset.test.ts
```

### 3) Keep CI installs immutable

**DO**

```bash
pnpm install --frozen-lockfile
```

**DON'T**

```bash
# Can mutate lockfile in CI and hide drift
pnpm install
```

### 4) Add dependencies at the correct scope

**DO**

```bash
# root tooling dependency
pnpm add -D -w turbo

# package runtime dependency
pnpm --filter @orchestrace/cli add yargs
```

**DON'T**

```bash
# Adds dependency to wrong package/root by accident
pnpm add yargs
```

### 5) Restrict postinstall/build scripts to trusted dependencies

**DO**

```yaml
# .npmrc
onlyBuiltDependencies:
  - esbuild
  - protobufjs
```

**DON'T**

```yaml
# Broadly allows arbitrary install scripts from all dependencies
ignore-scripts: false
```

## Common Mistakes

- Publishing/depending on internal packages with semver ranges instead of `workspace:*`.
- Running recursive commands when only one package changed.
- Installing dependencies from the wrong directory/scope.
- Letting lockfile drift between local and CI.
- Assuming hoisted transitive dependencies are always available.

## Checklist

- [ ] `pnpm-workspace.yaml` includes all intended packages.
- [ ] Internal dependencies use `workspace:*`.
- [ ] CI uses `pnpm install --frozen-lockfile`.
- [ ] Root vs package dependency additions are done explicitly.
- [ ] `--filter` is used for package-targeted build/test flows.
- [ ] Tool arguments are passed with `--` when required.
- [ ] Lockfile changes are reviewed as part of PRs.