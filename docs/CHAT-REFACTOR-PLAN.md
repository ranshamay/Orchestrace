# Chat / Timeline UI Refactor Plan

## Problem Statement

The current timeline UI aggregates and collapses information, making it impossible to follow the agent's sequential reasoning process. Users cannot see a clear chronological stream of:
1. LLM thinking/reasoning text
2. Tool calls (name, inputs, outputs)
3. Phase transitions and current context

Instead, tool calls are collapsed into accordions, reasoning tokens are relegated to a separate ephemeral panel, chat messages and events are merged from disconnected data sources, and there is no sense of "conversation flow."

---

## Design Constraints

### Dual-Surface: Web and CLI (TUI)

The chat data model and SSE protocol must support **both** rendering surfaces:
- **Web UI** — React components in `packages/ui/`
- **CLI TUI** — Terminal output in `packages/cli/src/index.ts` (currently plain `console.log` with emoji)

This means:
1. **The data model (`ChatMessage` / `MessagePart`) lives in a shared package** — not in `packages/ui/`. It is defined in `packages/store/src/types.ts` (or a new `packages/chat/` package) so both CLI and web can import it.
2. **The SSE protocol is the canonical contract** — both web and a future TUI client consume the same SSE stream.
3. **Rendering is surface-specific** — Web uses React components with Tailwind. CLI uses a simple text formatter that maps `ChatMessage[]` → terminal output with ANSI colors and icons.
4. **No HTML/React/DOM types in the data model** — Everything is plain TypeScript (strings, enums, discriminated unions).

### Icon-First Compact Design

Minimize text labels. Use icons everywhere to keep each line to **1 line per chat part** in the default collapsed state. The icon map is the single source of truth for both web (emoji/SVG) and CLI (Unicode/emoji).

---

## Research: How the Best Harnesses Do It

### Vercel AI SDK (Gold Standard for Agent Chat UIs)

**Message Model:** Every message has a `parts[]` array. Each part is a discriminated union:

| Part Type | Description |
|---|---|
| `text` | Streamed text content |
| `reasoning` | CoT/thinking content (separate visual treatment) |
| `tool-input-start/delta/available` | Tool call arguments streamed |
| `tool-output-available` | Tool execution result |
| `source-url` / `source-document` | Grounding sources |
| `file` | Generated images/files |

**Key Design Principles:**
- Everything is a part of a message — no separate state containers
- Parts ordered chronologically — array order IS display order
- Streaming at the part level — deltas update specific parts in-place
- No aggregation by default — each tool is a separate inline part
- Status lifecycle per tool — `calling` → `success` / `error`

### Cline / Claude Code / Cursor (IDE Agent UIs)

All use a **flat sequential chat**: thinking → tool card → result card → more thinking → final response. No collapsing. Each tool call is a separate card. Thinking is inline.

---

## Diagnosis of Current Implementation

### Architecture (Current)

```
EventStore (file)
  → ui-server.ts (watches events, broadcasts SSE)
    → 6 different SSE event types → useSessionStream hook
      → 4 disconnected state containers:
        1. sessions[] (WorkSession with events[])
        2. chatMessages[] (only from initial ready snapshot)
        3. nodeTokenStreams{} (volatile token buffer, 4000 char cap)
        4. observerState (separate state)
      → buildTimelineItems() merges events[] + chatMessages[] by timestamp
        → TimelineList groups consecutive tool-call items → accordion collapse
```

### What's Wrong

1. **Reasoning tokens are not in the timeline** — `session:stream-delta` feeds a volatile buffer for a header panel
2. **Tool calls are collapsed** — Consecutive calls grouped into "N tool calls" accordions
3. **Chat messages are disconnected** — One-shot snapshot merged by timestamp
4. **No message-parts concept** — Each event is a separate flat item
5. **Events capped at 1000** — Long sessions silently drop early events
6. **No per-item streaming indicator** — Can't see what's currently streaming
7. **Observer findings are separate** — Not in the conversation flow
8. **CLI has no structured output** — Plain `console.log` with no chat model

---

## Proposed Architecture

### Core Principle: **Message-Parts Model**

Replace the flat event timeline with a **message-based chat** where each message contains an ordered array of **parts**. The data model is **surface-agnostic** — both web and CLI consume it.

