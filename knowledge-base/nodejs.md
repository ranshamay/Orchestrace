# Node.js Best Practices

## Overview

Orchestrace runs on modern Node.js with ESM modules. Reliability and graceful process behavior are critical for long-running orchestration tasks.

## Configuration Best Practices

- Keep `"type": "module"` and ESM import style.
- Prefer async/await to callback chains.
- Use `AbortController` for cancellable operations.

## Best Practices

### Async + cancellation

```ts
const controller = new AbortController();
const t = setTimeout(() => controller.abort(), 10_000);
try {
  const res = await fetch(url, { signal: controller.signal });
  return await res.json();
} finally {
  clearTimeout(t);
}
```

### Graceful shutdown

```ts
process.on('SIGTERM', async () => {
  await closeServer();
  process.exit(0);
});
```

### Environment safety

Validate required env vars at startup, fail fast with clear error messages.

### Streams for large payloads

Avoid loading large files fully into memory.

## Do and Don’t

### Do

- Use structured logs with context IDs.
- Propagate errors with useful metadata.
- Bound retries with exponential backoff.

### Don’t

- Swallow promise rejections.
- Use unbounded in-memory queues.
- Block event loop with CPU-heavy work in request paths.

## Common Pitfalls

- Missing signal handlers causing data loss on deploy restarts.
- Hidden race conditions in parallel writes.
- Retrying non-idempotent operations without safeguards.