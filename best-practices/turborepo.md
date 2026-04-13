# Turborepo Best Practices

## Overview

Turborepo accelerates monorepo workflows by modeling task dependencies and caching outputs. The quality of your `turbo.json` directly determines correctness and cache hit rate.

This guide focuses on making pipelines deterministic, incremental, and easy to reason about.

## Key Principles

- **Model task graph truthfully** (`dependsOn`, `outputs`, task intent).
- **Cache only deterministic tasks** and disable caching for watch/dev tasks.
- **Keep outputs explicit** so cache artifacts are valid and reusable.
- **Prefer small, composable tasks** over one large opaque command.
- **Use filtered execution** to run only impacted work.

## Best Practices

### 1) Declare accurate dependencies and outputs

**DO**

```json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["^build"]
    }
  }
}
```

**DON'T**

```json
{
  "tasks": {
    "build": {
      "outputs": []
    }
  }
}
```

### 2) Mark non-deterministic/persistent tasks as non-cacheable

**DO**

```json
{
  "tasks": {
    "dev": {
      "cache": false,
      "persistent": true
    },
    "clean": {
      "cache": false
    }
  }
}
```

**DON'T**

```json
{
  "tasks": {
    "dev": {
      "cache": true
    }
  }
}
```

### 3) Keep tasks hermetic and environment-aware

**DO**

```bash
# deterministic task inputs
pnpm turbo run build test --filter=@orchestrace/cli
```

```json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    }
  }
}
```

**DON'T**

```bash
# tasks that read undeclared mutable files or machine-local state
turbo run build  # while build script reads /tmp/random-input.txt
```

### 4) Align package scripts with pipeline stages

**DO**

```json
{
  "scripts": {
    "build": "turbo build",
    "typecheck": "turbo typecheck",
    "test": "turbo run test"
  }
}
```

**DON'T**

```json
{
  "scripts": {
    "ci": "turbo run build lint typecheck test dev"
  }
}
```

### 5) Use targeted runs in local development and CI

**DO**

```bash
pnpm turbo run build test --filter=@orchestrace/core
pnpm turbo run lint typecheck --filter=...[main]
```

**DON'T**

```bash
# Always running whole repo reduces Turborepo value
pnpm turbo run build test lint typecheck
```

## Common Mistakes

- Missing or incorrect `outputs`, causing cache misses or invalid restores.
- Caching `dev`/watch tasks that are inherently non-deterministic.
- Overloading a single task with multiple concerns.
- Running full monorepo pipelines for small changes.
- Hidden side effects (network/time/random files) inside cached tasks.

## Checklist

- [ ] Each task has correct `dependsOn` relationships.
- [ ] Build-like tasks declare precise `outputs`.
- [ ] `dev` and other persistent tasks have `cache: false`.
- [ ] Root scripts map cleanly to `build`, `lint`, `typecheck`, `test`, `dev`.
- [ ] Local/CI commands use `--filter` for changed scopes when possible.
- [ ] Cached tasks are deterministic and avoid hidden side effects.