### Data Model (shared — `packages/store/src/chat-types.ts`)

```typescript
// ─── SESSION PHASES ───
type SessionPhase = 'planning' | 'implementation' | 'testing';

// ─── MESSAGE ───
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  agentId?: string;          // planner | implementer | tester
  phase?: SessionPhase;
  taskId?: string;
  timestamp: string;
  status: 'streaming' | 'complete' | 'error';
  parts: MessagePart[];
  metadata?: {
    model?: string;
    provider?: string;
    tokenUsage?: { prompt: number; completion: number };
  };
}

// ─── PARTS (discriminated union) ───
type MessagePart =
  | ReasoningMessagePart
  | TextMessagePart
  | ToolCallMessagePart
  | PhaseTransitionMessagePart
  | ContextSnapshotMessagePart
  | ApprovalRequestMessagePart
  | ObserverFindingMessagePart
  | ErrorMessagePart;

interface ReasoningMessagePart {
  type: 'reasoning';
  id: string;
  text: string;
  isStreaming: boolean;
}

interface TextMessagePart {
  type: 'text';
  id: string;
  text: string;
  isStreaming: boolean;
}

interface ToolCallMessagePart {
  type: 'tool-call';
  id: string;
  toolName: string;
  input: unknown;
  inputSummary: string;
  output?: unknown;
  outputSummary?: string;
  status: 'calling' | 'success' | 'error';
  startTime: string;
  endTime?: string;
  error?: string;
}

interface PhaseTransitionMessagePart {
  type: 'phase-transition';
  phase: SessionPhase;
  label: string;
}

interface ContextSnapshotMessagePart {
  type: 'context-snapshot';
  snapshotId: string;
  phase: string;
  model: string;
  textChars: number;
  imageCount: number;
}

interface ApprovalRequestMessagePart {
  type: 'approval-request';
  planSummary: string;
  status: 'pending' | 'approved' | 'rejected';
}

interface ObserverFindingMessagePart {
  type: 'observer-finding';
  findingId: string;
  severity: string;
  title: string;
  detail?: string;
}

interface ErrorMessagePart {
  type: 'error';
  message: string;
  detail?: string;
}
```

### Icon Map (shared constant — used by both web and CLI)

```typescript
// ─── TOOL ICONS ───
const TOOL_ICON: Record<string, string> = {
  read_file:        '📖',
  edit_file:        '✏️',
  replace_string_in_file: '✏️',
  multi_replace_string_in_file: '✏️',
  create_file:      '📄',
  list_dir:         '📁',
  grep_search:      '🔍',
  semantic_search:  '🔍',
  file_search:      '🔍',
  run_in_terminal:  '▶️',
  run_command:      '▶️',
  execution_subagent: '▶️',
  fetch_webpage:    '🌐',
  git_diff:         '🔀',
  git_commit:       '🔀',
  delete_file:      '🗑️',
  _default:         '🔧',
};

// ─── ROLE / PHASE / STATUS ICONS ───
const ROLE_ICON  = { user: '👤', assistant: '🤖', system: '⚙️' };
const PHASE_ICON = { planning: '📋', implementation: '🔨', testing: '🧪' };
const STATUS_ICON = {
  calling: '⏳', success: '✓', error: '✗',
  streaming: '█', complete: '✅', failed: '💥',
};
const REASONING_ICON = '🧠';
const OBSERVER_ICON  = '👁️';
const APPROVAL_ICON  = '✋';
const CONTEXT_ICON   = '📊';
```

### SSE Protocol v2

Replace the 6+ event types with a **unified stream protocol**:

```
// Message lifecycle
data: {"type":"message-start","messageId":"m1","role":"assistant","phase":"planning","taskId":"t1"}
data: {"type":"message-end","messageId":"m1"}

// Reasoning parts
data: {"type":"reasoning-start","messageId":"m1","partId":"r1"}
data: {"type":"reasoning-delta","messageId":"m1","partId":"r1","delta":"Let me analyze..."}
data: {"type":"reasoning-end","messageId":"m1","partId":"r1"}

// Text parts
data: {"type":"text-start","messageId":"m1","partId":"t1"}
data: {"type":"text-delta","messageId":"m1","partId":"t1","delta":"I'll read the file"}
data: {"type":"text-end","messageId":"m1","partId":"t1"}

// Tool calls
data: {"type":"tool-call-start","messageId":"m1","partId":"tc1","toolName":"read_file","input":{"path":"src/index.ts"},"inputSummary":"src/index.ts"}
data: {"type":"tool-call-end","messageId":"m1","partId":"tc1","status":"success","output":"...","outputSummary":"142 lines"}

// Phase transition (not inside a message)
data: {"type":"phase-transition","phase":"implementation","label":"Implementation"}

// Session-level status
data: {"type":"status-update","sessionId":"s1","status":"running","llmStatus":"streaming"}
data: {"type":"todo-update","todos":[...]}
data: {"type":"observer-finding","finding":{...}}
```

