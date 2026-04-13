# @mariozechner/pi-ai Best Practices

Use `@mariozechner/pi-ai` for model calls with explicit limits, deterministic request construction, and operational safeguards.

## Reliability & Request Discipline

- Set explicit request timeouts and enforce cancellation for long-running calls.
- Keep prompts deterministic:
  - stable system prompt
  - versioned templates
  - explicit output schema/instructions
- Validate model responses before downstream use (JSON parse + schema validation).
- Capture request/response metadata (model, latency, retry count, token usage, request id).

## Retries, Backoff, and Circuit Breaking

- Retry only transient failures (429, 5xx, network resets, timeout).
- Use exponential backoff with jitter and max-attempt caps.
- Do **not** retry non-transient errors (4xx auth/validation).
- Add circuit-breaker behavior to prevent cascading failures during provider incidents.

```ts
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

function shouldRetry(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  return status !== undefined && TRANSIENT_STATUS.has(status);
}
```

## Security & Data Protection

- Never hardcode API keys; load from environment/secret manager.
- Redact prompts/outputs in logs when they may contain PII/secrets.
- Enforce tenant/user scoping in prompts and request context.
- Treat model output as untrusted input; sanitize before rendering or execution.

## State Management

- Separate transient inference state (in-memory/request scope) from durable state (DB/event log).
- Store normalized artifacts:
  - prompt template version
  - model name/version
  - key generation parameters
  - output validation result
- Include correlation IDs for tracing across queue, API, and worker boundaries.

## Idempotency

- Generate an idempotency key from stable business inputs (userId + operation + payload hash).
- Persist completion markers to avoid duplicate side effects on retries.
- Ensure post-processing steps (DB writes, notifications) are idempotent.

## Observability

Track at minimum:

- success/error rate by model and route
- p50/p95 latency
- retry rate and final failure rate
- token usage and cost per request class
- schema-validation failure rate

## Do / Don’t

### Do

- Do enforce structured output contracts and validate them.
- Do bound token budgets and response sizes per endpoint.
- Do test degraded modes (provider timeout, invalid JSON, partial output).

### Don’t

- Don’t pass raw model output directly into privileged operations.
- Don’t run unbounded retries.
- Don’t log full prompts with secrets or regulated data.