# TypeScript Best Practices

## Overview

Orchestrace uses strict TypeScript with ESM-oriented settings from `tsconfig.base.json`:

- `target: ES2023`
- `module: ESNext`
- `moduleResolution: bundler`
- `strict: true`
- `isolatedModules: true`
- `verbatimModuleSyntax: true`

The baseline strategy is: maximize static guarantees, minimize implicit behavior, and keep emitted JS predictable.

## Configuration Best Practices

### Prefer a single base config + package-level extension

Use `tsconfig.base.json` as source of truth and keep package-level overrides minimal.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

### Keep `strict: true` and treat relaxations as explicit tradeoffs

If a package needs temporary exceptions, isolate them locally with comments and TODOs.

### Use `verbatimModuleSyntax` correctly

When importing types, always use `import type`.

```ts
import type { Session } from './types.js';
import { createSession } from './session.js';
```

## Type Safety Patterns

### Prefer `unknown` over `any`

```ts
function parseJson(input: string): unknown {
  return JSON.parse(input);
}

function isUser(value: unknown): value is { id: string } {
  return typeof value === 'object' && value !== null && 'id' in value;
}
```

### Use discriminated unions for state machines

```ts
type RunState =
  | { kind: 'idle' }
  | { kind: 'running'; startedAt: number }
  | { kind: 'failed'; error: string }
  | { kind: 'done'; resultPath: string };

function renderState(state: RunState): string {
  switch (state.kind) {
    case 'idle':
      return 'Idle';
    case 'running':
      return `Running since ${state.startedAt}`;
    case 'failed':
      return `Failed: ${state.error}`;
    case 'done':
      return `Done: ${state.resultPath}`;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}
```

### Use `as const` to preserve literals

```ts
const ALLOWED = ['plan', 'code', 'test'] as const;
type NodeType = (typeof ALLOWED)[number];
```

## Module System (ESM-first)

- Keep package `