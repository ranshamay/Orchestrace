# js-tiktoken Best Practices

Use `js-tiktoken` to preflight token budgets, avoid context-window overflows, and improve AI request reliability.

## Reliability & Budgeting

- Estimate token usage before API calls for:
  - system prompt
  - user context
  - tools/function schema
  - expected completion allowance
- Fail fast or truncate deterministically when budget is exceeded.
- Keep a safety margin (e.g., 10–20%) for provider-side tokenization variance.

```ts
import { encodingForModel } from "js-tiktoken";

const enc = encodingForModel("gpt-4o-mini");
const promptTokens = enc.encode(prompt).length;
const maxContext = 128000;
const responseBudget = 2000;

if (promptTokens + responseBudget > Math.floor(maxContext * 0.9)) {
  throw new Error("Token budget exceeded");
}
```

## Retries & Failure Handling

- Token estimation itself should not be retried aggressively; treat failures as local/config issues.
- On model `context_length_exceeded`, trigger deterministic reduction logic:
  - remove least-relevant context first
  - summarize historical turns
  - lower completion budget
- Record pre/post truncation token counts for diagnostics.

## Security

- Token counting can expose raw text; avoid logging full content.
- Store only aggregate metrics (counts, percentages), not sensitive payloads.
- Ensure shared utilities do not leak one tenant’s context into another’s budgeting pipeline.

## State Management

- Centralize token-budget rules in one module per app/service.
- Version budgeting policies (e.g., `budgetPolicy=v3`) to aid reproducibility.
- Cache static template token counts where possible for performance.

## Idempotency

- Truncation/summarization must be deterministic for identical inputs.
- Repeated processing of same payload should produce same budget decisions.
- Persist computed budget metadata alongside request ids for replay/debug.

## Do / Don’t

### Do

- Do test with multilingual and code-heavy content (tokenization differs).
- Do use per-model encoders (`encodingForModel`) rather than one-size-fits-all assumptions.
- Do reserve output tokens explicitly.

### Don’t

- Don’t assume characters ≈ tokens for production limits.
- Don’t silently drop critical context; log deterministic reason codes.
- Don’t ignore tool/function schema tokens in total budget.