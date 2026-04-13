# AI Token Tooling Best Practices (@mariozechner/pi-ai + js-tiktoken)

## Overview

This guide captures practical, production-grade patterns for using:

- [`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai) for model/provider abstraction and tool-use loops
- `js-tiktoken` for token estimation and context budgeting

Goals:

1. Stay within model context windows reliably
2. Control cost and latency
3. Retry only when retrying is likely to help
4. Emit enough telemetry to debug failures and tune prompts
5. Keep behavior consistent across providers

---

## DO

- **Budget tokens before every completion**
  - Estimate input tokens for system prompt, user prompt, tool transcripts, and retrieved snippets.
  - Reserve output headroom (`maxOutputTokens`) and tool-loop overhead.
  - Trigger compaction before hitting hard limits.

- **Use model metadata to drive limits**
  - Pull context/max-output from the adapter (`getModelInfo`) and derive soft/hard thresholds.
  - Recommended starting points:
    - Soft input threshold: **70–75%** of context window
    - Hard input threshold: **85–90%** of context window

- **Track usage continuously**
  - Use `onUsage` callbacks and persist `input/output/cost` per request.
  - Aggregate cost per task, per run, and per provider/model for routing decisions.

- **Apply retries by failure class**
  - Retry transient network/timeouts/rate limits with exponential backoff.
  - Avoid retrying hard failures (schema/validation/auth without refresh path).
  - Keep retries low (usually 1–2 attempts) to prevent runaway cost.

- **Instrument tool-use loops**
  - Record each tool call (`started`/`result`) with IDs, args, duration, and error status.
  - Cap max tool rounds to avoid infinite loops.

- **Compact context structurally, not randomly**
  - Keep anchors verbatim (task goal, constraints, current blockers).
  - Summarize middle history into decisions + evidence pointers.
  - Keep latest turns/tool outputs verbatim.

- **Use conservative fallbacks in token estimation**
  - If tokenization fails, use a predictable fallback estimate (e.g. chars/4), then add safety margin.

---

## DON'T

- **Don’t send full transcripts forever**
  - Long append-only histories degrade quality and increase cost/latency.

- **Don’t treat token counts as exact across all providers**
  - Different providers/models can tokenize differently; always keep margin.

- **Don’t retry blindly**
  - Repeating invalid tool args or malformed prompts increases cost with no gain.

- **Don’t ignore empty-response behavior**
  - Explicitly handle empty text / zero-token responses and classify them.

- **Don’t log sensitive raw payloads by default**
  - Avoid dumping full prompts/tool outputs unless debug mode is explicitly enabled.

- **Don’t forget provider-specific timeout tuning**
  - A single global timeout can be too low for some providers and too high for others.

---

## Configuration

Recommended knobs (aligned with current Orchestrace env support):

### Retry and backoff

- `ORCHESTRACE_EMPTY_RESPONSE_RETRIES` (default: 1)
- `ORCHESTRACE_LLM_TRANSIENT_RETRY_ATTEMPTS` (default: 1)
- `ORCHESTRACE_LLM_RETRY_BACKOFF_BASE_MS` (default: 800)
- `ORCHESTRACE_LLM_RETRY_BACKOFF_MAX_MS` (default: 8000)

Suggested baseline:

```bash
ORCHESTRACE_EMPTY_RESPONSE_RETRIES=1
ORCHESTRACE_LLM_TRANSIENT_RETRY_ATTEMPTS=2
ORCHESTRACE_LLM_RETRY_BACKOFF_BASE_MS=500
ORCHESTRACE_LLM_RETRY_BACKOFF_MAX_MS=8000
```

### Timeouts

- `ORCHESTRACE_LLM_TIMEOUT_MS` (global)
- `ORCHESTRACE_LLM_TIMEOUT_MS_<PROVIDER>` (provider override, uppercased and normalized)

Example:

```bash
ORCHESTRACE_LLM_TIMEOUT_MS=120000
ORCHESTRACE_LLM_TIMEOUT_MS_OPENAI=90000
ORCHESTRACE_LLM_TIMEOUT_MS_ANTHROPIC=120000
```

### Tool-loop safety

- `ORCHESTRACE_MAX_TOOL_ROUNDS` (hard cap for tool-use loops)
- `ORCHESTRACE_SUBAGENT_BATCH_RETRY_MAX_ATTEMPTS` (sub-agent batch retries)

Example:

```bash
ORCHESTRACE_MAX_TOOL_ROUNDS=12
ORCHESTRACE_SUBAGENT_BATCH_RETRY_MAX_ATTEMPTS=2
```

### Failure logging

- `ORCHESTRACE_LLM_DUMP_LOGS=false` to disable failure dumps

Use `true` only in controlled debug contexts; redact secrets and large blobs.

---

## Examples

### 1) Token budgeting with `js-tiktoken`

```ts
import { encodingForModel } from 'js-tiktoken';

const enc = encodingForModel('gpt-4o');

function estimateTokens(text: string): number {
  if (!text) return 0;
  try {
    return enc.encode(text).length;
  } catch {
    return Math.max(1, Math.ceil(text.length / 4));
  }
}

function shouldCompact(inputText: string, contextWindow: number): boolean {
  const input = estimateTokens(inputText);
  const softThreshold = Math.floor(contextWindow * 0.75);
  return input > softThreshold;
}
```

### 2) Cost-aware completion telemetry with `pi-ai` adapter callbacks

```ts
const result = await agent.complete(prompt, signal, {
  onUsage: (usage) => {
    // usage: { input, output, cost }
    metrics.observe('llm.input_tokens', usage.input);
    metrics.observe('llm.output_tokens', usage.output);
    metrics.observe('llm.cost_usd', usage.cost);
  },
  onToolCall: (event) => {
    // event.type: 'started' | 'result'
    // event.toolName, event.toolCallId, event.isError
    telemetry.log(event);
  },
});
```

### 3) Retry policy by failure type

```ts
function shouldRetry(failureType: string): boolean {
  return failureType === 'timeout' || failureType === 'rate_limit';
}

// Add bounded exponential backoff and attempt caps (1–2 retries typically).
```

---

## Project-specific notes (Orchestrace)

- `packages/context/src/tokenizer.ts`
  - Uses `encodingForModel('gpt-4o')` and caches encoder.
  - Includes safe fallback estimate (`chars/4`) on tokenizer failure.
  - **Best practice:** keep a model-aware encoder map when routing across very different model families.

- `packages/provider/src/adapter.ts`
  - Uses structured failure classification and retry gates.
  - Supports auth-refresh retry only when explicitly opted in (`allowAuthRefreshRetry`).
  - Emits aggregated usage and metadata (`stopReason`, endpoint).

- `packages/provider/src/adapter/tools.ts`
  - Implements tool-loop execution with optional `ORCHESTRACE_MAX_TOOL_ROUNDS` cap.
  - Emits tool-call lifecycle events (`started`/`result`) for observability.
  - Includes recovery hints after tool failures to steer model retries.

- `packages/provider/src/adapter/retry.ts`
  - Retries transient failures using configurable exponential backoff.
  - Handles common retryable statuses/codes (e.g., 429/5xx/timeouts).

- `packages/provider/src/adapter/timeout.ts`
  - Supports global and provider-specific timeout overrides.
  - Maps timeout/abort errors into clearer diagnostics.

- `packages/provider/src/adapter/failure.ts`
  - Failure dumps are enabled unless `ORCHESTRACE_LLM_DUMP_LOGS=false`.
  - **Best practice:** default to redacted logs in shared/CI environments.

- `docs/CONTEXT-MANAGEMENT-PLAN.md`
  - Describes current gap and target state for budget-aware compaction.
  - Recommended implementation direction: context envelope + section-level token accounting + structured compaction.

---

## Quick checklist

- [ ] Estimate tokens for every request section
- [ ] Reserve output/tool overhead before sending
- [ ] Trigger compaction at soft threshold
- [ ] Enforce hard caps (timeouts, retries, tool rounds)
- [ ] Capture per-call usage + cost + failure type
- [ ] Emit tool-call telemetry with IDs and errors
- [ ] Redact logs and disable verbose dumps by default in production