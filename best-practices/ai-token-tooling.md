# AI Token Tooling Best Practices

This guide focuses on token-aware agent/tooling workflows for Orchestrace-style systems (multi-step planning, tool calls, retries, and validation loops).

## Why this matters

Token spend is not just a cost problem. It also affects:

- latency (slow planning loops)
- reliability (context overflow and degraded reasoning)
- determinism (large prompts increase variance)
- operational safety (runaway retries and hidden budget burn)

---

## 1) Design around budgets first

Treat token policy as part of runtime policy, not an afterthought.

### Recommended baseline

- **Model window + output reserve:** always reserve output tokens before building input context.
- **Soft threshold:** trigger compaction before hard failure.
- **Hard threshold:** fail-safe boundary before context-window overflow.
- **Phase budgets:** separate planning vs implementation budgets.

In this repo, the context package already encodes a strong default shape (`packages/context/src/types.ts`):

- `contextWindow = 128000`
- `maxOutputTokens = 8192`
- `softThresholdRatio = 0.70`
- `hardThresholdRatio = 0.85`

---

## 2) Instrument token flow at every step

### DO

- Record usage per task, attempt, and phase.
- Persist run artifacts for postmortems.
- Track both prompt and completion tokens.

```ts
// DO: aggregate and persist usage by task/run
if (output.usage) {
  totalTokens += output.usage.input + output.usage.output;
}
```

### DON'T

- Rely on end-of-month provider billing as your only telemetry.
- Track only completion tokens (prompt tokens are usually the larger cost in agentic loops).

---

## 3) Enforce “early tool-use” guardrails

Long pre-tool reasoning is a common waste pattern.

### DO

- Nudge or abort when planning consumes too many tokens before first tool call.
- Add wall-clock no-progress timeouts.

```text
DO: If planning exceeds pre-first-tool token budget, retry with directive
"Use a concrete tool call to advance the plan."
```

### DON'T

- Allow unlimited “thinking” turns before any environment-grounding call (`read_file`, `search_files`, etc.).

This repo already includes practical thresholds in `packages/core/src/orchestrator/planning-no-progress-guard.ts`:

- nudge at ~2000 pre-tool tokens
- abort at ~3000 pre-tool tokens
- initial no-tool cutoff ~20s

---

## 4) Compact context safely

Compaction should preserve high-signal anchors and execution state.

### DO

- Keep non-compactable anchor sections (system contract, active constraints, acceptance criteria).
- Compact historical turns first.
- Run periodic compaction checks even before hard limits.

### DON'T

- Summarize everything into one blob.
- Drop failure context during retry cycles.
- Compact the current task objective or tool policy text.

---

## 5) Use accurate token counting (with fallback)

### DO

- Use model-aligned tokenizers where possible.
- Keep a deterministic fallback estimator when tokenizer calls fail.

### DON'T

- Use character count as your primary metric.

The tokenizer implementation in `packages/context/src/tokenizer.ts` follows this pattern (tiktoken first, char/4 fallback).

---

## Practical DO / DON’T patterns

## A) Budget manager integration

```ts
// DO
const manager = new ContextBudgetManager(modelInfo, {
  softThresholdRatio: 0.7,
  hardThresholdRatio: 0.85,
});

const compactionMode = manager.needsCompaction(totalTokens, turnsSinceLastCompaction);
if (compactionMode !== 'none') {
  // compact history
}
```

```ts
// DON'T
if (prompt.length > 100000) {
  // arbitrary char cutoff; no output reservation; no phase awareness
}
```

## B) Retry loops

```text
DO: Include validation stderr + previous attempt summary in retry context.
DON'T: Retry with the original giant prompt plus all prior logs.
```

---

## Common mistakes

1. **No output reserve:** consuming full context window for input.
2. **Single global budget:** ignoring planning/implementation/tester phase differences.
3. **No token guard before first tool call:** expensive “hallucinated planning.”
4. **Over-compaction:** losing exact error text needed for fixes.
5. **Missing per-attempt telemetry:** impossible to tune prompt/tool policy.
6. **Ignoring tool-call overhead:** each tool roundtrip adds tokens.

---

## Token tooling checklist

### Implementation checklist

- [ ] Budget policy defines context window, output reserve, soft/hard thresholds.
- [ ] Token counting is model-aligned with deterministic fallback.
- [ ] Planning phase has first-tool token/time guardrails.
- [ ] Compaction preserves anchors and active acceptance criteria.
- [ ] Retry prompts include only high-signal deltas, not full log replay.

### Operational checklist

- [ ] Run artifacts store per-task usage (input/output/cost).
- [ ] Alerts exist for abnormal token/task growth.
- [ ] Weekly review of top token-consuming task categories.
- [ ] Guardrail thresholds are tuned using observed data, not guesswork.