# Dev Process Tooling Best Practices

This guide covers process orchestration and environment management practices for `concurrently` and `dotenv` in Node.js monorepos.

## Overview

`concurrently` and `dotenv` are deceptively simple tools that become reliability-critical as soon as you run multiple processes (web app, API, workers, watchers) and multiple environments (local dev, CI, staging, production).

Your objective is to keep scripts:

- deterministic
- observable
- environment-safe
- easy to run for every contributor

---

## Key Principles

1. **Single source of truth for scripts**: define startup behavior in package scripts, not tribal knowledge.
2. **Fail fast and fail together**: if one critical process crashes, stop the whole dev command.
3. **Explicit env loading**: load only what you need, from the right file, in the right scope.
4. **No secret leakage**: treat `.env` files as sensitive and avoid printing secret values.
5. **Cross-platform execution**: avoid shell-specific tricks in scripts when possible.
6. **Environment parity**: local scripts should resemble CI behavior enough to catch integration issues early.

---

## Best Practices

## 1) Use named, colored, and grouped `concurrently` processes

Readable logs are non-negotiable when multiple processes run in parallel.

### ✅ DO

```json
{
  "scripts": {
    "dev": "concurrently -k --names web,api --prefix-colors cyan,magenta \"pnpm --filter @orchestrace/web dev\" \"pnpm --filter @orchestrace/api dev\""
  }
}
```

Why:

- `--names` labels each process stream.
- `--prefix-colors` improves scanning speed.
- `-k` (`--kill-others`) ensures clean shutdown if one process fails.

### ❌ DON'T

```json
{
  "scripts": {
    "dev": "concurrently \"pnpm -r dev\" \"pnpm -r watch\""
  }
}
```

Problems:

- unreadable process ownership in logs
- too broad commands can recursively spawn conflicting watchers
- no explicit failure behavior

---

## 2) Set clear success/failure policy in concurrent runs

By default, teams often forget what “success” means when multiple jobs run.

### ✅ DO

```json
{
  "scripts": {
    "test:all": "concurrently --success first --kill-others-on-fail \"pnpm --filter @orchestrace/core test\" \"pnpm --filter @orchestrace/web test\""
  }
}
```

Use:

- `--kill-others-on-fail` for strict CI-like behavior.
- `--success` mode intentionally (`first`, `last`, `all`) based on workflow.

### ❌ DON'T

- Run long-lived and short-lived jobs together without defining completion semantics.
- Allow orphaned processes to keep running after a critical failure.

---

## 3) Keep commands shell-safe and cross-platform

### ✅ DO

- Quote each subcommand explicitly.
- Prefer Node-based helpers or package scripts over shell operators that differ across OS.
- Use `pnpm --filter` to target specific workspaces instead of brittle globbing.

```json
{
  "scripts": {
    "dev:focused": "concurrently -k \"pnpm --filter @orchestrace/web dev\" \"pnpm --filter @orchestrace/cli dev\""
  }
}
```

### ❌ DON'T

- Depend on Bash-specific constructs in package scripts if contributors use different shells.

```json
{
  "scripts": {
    "dev": "concurrently \"FOO=1 pnpm dev\" \"BAR=2 pnpm watch\""
  }
}
```

(Prefer environment-loading wrappers that work on all platforms.)

---

## 4) Load environment variables intentionally with `dotenv`

### ✅ DO

```ts
// scripts/run-task.ts
import 'dotenv/config'

const required = ['API_URL', 'NODE_ENV'] as const
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env: ${key}`)
  }
}

console.log('Environment validated. Running task...')
```

- Load env at process start.
- Validate required variables explicitly.
- Fail before side effects.

### ❌ DON'T

```ts
// ❌ Reads env lazily and never validates
if (process.env.ENABLE_TASK === 'true') {
  // ... side effects start
}
```

Problems:

- missing envs become runtime surprises
- difficult-to-debug behavior drift between machines

---

## 5) Use environment layering predictably

### ✅ DO

- Maintain clear file semantics:
  - `.env` for shared local defaults (non-secret when possible)
  - `.env.local` for developer overrides (gitignored)
  - `.env.test` for test runs
- Commit `.env.example` with all required keys and comments.
- Keep naming conventions consistent (`SERVICE_API_BASE_URL`, not mixed styles).

### ❌ DON'T

- Commit real secrets to `.env` files.
- Reuse production credentials in local files.
- Depend on “whatever env happens to exist in the shell.”

---

## 6) Protect secrets in logs and errors

### ✅ DO

```ts
function redact(value: string) {
  return value.length <= 6 ? '***' : `${value.slice(0, 3)}***${value.slice(-2)}`
}

console.log('API token loaded:', redact(process.env.API_TOKEN ?? ''))
```

- redact or omit sensitive values
- keep debug logs useful without leaking credentials

### ❌ DON'T

```ts
// ❌ Secret exposure risk
console.log('Loaded env:', process.env)
```

---

## 7) Make CI use the same process model as local where possible

### ✅ DO

- Reuse package scripts in CI (`pnpm run lint`, `pnpm run test`).
- Keep `concurrently`-based smoke scripts deterministic with strict fail settings.
- Ensure CI injects env via secret manager, not committed files.

### ❌ DON'T

- Maintain completely separate CI-only script logic unless necessary.
- Assume local success implies CI success when env setup differs.

---

## 8) Prefer small composable scripts over one giant command

### ✅ DO

```json
{
  "scripts": {
    "dev:web": "pnpm --filter @orchestrace/web dev",
    "dev:api": "pnpm --filter @orchestrace/api dev",
    "dev": "concurrently -k --names web,api \"pnpm dev:web\" \"pnpm dev:api\""
  }
}
```

Benefits:

- easier reuse
- targeted debugging
- less duplication

### ❌ DON'T

```json
{
  "scripts": {
    "dev": "concurrently -k --names web,api,worker,watcher,tests \"...very long inline command...\""
  }
}
```

(Too much inline complexity is hard to maintain and review.)

---

## Common Mistakes

1. Running multiple dev services without naming/prefixing logs.
2. Forgetting `-k` / kill policies, leaving stale orphan processes.
3. Relying on undeclared shell env values instead of explicit `dotenv` loading.
4. Committing real `.env` values or printing full `process.env` in logs.
5. Mixing long-lived daemons with one-shot commands in one `concurrently` invocation without success policy.
6. Writing OS-specific script syntax that breaks onboarding.

---

## Checklist

Use this during reviews for scripts and tooling changes.

- [ ] `concurrently` commands use names and readable prefixes.
- [ ] Failure policy is explicit (`-k`, `--kill-others-on-fail`, `--success`).
- [ ] Scripts are split into small, composable building blocks.
- [ ] `dotenv` loading happens at process start for scripts that need env files.
- [ ] Required env variables are validated before side effects.
- [ ] `.env.example` is up to date and documents required keys.
- [ ] Secrets are never logged or committed.
- [ ] CI script behavior matches local developer workflows where feasible.