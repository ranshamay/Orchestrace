# Orchestrace Context Management: Deep-Dive and Implementation Plan

## 1. Scope and framing

This document explains:

1. How context management generally works in code agents (Claude Code style architecture).
2. What Orchestrace is doing today (from source and persisted run artifacts).
3. Where context is currently over-accumulated or unintentionally exposed.
4. A concrete plan to implement robust context accumulation, compaction, and sub-agent context isolation/sharing.

This is a design and rollout draft, not an API freeze.

## 2. How context management usually works (Claude Code style, generalized)

Important: public behavior can be described, but exact proprietary internals are not guaranteed unless code is verifiably available.

In practice, modern coding agents usually maintain a layered context model:

1. Static instruction layer
   - System policy, coding rules, tool constraints, identity.

2. Session layer
   - Conversation turns, explicit user constraints, current objective.

3. Workspace retrieval layer
   - Relevant file snippets, symbols, diagnostics, diffs, test failures.

4. Execution memory layer
   - Prior tool calls/results, plan state, TODO/graph state, failures and retries.

5. Compressed historical memory
   - Summaries of older turns and tool traces, preserving decisions and unresolved items.

Typical lifecycle over a long chat:

1. Accumulate raw turns and tool traces.
2. Estimate token pressure before each completion.
3. If over budget threshold, compact middle history into structured summaries.
4. Keep anchors uncompressed (latest turns, constraints, open blockers, current plan).
5. Delegate focused sub-tasks to sub-agents with narrow context packets.
6. Merge sub-agent outputs back as compact artifacts, not full transcripts.

Sub-agent sharing is usually controlled:

1. Parent does not stream full transcript to every sub-agent.
2. Sub-agent receives only task-relevant context packet.
3. Sub-agent returns a structured result (summary + evidence pointers).
4. Parent decides what to merge into global context.

## 3. Current Orchestrace behavior (what code shows)

### 3.1 Chat accumulation model

Current behavior is append-heavy:

1. New user/assistant messages are appended to thread history.
2. Follow-up prompt is rebuilt from full relevant history each turn.
3. Thread trimming default is effectively disabled.

Evidence:

- Full-continuity continuation prompt construction in `buildChatContinuationInput`.
- Trimming default is `Number.POSITIVE_INFINITY`.

### 3.2 Compaction model

There is no true token-budget compaction pipeline for chat history today.

What exists is display/log compaction, not model-context compaction:

1. Inline image markdown gets compacted for prompt normalization.
2. UI event strings are compacted for previews.
3. Session event arrays are capped, but chat thread arrays are not materially compacted by token budget.

### 3.3 Provider-side context loop

Provider context grows with each tool round:

1. Adapter starts with one user message in provider context.
2. Each model response and tool result is appended back into context messages.
3. Optional hard cap exists for tool rounds (`ORCHESTRACE_MAX_TOOL_ROUNDS`), but no dynamic token-aware summarization of loop state.

### 3.4 Delegation and sub-agent context

Sub-agents are spawned with scoped prompt-first context:

1. Parent passes a focused prompt (`subagent_spawn` / `subagent_spawn_batch`).
2. Prompt may be auto-enriched with snippets from referenced files.
3. Enrichment is bounded (`max files = 3`, `max chars/file = 1200`).
4. Sub-agent result is returned as tool result JSON and merged into parent loop context.

This is good for isolation, but still lacks a formal context packet contract.

### 3.5 Is context shared?

Short answer:

1. Shared within a single parent agent call: yes (tool loop message accumulation).
2. Shared from parent to sub-agent: partially, via explicit delegated prompt (+ optional snippet enrichment), not full transcript.
3. Shared from sub-agent back to parent: yes, via tool result payload.
4. Shared globally across all sessions by default: no direct in-memory sharing, but persisted artifacts can re-expose data.

### 3.6 Observed artifact leakage risk

Persisted state currently stores rich tool outputs and can include source snippets and operational metadata in plain JSON artifacts.

Examples observed in repository artifacts:

1. `.orchestrace/ui-state.json` includes tool call messages with detailed command outputs and API payload fragments.
2. `.orchestrace/coordination/.../state.json` contains delegated prompts and auto-included file snippet blocks.

This creates a practical leakage surface for sensitive code/outputs unless retention/redaction is controlled.

## 4. Gap analysis (today vs desired)

### 4.1 Main gaps

1. No token-budget manager for chat continuation input.
2. No tiered compaction policy (head/tail anchors + middle summary).
3. No structured compression artifacts (decision ledger, unresolved ledger, evidence index).
4. Sub-agent packet format is implicit and string-based; not strongly typed for safe merge.
5. Persistence stores high-entropy raw outputs that may exceed privacy expectations.

### 4.2 Consequences

1. Context bloat leads to quality decay and timeout risk in long sessions.
2. Repeated prompt reconstruction can over-include stale details.
3. Sub-agent outputs can flood parent context when not normalized.
4. Persisted files become accidental long-term context and potential leakage source.

## 5. Target architecture for Orchestrace

Introduce a Context Engine with explicit budget, compaction, and delegation contracts.

### 5.1 Canonical context object

Create a typed model per session:

1. `anchors`
   - invariant instructions, user hard constraints, task objective.
2. `recentTurns`
   - last N user/assistant turns (raw).
3. `executionState`
   - active todo graph, current phase, blockers, latest validation failures.
4. `artifactIndex`
   - pointers to files/diffs/tool outputs with short summaries.
