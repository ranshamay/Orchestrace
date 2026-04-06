# UI ↔ Agent Decoupling Plan

## Problem

The UI server (`ui-server.ts`) is a **~5k-line monolith** that simultaneously:

1. Serves the HTTP API + static assets for the React dashboard
2. Holds all session state in **in-memory Maps** (`workSessions`, `sessionChats`, `sessionTodos`, `sessionSharedContextStores`, `sessionContextEngines`, `sessionContextStates`, etc.)
3. Orchestrates agent runs (calls `orchestrate()` directly, spawns sub-agents via closures)
4. Streams SSE events by writing to in-memory `ServerResponse` sets
5. Manages auth flows, workspace resolution, git worktrees

**Consequence:** When the UI server restarts, all running agents die. Sessions are marked `'failed'` with "Session interrupted because the UI server restarted." The UI and agent execution are **lifecycle-coupled** — they live and die together.

## Goal

**Agent execution must survive UI server restarts.** The UI becomes a passive observer that streams work from independently-running agents. Agents run regardless of whether anyone is watching.

## Target Architecture

```
┌──────────────────────┐         ┌─────────────────────────┐
│     UI Server         │         │    Agent Runner(s)       │
│  (HTTP + SSE + SPA)   │         │  (1 process per session) │
│                       │  tail   │                          │
│  Reads event logs ◄───┼─────────┤  Append events to log    │
│  Materializes state   │         │  Orchestrate + LLM + Tools│
│  Serves REST/SSE      │         │  Self-terminate on done   │
│                       │  spawn  │                          │
│  Spawns runners ──────┼────────►│  Detached child process   │
│  Sends cancel signal  ├────────►│  Reads cancel signal      │
│                       │ SIGTERM │                          │
│  Can restart freely   │         │  Survives UI restart      │
└──────────────────────┘         └─────────────────────────┘
             │                                │
             │           ┌──────────┐         │
             └──────────►│  Event   │◄────────┘
                         │  Store   │
                         │ (disk)   │
                         └──────────┘
                .orchestrace/sessions/<id>/
                    ├── meta.json        (session config, PID)
                    ├── events.jsonl     (append-only event log)
                    ├── chat.jsonl       (chat messages)
                    ├── todos.json       (latest todo state)
                    ├── context.json     (shared context facts)
                    └── control.json     (cancel signal)
```

### Key Properties

| Property | Before | After |
|----------|--------|-------|
| Agent lifecycle | Tied to UI server process | Independent detached process |
| Session state | In-memory Maps | Event-sourced from disk |
| UI restart impact | Kills all running agents | Reconnects to running agents |
| SSE streaming | Writes to in-memory Response sets | Tails event logs → SSE |
| Cancellation | In-process `AbortController` | `SIGTERM` to runner PID |
| Multiple observers | Single SSE fanout | Any process can tail logs |
| State reconstruction | Hydrate from `ui-state.json` snapshot | Replay event log |

---

## Implementation Phases

### Phase 1: Event Store Foundation

**Goal:** Define a durable event format and read/write layer. No behavior changes yet — just the new storage primitive.

**New package:** `packages/store/` (or add to `packages/core/`)

```ts
// packages/store/src/types.ts
interface SessionEvent {
  seq: number;          // monotonic sequence number
  time: string;         // ISO timestamp
  type: SessionEventType;
  payload: unknown;     // type-discriminated by `type`
}

type SessionEventType =
  | 'session:created'     // session config + initial state
  | 'session:started'     // orchestration kicked off
  | 'session:completed'   // final output
  | 'session:failed'      // error
  | 'session:cancelled'   // user cancel
  | 'dag:event'           // existing DagEvent (task:started, task:completed, etc.)
  | 'llm:status'          // LlmSessionState change
  | 'task:status'         // per-task status update
  | 'graph:update'        // agentGraph node add/update
  | 'todo:update'         // todo list change
  | 'stream:delta'        // text delta (for real-time streaming)
  | 'chat:message'        // chat thread message
  | 'context:fact'        // shared context fact added
  | 'runner:heartbeat'    // runner liveness signal
```

```ts
// packages/store/src/event-store.ts
interface EventStore {
  append(sessionId: string, event: Omit<SessionEvent, 'seq'>): Promise<void>;
  read(sessionId: string, fromSeq?: number): AsyncIterable<SessionEvent>;
  watch(sessionId: string, fromSeq: number, cb: (event: SessionEvent) => void): () => void;
  listSessions(): Promise<string[]>;
  getMetadata(sessionId: string): Promise<SessionMetadata | null>;
  setMetadata(sessionId: string, meta: SessionMetadata): Promise<void>;
}
```

