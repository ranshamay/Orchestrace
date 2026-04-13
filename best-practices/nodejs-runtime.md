# Node.js Runtime Best Practices

## Overview

A reliable Node.js runtime strategy keeps local development, CI, and production behavior consistent. In a monorepo, runtime drift (different Node versions, mixed module systems, unbounded process behavior) is a common source of flaky builds and hard-to-reproduce bugs.

This guide focuses on reproducibility, operational safety, and performance for modern Node.js projects.

## Key Principles

- **Pin runtime versions** so every environment executes the same engine.
- **Prefer one module strategy** (ESM or CJS) per package and avoid accidental mixing.
- **Fail fast on config/runtime errors** instead of silently continuing.
- **Design for process lifecycle** (startup, health checks, graceful shutdown).
- **Make async behavior explicit** with cancellation, timeouts, and structured error handling.

## Best Practices

### 1) Pin Node and package manager versions

**DO**

```json
{
  "name": "orchestrace",
  "type": "module",
  "packageManager": "pnpm@10.8.1",
  "engines": {
    "node": ">=22.0.0 <23"
  }
}
```

```bash
corepack enable
corepack prepare pnpm@10.8.1 --activate
node --version
pnpm --version
```

**DON'T**

```json
{
  "engines": {
    "node": "latest"
  }
}
```

### 2) Keep module format consistent and explicit

**DO**

```ts
// ESM package
import { readFile } from 'node:fs/promises';

export async function loadConfig(path: string) {
  return JSON.parse(await readFile(path, 'utf8'));
}
```

**DON'T**

```ts
// Mixed CJS + ESM patterns in the same package
const fs = require('fs');
export const loadConfig = () => fs.readFileSync('config.json', 'utf8');
```

### 3) Validate environment/config at startup

**DO**

```ts
const required = ['ORCHESTRACE_AUTH_FILE'];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}`);
  }
}
```

**DON'T**

```ts
// Delayed null/undefined failures during runtime
const authFile = process.env.ORCHESTRACE_AUTH_FILE!;
```

### 4) Handle shutdown signals gracefully

**DO**

```ts
const shutdown = async (signal: string) => {
  console.log(`received ${signal}, shutting down`);
  await server.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
```

**DON'T**

```ts
process.on('SIGTERM', () => {
  // Immediate exit can drop in-flight work and logs
  process.exit(0);
});
```

### 5) Use timeouts and cancellation for external calls

**DO**

```ts
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5_000);

try {
  const res = await fetch(url, { signal: controller.signal });
  return await res.json();
} finally {
  clearTimeout(timeout);
}
```

**DON'T**

```ts
// Can hang forever depending on network/provider behavior
const res = await fetch(url);
```

## Common Mistakes

- Depending on globally installed Node/pnpm instead of pinned versions.
- Mixing CJS and ESM within one package without a clear boundary.
- Relying on non-null assertions for env vars instead of validation.
- Ignoring `SIGTERM`/`SIGINT` and abruptly terminating processes.
- Running unbounded async operations without timeout/cancellation controls.

## Checklist

- [ ] Node version is pinned and enforced (`engines`, `.nvmrc`/tooling).
- [ ] `packageManager` is pinned and Corepack is used.
- [ ] Module system is consistent per package (no accidental CJS/ESM mixing).
- [ ] Startup validates required environment/config values.
- [ ] Graceful shutdown exists for signals and closes resources cleanly.
- [ ] External I/O has explicit timeout + cancellation behavior.
- [ ] Runtime errors are surfaced with actionable logs.