5. `compressedHistory`
   - hierarchical summaries of older turns/tool loops.
6. `budget`
   - estimated input tokens, safety margin, per-section allotments.

### 5.2 Token budget policy

Before each LLM call:

1. Estimate tokens by section.
2. Reserve output budget and tool-call overhead.
3. If over soft threshold, compact oldest non-anchor sections.
4. If still over hard threshold, compact aggressively and drop lowest-value details with explicit omission notices.

Suggested thresholds:

1. Soft threshold: 70-75% of max input.
2. Hard threshold: 85-90% of max input.

### 5.3 Compaction strategy

Multi-pass compaction:

1. Pass A: summarize older tool traces into structured bullets.
2. Pass B: summarize older conversational turns into decision timeline.
3. Pass C: retain unresolved questions/errors verbatim.
4. Pass D: rebuild prompt with:
   - anchors (verbatim)
   - recency tail (verbatim)
   - compressed middle (structured)
   - execution state (verbatim/structured)

Output structure for compressed segment:

1. Decisions made.
2. Assumptions accepted/rejected.
3. Pending actions.
4. Known failures and attempted fixes.
5. Evidence pointers (file path + line references or artifact IDs).

### 5.4 Delegation contract (parent to sub-agent)

Define a typed packet:

1. Objective.
2. Boundaries (allowed tools, write policy, timeout).
3. Minimal relevant context snippets.
4. Required output schema.
5. Evidence requirements.

Define a typed return payload:

1. Result summary.
2. Actions performed.
3. Evidence pointers.
4. Risks/open questions.
5. Optional machine-readable patch intent.

Merge policy in parent:

1. Keep summary and evidence pointers in main context.
2. Store detailed raw output in artifact store with retention policy.
3. Do not inject full sub-agent transcript by default.

### 5.5 Sharing model

Explicitly support 3 sharing scopes:

1. Session-local (default)
   - chat turns, compressed history, local decisions.
2. Run-global
   - cross-task facts safe to reuse in the same run.
3. Repo memory
   - durable conventions and validated facts only.

No implicit cross-session sharing of raw transcripts.

### 5.6 Persistence and privacy hardening

1. Persist structured summaries by default, not full raw outputs.
2. Store raw tool payloads behind explicit debug mode.
3. Redact obvious secrets/tokens and large code blobs in event logs.
4. Add retention/TTL for raw artifacts.
5. Add export modes:
   - safe export (summaries only)
   - forensic export (raw, gated)

## 6. Implementation plan for Orchestrace

### Phase 0: Instrumentation and observability (1-2 days)

1. Add context-size telemetry at each completion call:
   - estimated input tokens by section.
   - compaction triggered yes/no.
   - dropped/retained segment counts.
2. Add sub-agent packet metrics:
   - prompt chars.
   - snippet count.
   - response chars.

Deliverable: metrics visible in run artifacts/UI timeline.

### Phase 1: Context Engine core (2-4 days)

1. Introduce `ContextEnvelope` type and builder.
2. Replace direct full-thread prompt build with envelope assembly.
3. Keep existing behavior as fallback path behind feature flag.

Deliverable: chat and implementation calls route through one budget-aware context builder.

### Phase 2: Compaction pipeline (3-5 days)

1. Implement soft/hard threshold compaction passes.
2. Add structured compressed-history schema.
3. Preserve anchors + recency tail invariants.
4. Add tests for deterministic compaction outcomes.

Deliverable: long chats no longer unboundedly expand prompt input.

### Phase 3: Delegation packetization (2-4 days)

1. Define typed `SubAgentContextPacket` and `SubAgentResult` schemas.
2. Update `subagent_spawn(_batch)` to use packet builder.
3. Parent merge keeps summary/evidence only; raw output goes to artifact store.

Deliverable: predictable, bounded parent/sub-agent context exchange.

### Phase 4: Persistence hardening (2-3 days)

1. Introduce redaction + truncation policies for persisted events.
2. Separate safe summary store from raw debug store.
3. Add retention cleanup for raw artifacts.

Deliverable: reduced leakage surface in `.orchestrace` files.

### Phase 5: Tuning and rollout (ongoing)

1. Enable feature by default for new sessions.
2. Compare success, latency, and failure rates against baseline.
3. Tune thresholds and compaction heuristics.

Deliverable: stable default behavior with measurable quality gains.

## 7. Acceptance criteria

A rollout is complete when:

1. Context input size remains bounded under long-running chats.
2. No catastrophic context-loss regressions in follow-up continuity tests.
3. Sub-agent payload size and response merge size are bounded and observable.
4. Persisted state no longer stores large raw code/tool outputs by default.
5. Retry quality improves for timeout/rate-limit/tool-runtime failures.

## 8. Code evidence pointers used for this draft

Core accumulation and continuation:

1. `packages/cli/src/ui-server/chat.ts`
2. `packages/cli/src/ui-server.ts`

Provider context/message loop:

1. `packages/provider/src/adapter/context.ts`
2. `packages/provider/src/adapter/tools.ts`

Delegation and prompt enrichment:

1. `packages/tools/src/coordination-tools.ts`
2. `packages/cli/src/ui-server.ts`

Prompt assembly and retry context:

1. `packages/core/src/orchestrator/orchestrator.ts`
2. `packages/core/src/dag/scheduler.ts`

Observed persistence artifacts:

1. `.orchestrace/ui-state.json`
2. `.orchestrace/coordination/*/state.json`