**Storage format:** `.orchestrace/sessions/<id>/events.jsonl` — one JSON object per line, atomic appends via `fs.appendFile`. This is the **source of truth**.

**Files:**
- `packages/store/src/event-store.ts` — JSONL append/read/watch implementation
- `packages/store/src/types.ts` — event types
- `packages/store/src/materializer.ts` — `materializeSession(events): MaterializedSession`

**Deliverables:**
- [ ] Event type definitions covering all current `UiDagEvent` + status + graph + todo + chat
- [ ] `FileEventStore` implementation with append, read, watch (fs.watch + readline)
- [ ] `materializeSession()` that rebuilds `WorkSession`-equivalent from event replay
- [ ] Unit tests: append/read roundtrip, watch delivery, materialization correctness

---

### Phase 2: Dual-Write Bridge

**Goal:** Wire the event store into the existing monolith. Every state mutation now **also** writes to the event log. Session state is still in-memory (no behavior change) but events are being durably persisted.

**Changes to `ui-server.ts`:**

1. **`startWorkSession()`** — After creating the in-memory session, also call `eventStore.append(id, { type: 'session:created', payload: sessionConfig })`.

2. **`onEvent` callback** — After mutating `session.events` / `session.llmStatus` / `session.taskStatus`, also append the corresponding typed event.

3. **Completion/failure handlers** — Append `session:completed` or `session:failed` events.

4. **Chat messages** — Append `chat:message` events alongside in-memory thread updates.

5. **Todo updates** — Append `todo:update` events.

6. **Graph updates** — Append `graph:update` events when `agentGraph` nodes are added/modified.

**Validation:** Compare materialized state from event replay vs. in-memory state at session completion. Log divergences. This proves correctness before we switch reads to event-sourced.

**Deliverables:**
- [ ] Event store instance created in `startUiServer()`
- [ ] All state mutations dual-write to event store
- [ ] Materialization validation on session completion (log-only, no behavior change)
- [ ] Remove `hydratePersistedSession` failure marking (events will handle this)

---

### Phase 3: Event-Sourced State (Read Path)

**Goal:** Session state is materialized from events instead of held in in-memory Maps. The in-memory Maps become caches re-derivable from the event log.

**Changes:**

1. **Session listing (`GET /api/sessions`)** — Read from `eventStore.listSessions()` + `materializeSession()` instead of iterating `workSessions` Map.

2. **Session detail (`GET /api/sessions/:id`)** — Materialize from events.

3. **SSE streaming** — Instead of `broadcastWorkStream()` writing to in-memory Response sets from `onEvent`, create a watcher: `eventStore.watch(id, lastSeq, event => sendSse(res, ...))`. SSE clients catch up by replaying from `seq=0`, then get live events as they're appended.

4. **State restoration on restart** — Replace `restoreUiState()` / `hydratePersistedSession()` with: scan `.orchestrace/sessions/*/events.jsonl`, materialize each. Running sessions are detected by checking runner PID liveness (see Phase 4). No more "Session interrupted" failure marking.

5. **Remove `ui-state.json` persistence** — Events replace it as source of truth. UI preferences can stay in a separate small file.

**Caching strategy:** Keep a `Map<string, MaterializedSession>` as a hot cache. Invalidate/update incrementally as new events arrive via watch. Don't re-materialize from scratch on every API call.

**Deliverables:**
- [ ] API endpoints read from event-sourced state
- [ ] SSE streams driven by event store `.watch()`
- [ ] State restoration from event logs on server startup
- [ ] Remove `ui-state.json` session persistence (keep preferences)
- [ ] In-memory Maps become derived caches

---

### Phase 4: Extract Agent Runner

**Goal:** Orchestration execution moves to a separate process. The UI server spawns a runner and observes it via the event store.

**New entry point:** `packages/cli/src/runner.ts`