### Frontend Architecture: Web

```
SSE stream
  → useChatStream() hook
    → messages: ChatMessage[]
    → sessionMeta: { status, llmStatus, phase, todos }
    → ChatPanel
      → MessageList → MessageBubble
        → maps parts[] → part renderers (icon-first, 1-line compact)
```

### Frontend Architecture: CLI

```
SSE stream (or direct event subscription)
  → formatChatLine(part): string
    → writes ANSI-colored lines to stdout
    → same icon map, same data model
```

---

## Rendering Specification

### Compact Default — Icon-First, 1 Line Per Part

Every part renders as **a single line** in the default collapsed state:

```
👤 Fix the login bug in auth.ts
── 📋 Planning · Claude Opus ──────────────
🧠 (1,240 chars)
📖 src/auth.ts  ✓
🔍 "validateToken"  ✓ 3
── 🔨 Implementation · Claude Sonnet ──────
🧠 (890 chars)
✏️ src/auth.ts:87  ✓
▶️ npm test  ✓ 47 passed
✅ Fixed == → === on line 87
```

**10 lines total** for a full planning + implementation session with 4 tool calls.

### Part Rendering Rules

| Part Type | Icon | Default (1-line) | Expanded | While Streaming |
|---|---|---|---|---|
| `reasoning` | 🧠 | `🧠 (N chars)` | Full text, muted/italic | Expanded with cursor `█` |
| `text` | — | Full markdown (1-3 lines) | N/A | Streaming with cursor |
| `tool-call` | per map | `📖 src/auth.ts  ✓` | Full input/output JSON | `📖 src/auth.ts  ⏳` |
| `phase-transition` | per map | `── 📋 Planning · Model ──` | N/A | N/A |
| `context-snapshot` | 📊 | `📊 Opus · 12K chars` | Full context viewer | N/A |
| `approval-request` | ✋ | `✋ Plan ready · [Approve] [Reject]` | Plan detail | Pulsing |
| `observer-finding` | 👁️ | `👁️ [severity] title` | Full detail | N/A |
| `error` | 💥 | `💥 Error message` | Full stack trace | N/A |

### CLI Rendering Example

The same data model produces terminal output:

```
👤 Fix the login bug in auth.ts

── 📋 Planning · Claude Opus ──────────────────
🧠 (1,240 chars)
📖 src/auth.ts  ✓
🔍 "validateToken"  ✓ 3 matches

── 🔨 Implementation · Claude Sonnet ──────────
🧠 (890 chars)
✏️ src/auth.ts:87  ✓
▶️ npm test  ✓ 47 passed

✅ Fixed == → === on line 87
```

No HTML. No React. Same icons. Same 1-line-per-part density.

---

## Implementation Plan

### Phase 1: Shared Data Model

**New file:** `packages/store/src/chat-types.ts`
- `ChatMessage`, `MessagePart` (all sub-types), icon maps
- Pure TypeScript, no React/DOM dependencies
- Export from `packages/store/src/index.ts`

**New file:** `packages/store/src/chat-builder.ts`
- Pure functions for immutable message manipulation:
  - `appendPart(messages, messageId, part)` → `ChatMessage[]`
  - `updatePartDelta(messages, messageId, partId, delta)` → `ChatMessage[]`
  - `completeMessage(messages, messageId)` → `ChatMessage[]`
  - `completePart(messages, messageId, partId)` → `ChatMessage[]`
  - `convertLegacyEvents(events, chatMessages)` → `ChatMessage[]`

### Phase 2: Backend SSE v2

