# Node.js Best Practices

Node.js is the runtime backbone for tooling, scripts, and services in this repository.

## Core Principles

- Design for reliability: clear startup, health, shutdown paths.
- Keep I/O non-blocking and error handling explicit.
- Use ESM-native APIs and patterns.
- Minimize global process side effects.

## Do / Don't

### 1) Handle shutdown signals gracefully

```js
// ✅ Do
const server = app.listen(port, () => {
  console.log(`Listening on ${port}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}`);
  server.close((err) => {
    if (err) {
      console.error(err);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
```

```js
// ❌ Don't
process.on("SIGTERM", () => process.exit(0));
```

### 2) Use streaming for large files

```js
// ✅ Do
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const rl = createInterface({ input: createReadStream("large.log") });
for await (const line of rl) {
  // process line
}
```

```js
// ❌ Don't
import { readFileSync } from "node:fs";
const content = readFileSync("large.log", "utf8");
```

### 3) Fail fast on invalid configuration

```js
// ✅ Do
function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}
```

```js
// ❌ Don't
const apiKey = process.env.API_KEY || ""; // hides misconfiguration
```

## Pitfalls

- Blocking APIs (`*Sync`) in request or job loops.
- Swallowing errors inside `catch` without context.
- Assuming single-process state when deploying with multiple workers/instances.

## Performance Notes

- Reuse connections (HTTP keep-alive, DB pools).
- Avoid JSON parse/stringify cycles in tight loops.
- Use worker threads only for CPU-heavy tasks; prefer async I/O otherwise.

## Practical Checklist

- [ ] Signal handlers close resources cleanly.
- [ ] No blocking sync file/network operations in hot paths.
- [ ] Config validation happens at startup.
- [ ] Errors include actionable context.