```ts
// Runner process receives session config via argv/stdin/file
// Reads: .orchestrace/sessions/<id>/meta.json
// Writes: .orchestrace/sessions/<id>/events.jsonl
// Exits: 0 on success, 1 on failure, 130 on cancel

async function main() {
  const sessionId = process.argv[2];
  const meta = await readMetadata(sessionId);
  const eventStore = new FileEventStore(meta.workspacePath);

  // Create LLM adapter, toolset, auth — same as current startWorkSession
  const llm = createAdapter(meta.provider);
  const toolset = createAgentToolset({ ... });

  // Wire onEvent to event store
  const config: OrchestrationConfig = {
    onEvent: (event) => eventStore.append(sessionId, mapToSessionEvent(event)),
    // ... rest of config
  };

  // Handle cancellation via SIGTERM
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort());

  // Optional: heartbeat writer
  const heartbeat = setInterval(
    () => eventStore.append(sessionId, { type: 'runner:heartbeat', payload: {} }),
    5000
  );

  try {
    await orchestrate(graph, config);
    eventStore.append(sessionId, { type: 'session:completed', payload: { output } });
  } catch (err) {
    eventStore.append(sessionId, { type: 'session:failed', payload: { error: err.message } });
  } finally {
    clearInterval(heartbeat);
  }
}
```

**UI server changes:**

1. **`POST /api/work/start`** — Instead of calling `void orchestrate(...)`, write `meta.json` with session config, then spawn runner as **detached child process**:

```ts
const runner = spawn('node', ['dist/runner.js', sessionId], {
  detached: true,
  stdio: 'ignore',
  cwd: workspacePath,
  env: { ...process.env, ORCHESTRACE_SESSION_ID: sessionId },
});
runner.unref(); // UI server can exit without waiting for runner

// Record PID for lifecycle management
await eventStore.setMetadata(sessionId, { ...meta, pid: runner.pid });
```

2. **`POST /api/work/cancel`** — Send `SIGTERM` to runner PID instead of `controller.abort()`:

```ts
const meta = await eventStore.getMetadata(sessionId);
if (meta?.pid) {
  try { process.kill(meta.pid, 'SIGTERM'); } catch { /* already dead */ }
}
```

3. **On UI server restart** — For each active session, check if runner PID is alive (`process.kill(pid, 0)`). If alive, session is still running — just start watching events. If dead with no terminal event, mark as failed with "Runner process died unexpectedly."

**Runner heartbeat:** Runner writes `runner:heartbeat` events every 5s. UI server detects stale runners (no heartbeat for 30s + PID dead) and marks them failed.

**Deliverables:**
- [ ] `packages/cli/src/runner.ts` — standalone entry point
- [ ] Runner reads config from `meta.json`, writes events to `events.jsonl`
- [ ] Runner handles `SIGTERM` for graceful cancellation
- [ ] Runner writes heartbeat events
- [ ] UI server spawns runner as detached process
- [ ] UI server cancel sends SIGTERM to PID
- [ ] UI server restart detects live runners via PID check
- [ ] UI server detects dead runners via stale heartbeat

---

### Phase 5: Chat Decoupling

**Goal:** Chat follow-ups work with event-sourced state and don't require the original session's in-memory context.