**Modify:** `packages/cli/src/ui-server.ts`
- New SSE broadcast path via `?v=2` query param on `/api/work/stream`
- Map store events → v2 protocol:
  - `session:stream-delta` → `reasoning-delta` / `text-delta`
  - `session:dag-event` (task:tool-call) → `tool-call-start` / `tool-call-end`
  - `session:dag-event` (task:planning, etc.) → `phase-transition`
  - `session:llm-context` → `context-snapshot` part
  - `session:chat-message` → message + text parts
- Message grouping: maintain `currentMessageId` per session. New message on phase change, task change, or >5s idle gap.
- **Keep v1 SSE protocol working** during migration

**Modify:** `packages/cli/src/ui-server/types.ts`
- Add v2 SSE event type definitions

### Phase 3: Web UI Components

**New files under `packages/ui/src/app/components/chat/`:**

| File | Purpose |
|---|---|
| `ChatPanel.tsx` | Main container: scrollable message list + auto-scroll + composer |
| `MessageBubble.tsx` | Single message: role icon + phase badge + maps `parts[]` → renderers |
| `parts/ReasoningPart.tsx` | `🧠 (N chars)` collapsed / full text expanded / streaming cursor |
| `parts/TextPart.tsx` | Markdown text, streaming cursor |
| `parts/ToolCallPart.tsx` | Icon + name + key arg + status (1-line card), expandable to full JSON |
| `parts/PhaseTransitionPart.tsx` | `── 📋 Phase · Model ──` horizontal divider |
| `parts/ContextSnapshotPart.tsx` | `📊 Model · N chars` badge, expandable |
| `parts/ApprovalRequestPart.tsx` | `✋` card + approve/reject buttons |
| `parts/ObserverFindingPart.tsx` | `👁️ [sev] title` inline |
| `parts/ErrorPart.tsx` | `💥 message` banner |
| `toolIcons.ts` | Tool name → icon/emoji resolver (imports shared map from store) |

**New hook:** `packages/ui/src/app/hooks/useChatStream.ts`
- Replaces `useSessionStream`
- Single `messages: ChatMessage[]` state
- Single `sessionMeta` state for status/todos/observer
- SSE v2 event handlers that update messages/parts in-place
- Exports: `messages`, `sessionMeta`, `isStreaming`, `activeMessageId`

### Phase 4: CLI Chat Formatter

**New file:** `packages/cli/src/chat-formatter.ts`
- `formatPartLine(part: MessagePart): string` — 1-line ANSI-colored output
- `formatMessage(msg: ChatMessage): string` — joins part lines
- `formatPhaseTransition(phase, model): string` — divider line

**Modify:** `packages/cli/src/index.ts`
- Replace current `console.log` event handlers with chat-formatter calls
- Subscribe to SSE v2 (or direct event bus) and render `ChatMessage[]` to stdout

### Phase 5: Wire Web UI

**Modify:** `packages/ui/src/App.tsx`
- Replace `useSessionStream` → `useChatStream`
- Remove `buildTimelineItems` useMemo
- Remove `useTimelineFollow` (ChatPanel handles its own scrolling)

**Modify:** `packages/ui/src/app/components/AppMainContent.tsx`
- Replace `<TimelinePanel>` → `<ChatPanel>`
- Remove timeline-related props (`timelineItems`, `timelineContainerRef`, `followTimelineTail`, `onTimelineScroll`)

**Modify:** `packages/ui/src/app/shell/props/buildMainContentProps.ts`
- Remove `timelineItems` and `timelineFollow` params
- Add `chatMessages` and `sessionMeta` params

### Phase 6: Full Cleanup — Remove All Legacy Chat/Timeline Code

**Every file below is deleted entirely:**

| File to DELETE | Reason |
|---|---|
| `packages/ui/src/app/components/work/TimelinePanel.tsx` | Replaced by `ChatPanel` |
| `packages/ui/src/app/components/work/TimelineList.tsx` | Replaced by `MessageBubble` + part renderers |
| `packages/ui/src/app/components/work/ToolChipGroup.tsx` | No more tool grouping/accordion |
| `packages/ui/src/app/components/work/ToolChip.tsx` | Replaced by `ToolCallPart` |
| `packages/ui/src/app/utils/timelineItems.ts` | `buildTimelineItems()` no longer exists |
| `packages/ui/src/app/hooks/useTimelineFollow.ts` | ChatPanel manages its own scroll |
| `packages/ui/tests/tester-timeline-summary.test.ts` | Tests `formatTimelineEvent` for old timeline |

