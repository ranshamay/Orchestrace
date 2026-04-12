import type {
  SessionEvent,
  MaterializedSession,
  SessionConfig,
  WorkState,
  SessionLlmStatus,
  UiDagEvent,
  SessionAgentGraphNode,
  SessionChatMessage,
  AgentTodoItem,
  SharedContextFact,
  ContextCompactionState,
  SessionOutput,
  SessionCheckpointPayload,
  SessionRecoveryDetectedPayload,
} from './types.js';

const MAX_EVENTS = 2_000; // Same trim limit as ui-server

/**
 * Materialize a complete session state from an ordered list of events.
 * This is the pure-function equivalent of the in-memory mutations that
 * ui-server.ts performs today — the single source of truth for deriving
 * session state from the event log.
 */
export function materializeSession(events: SessionEvent[]): MaterializedSession | null {
  if (events.length === 0) return null;

  // Find the latest creation event. In-place retries append a new session:created
  // with updated config while preserving the same session id and event history.
  const createdEvent = [...events].reverse().find((e) => e.type === 'session:created');
  if (!createdEvent || createdEvent.type !== 'session:created') return null;

  const config: SessionConfig = createdEvent.payload.config;
  const now = createdEvent.time;

  const state: MaterializedSession = {
    config,
    status: 'running',
    llmStatus: {
      state: 'queued',
      label: 'Queued',
      updatedAt: now,
    },
    taskStatus: {},
    events: [],
    agentGraph: [],
    error: undefined,
    output: undefined,
    chatThread: undefined,
    todos: [],
    contextFacts: [],
    contextCompaction: { turnsSinceLastCompaction: 0 },
    lastHeartbeat: undefined,
    lastCheckpoint: undefined,
    lastRecovery: undefined,
    lastSeq: 0,
    createdAt: now,
    updatedAt: now,
  };

  for (const event of events) {
    applyEvent(state, event);
  }

  return state;
}

/**
 * Apply a single event to a materialized session (incremental update).
 * Mutates `state` in place. Used both by `materializeSession` (full replay)
 * and by watchers (incremental catch-up).
 */
export function applyEvent(state: MaterializedSession, event: SessionEvent): void {
  state.lastSeq = event.seq;
  state.updatedAt = event.time;

  switch (event.type) {
    case 'session:created':
      // Already handled in materializeSession; re-applying is a no-op
      break;

    case 'session:started':
      state.status = 'running';
      break;

    case 'session:status-change':
      state.status = event.payload.status;
      break;

    case 'session:llm-status-change':
      state.llmStatus = event.payload.llmStatus;
      break;

    case 'session:error-change':
      state.error = event.payload.error;
      break;

    case 'session:output-set':
      state.output = event.payload.output;
      break;

    case 'session:dag-event':
      applyDagEvent(state, event.payload.event);
      break;

    case 'session:task-status-change':
      state.taskStatus[event.payload.taskId] = event.payload.taskStatus;
      break;

    case 'session:agent-graph-set':
      state.agentGraph = event.payload.graph;
      break;

    case 'session:agent-graph-node-status':
      applyGraphNodeStatus(state, event.payload.nodeId, event.payload.status);
      break;

    case 'session:chat-thread-created':
      state.chatThread = {
        provider: event.payload.provider,
        model: event.payload.model,
        workspacePath: event.payload.workspacePath,
        taskPrompt: event.payload.taskPrompt,
        createdAt: event.time,
        updatedAt: event.time,
        messages: [],
      };
      break;

    case 'session:chat-message':
      if (state.chatThread) {
        state.chatThread.messages.push(event.payload.message);
        state.chatThread.updatedAt = event.time;
      }
      break;

    case 'session:llm-context':
      // LLM context snapshots are queried via dedicated APIs and do not
      // influence the core materialized session envelope.
      break;

    case 'session:todos-set':
      state.todos = event.payload.items;
      break;

    case 'session:todo-item-added':
      state.todos.push(event.payload.item);
      break;

    case 'session:todo-item-toggled': {
      const todo = state.todos.find((t) => t.id === event.payload.itemId);
      if (todo) {
        todo.done = event.payload.done;
        if (event.payload.status !== undefined) todo.status = event.payload.status;
      }
      break;
    }

    case 'session:todo-item-removed':
      state.todos = state.todos.filter((t) => t.id !== event.payload.itemId);
      break;

    case 'session:context-fact':
      applyContextFact(state, event.payload.fact);
      break;

    case 'session:context-compaction':
      state.contextCompaction = event.payload.state;
      break;

    case 'session:runner-heartbeat':
      state.lastHeartbeat = event.time;
      break;

    case 'session:checkpoint': {
      const checkpoint: SessionCheckpointPayload = event.payload;
      state.lastCheckpoint = { ...checkpoint, time: event.time };
      break;
    }

    case 'session:recovery-detected': {
      const recovery: SessionRecoveryDetectedPayload = event.payload;
      state.lastRecovery = { ...recovery, time: event.time };
      break;
    }

    case 'session:stream-delta':
      // Stream deltas are transient — used for real-time SSE replay but
      // don't affect materialized state. The final text lands as chat
      // messages or session output.
      break;

    case 'session:observer-status-change':
    case 'session:observer-finding':
      // Observer events are transient — used for real-time SSE streaming
      // only. Findings are persisted separately by the observer registry.
      break;
  }
}

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

function applyDagEvent(state: MaterializedSession, dagEvent: UiDagEvent): void {
  state.events.push(dagEvent);
  // Trim to max length (same as ui-server.ts)
  while (state.events.length > MAX_EVENTS) {
    state.events.shift();
  }
}

function applyGraphNodeStatus(
  state: MaterializedSession,
  nodeId: string,
  status: 'pending' | 'running' | 'completed' | 'failed',
): void {
  const node = state.agentGraph.find((n) => n.id === nodeId);
  if (node) {
    node.status = status;
  }
}

function applyContextFact(state: MaterializedSession, fact: SharedContextFact): void {
  const existing = state.contextFacts.findIndex((f) => f.key === fact.key);
  if (existing >= 0) {
    state.contextFacts[existing] = fact;
  } else {
    state.contextFacts.push(fact);
  }
}
