# AI & Token Tooling Best Practices (@mariozechner/pi-ai, js-tiktoken)

## Overview

Orchestrace uses `@mariozechner/pi-ai` for provider-agnostic LLM access and `js-tiktoken` for token-aware budgeting.

## LLM Integration Best Practices

### Define typed request/response boundaries

```ts
type ChatRequest = { prompt: string; model: string };
type ChatResponse = { text: string; usage?: { prompt: number; completion: number } };
```

### Add retries with bounded backoff

- Retry transient failures only.
- Cap max attempts.
- Respect rate-limit semantics.

### Use AbortController and timeouts

```ts
const c = new AbortController();
const timer = setTimeout(() => c.abort(), 30_000);
```

### Streaming handling

Normalize stream chunks into a typed event protocol.

## Token Management (`js-tiktoken`)

- Count tokens before request dispatch.
- Reserve output budget (e.g., 20–40% of context window).
- Truncate oldest/lowest-value context first.

```ts
const budget = 16_000;
const reservedForOutput = 4_000;
const maxPromptTokens = budget - reservedForOutput;
```

## Prompting Patterns

- Keep system instructions stable and concise.
- Use explicit output schemas for machine-readability.
- Include only task-relevant context snippets.

## Security & Cost

- Never log API keys.
- Keep provider secrets out of frontend bundles.
- Track usage per task and set guardrails.

## Do and Don’t

### Do

- Validate and parse model outputs strictly.
- Add fallback behavior for provider outages.

### Don’t

- Assume deterministic output without constraints.
- Send full history blindly without token budgeting.

## Common Pitfalls

- Token-limit truncation that removes critical instructions.
- Streaming parser bugs on partial chunks.
- Unbounded retries multiplying cost.