**Files to modify (remove dead code):**

| File | What to remove |
|---|---|
| `packages/ui/src/app/types.ts` | Remove `TimelineItem` type definition (lines ~22-48) |
| `packages/ui/src/app/utils/timeline.ts` | Remove `formatTimelineEvent`, `toolInputSummary`, `toolOutputSummary`, `formatToolPayloadForDisplay`. **Keep** `parseToolCallEvent` (used by `EntityGraphCard.tsx`) |
| `packages/ui/src/App.tsx` | Remove `buildTimelineItems` import/useMemo, `useTimelineFollow` import/call, `nodeTokenStreams` state, `liveReasoning` computation, all timeline-related prop wiring |
| `packages/ui/src/app/components/AppMainContent.tsx` | Remove `TimelinePanel` import, `TimelineItem` type import, all timeline props from `AppMainContentProps` interface |
| `packages/ui/src/app/shell/props/buildMainContentProps.ts` | Remove `timelineItems` param, `timelineFollow` param, all timeline prop mapping |
| `packages/ui/src/app/hooks/useSessionStream.ts` | Delete entirely (replaced by `useChatStream`) |
| `packages/ui/src/app/hooks/useBootstrapData.ts` | Remove `chatMessages` state, `nodeTokenStreams` state, and their setters |
| `packages/cli/src/ui-server.ts` | Remove v1 SSE broadcast code path after v2 is stable |
| `packages/cli/src/ui-server/types.ts` | Remove v1 SSE event type definitions |

**Components to keep (not part of timeline):**

| File | Status |
|---|---|
| `packages/ui/src/app/components/work/ComposerPanel.tsx` | KEEP — reused by ChatPanel |
| `packages/ui/src/app/components/work/LogsTabView.tsx` | KEEP — separate feature |
| `packages/ui/src/app/components/work/SessionSummaryCard.tsx` | KEEP — separate feature |
| `packages/ui/src/app/components/work/ToolsPanel.tsx` | KEEP — separate feature |
| `packages/ui/src/app/components/graph/EntityGraphCard.tsx` | KEEP — uses `parseToolCallEvent` (retained in `timeline.ts`) |

---

## Migration Strategy

### Step 1: Build v2 alongside v1
- New data types in `packages/store/src/chat-types.ts`
- New components in `packages/ui/src/app/components/chat/`
- New hook `useChatStream` coexists with `useSessionStream`
- New SSE v2 protocol via `?v=2` query param
- Feature flag to toggle between old and new UI

### Step 2: Legacy event conversion
- `convertLegacyEvents()` transforms old session events into `ChatMessage[]`
- Ensures old sessions render in the new chat UI without changes

### Step 3: Cut over
- Default to v2 UI
- Default to v2 SSE

### Step 4: Full cleanup (Phase 6 above)
- Delete all files listed in Phase 6
- Remove all dead code from modified files
- Remove v1 SSE protocol path from backend
- Remove feature flag

---

## Effort Estimate by Phase

| Phase | Scope | Files |
|---|---|---|
| Phase 1 | Shared data model + builder | 2 new, 1 modified (`store/index.ts`) |
| Phase 2 | Backend SSE v2 | 2 modified (`ui-server.ts`, `types.ts`) |
| Phase 3 | Web components + hook | 11 new files |
| Phase 4 | CLI chat formatter | 1 new, 1 modified (`index.ts`) |
| Phase 5 | Wire web UI | 3 modified files |
| Phase 6 | Full cleanup | 7 deleted, 9 modified |

---

## Decisions

1. **Reasoning collapse**: Expanded while streaming, collapsed after completion (`🧠 (N chars)`)
2. **Message grouping**: New assistant message on phase change, task change, or >5s idle gap
3. **Tool call display**: Icon + name + key arg + status on 1 line. Click to expand full JSON.
4. **Legacy sessions**: Convert via `convertLegacyEvents()` — all sessions render in new UI
5. **Observer findings**: Inline as `👁️` parts in the conversation flow
6. **Data model location**: `packages/store/src/chat-types.ts` — shared by web + CLI
