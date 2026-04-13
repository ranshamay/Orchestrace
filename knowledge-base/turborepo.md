# Turborepo Best Practices

## Overview

Orchestrace uses Turborepo (`turbo.json`) to coordinate build, typecheck, lint, test, and dev tasks across packages.

## Current Pipeline Shape

- `build` depends on `^build`, outputs `dist/**`
- `typecheck` depends on `^build`
- `test` depends on `^build`
- `dev` is `persistent` and uncached

## Best Practices

### Define correct task dependencies

If package B imports package A’s built output, B’s task should depend on `^build`.

### Cache only deterministic tasks

- Cache `build`, `typecheck`, `test` when deterministic.
- Disable cache for long-running `dev` and cleanup tasks.

### Keep outputs accurate

Incorrect outputs reduce cache correctness and CI speed.

### Prefer small, composable scripts

Package scripts should do one thing; let Turbo orchestrate.

## Do and Don’t

### Do

```json
{
  "scripts": {
    "build": "tsc -b"
  }
}
```

### Don’t

```json
{
  "scripts": {
    "build": "rm -rf dist && generate-random && tsc -b"
  }
}
```

(Non-deterministic steps harm caching.)

## Common Pitfalls

- Missing `outputs` declarations.
- Over-caching tasks with environment-sensitive behavior.
- Hidden side effects in scripts that break cache replay.