**Approach:** Chat stays in the UI server process (it's request-response, not long-lived), but reads history from event store instead of in-memory `sessionChats` Map.

**Changes:**

1. **Chat context reconstruction** — On chat request, materialize chat history from `chat:message` events. Reconstruct `previousCompressedHistory` from events (or persist compaction state as a `context:compaction` event).

2. **Shared context restoration** — Read `context:fact` events to rebuild `InMemorySharedContextStore` for the chat's session.

3. **Chat events → event store** — Chat token deltas and final messages append to the session's event log.

**Alternative (future):** If chat also needs to survive restarts, spawn a chat runner process. But chat is fast/stateless enough that this is low priority.

**Deliverables:**
- [ ] Chat reads history from event store
- [ ] Shared context rebuilt from events
- [ ] Context compaction state persisted as events
- [ ] Chat messages written to event store

---

### Phase 6: Cleanup & `ui-server.ts` Slimming

**Goal:** Remove all the code from `ui-server.ts` that was moved to the runner. The file should shrink from ~5k lines to ~1.5k lines.

**Remove from ui-server.ts:**
- `startWorkSession()` orchestration logic (replaced by runner spawn)
- `onEvent` callback and direct session mutation (replaced by event store watch)
- `createToolset` / `runSubAgent` closures (moved to runner)
- `hydratePersistedSession()` (replaced by event replay)
- `createUiStatePersistence()` (replaced by event store)
- All in-memory Maps except the SSE client sets and the materialized state cache
- Sub-agent tracking (`pendingSubagentNodeIdsBySession`)

**Keep in ui-server.ts:**
- HTTP routing
- SSE endpoint handlers (but fed by event store watch)
- Auth endpoints (or extract to own module)
- Workspace management endpoints
- Runner process lifecycle management
- Chat endpoints (reading from event store)
- Static asset serving

**Deliverables:**
- [ ] Remove orphaned orchestration code from ui-server.ts
- [ ] Extract auth flow handling to a separate module
- [ ] Verify all API behavior unchanged via existing UI
- [ ] `ui-server.ts` ≤ 2k lines

---

## State Migration

### From `ui-state.json` to Event Logs

On first startup after migration:
1. If `.orchestrace/sessions/` doesn't exist but `ui-state.json` does:
2. Read `ui-state.json`, iterate persisted sessions
3. For each session, synthesize a complete event log from the snapshot:
   - `session:created` with config
   - `dag:event` for each item in `session.events`
   - `llm:status` for final `llmStatus`
   - `session:completed` / `session:failed` based on `status`
   - `chat:message` for each message in chat thread
   - `todo:update` for todo items
4. Write to `.orchestrace/sessions/<id>/events.jsonl`
5. Delete or archive `ui-state.json`

---

## Cancellation Protocol

**Current:** `session.controller.abort()` → immediate propagation to every `.signal` consumer in the process.

**After:** UI server → `SIGTERM` to runner PID → runner's `process.on('SIGTERM')` → `controller.abort()` → same in-process propagation within the runner.

**Edge case:** If runner ignores SIGTERM (stuck in I/O), escalate to `SIGKILL` after 10s timeout.

```ts
async function cancelRunner(pid: number): Promise<void> {
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; } // dead
    await sleep(500);
  }
  process.kill(pid, 'SIGKILL'); // force kill
}
```

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Event log disk I/O slows agents | Measurable on slow disks | Batch writes with 50ms debounce; async append doesn't block LLM calls |
| Runner process crash leaves orphaned state | Session stuck as "running" | Heartbeat + PID liveness check on UI startup; 30s stale threshold |
| Event log corruption (partial write) | Session state unreadable | Last-line validation on read; truncate partial trailing line |
| Multiple UI servers watching same session | Duplicate SSE events | SSE is per-connection; each UI server independently tails the log |
| Auth flows require UI server interaction | Runner can't prompt for auth | Runner inherits resolved auth at spawn time; for token refresh, runner reads `auth.json` directly or exits with auth-needed status |
| Large event logs for long sessions | Slow materialization | Periodic snapshot events (`session:snapshot`) that capture full state; materialize from last snapshot |
| Chat compaction state lost between restarts | Context window bloat | Persist compaction state as `context:compaction` event |

---

## Execution Order & Dependencies

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5 ──► Phase 6
  store       dual-       event-      extract     chat        cleanup
  types       write       sourced     runner      decouple
              bridge      reads
```

Each phase is independently deployable and testable. Phase 2 runs both paths (in-memory + events) in parallel for validation. Phase 3 flips reads. Phase 4 flips writes. Phase 5 and 6 are polish.

---

## Non-Goals (Explicitly Out of Scope)

- **Database backend** — File-based is sufficient for single-machine. Could add SQLite later if needed.
- **Multi-machine distribution** — Runners and UI server are on the same machine (shared filesystem).
- **WebSocket replacement for SSE** — SSE is adequate for server→client streaming.
- **Runner auto-recovery / resumable orchestration** — If a runner dies mid-execution, the session fails. Resumption would require checkpointing the LLM conversation state, which is a separate project.
- **Chat in separate process** — Chat is fast enough to stay in the UI server process.

---

## Success Criteria

1. ✅ Killing the UI server process while agents are running does NOT kill the agents
2. ✅ Restarting the UI server reconnects to running agents and resumes SSE streaming
3. ✅ Session state is fully reconstructable from the event log
4. ✅ Cancel still works (within 10s latency target)
5. ✅ No regression in SSE streaming latency (< 100ms event-to-browser)
6. ✅ `ui-server.ts` reduced to ≤ 2k lines
7. ✅ All existing UI functionality preserved

---

## Estimated Scope

| Phase | New Files | Modified Files | Complexity |
|-------|-----------|----------------|------------|
| 1. Event Store | 4-5 | 0 | Medium — new abstraction, well-defined |
| 2. Dual-Write | 0-1 | 1 (ui-server.ts) | Medium — wiring, many touch points |
| 3. Event-Sourced Reads | 0-1 | 1 (ui-server.ts) | High — replace all read paths |
| 4. Extract Runner | 2-3 | 1 (ui-server.ts) | High — process lifecycle, IPC |
| 5. Chat Decoupling | 0-1 | 1 (ui-server.ts) | Medium — context reconstruction |
| 6. Cleanup | 0 | 1-2 | Low — deletion + reorganization |
