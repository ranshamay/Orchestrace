// ---------------------------------------------------------------------------
// Session Event Store — type definitions
// ---------------------------------------------------------------------------
// Every state mutation in the system is captured as an event. The session's
// materialized state is derived by replaying events in order.
// ---------------------------------------------------------------------------

// ---- Shared value types (mirrored from @orchestrace/cli ui-server/types) ----
// Intentionally duplicated here so the store package has zero workspace deps.

export type WorkState = 'running' | 'completed' | 'failed' | 'cancelled';
export type SessionCreationReason = 'start' | 'retry';

export type LlmSessionState =
  | 'queued'
  | 'analyzing'
  | 'thinking'
  | 'planning'
  | 'awaiting-approval'
  | 'implementing'
  | 'using-tools'
  | 'validating'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SessionLlmStatus {
  state: LlmSessionState;
  label: string;
  detail?: string;
  failureType?: string;
  taskId?: string;
  phase?: 'planning' | 'implementation';
  updatedAt: string;
}

export interface SessionAgentGraphNode {
  id: string;
  name?: string;
  prompt: string;
  weight?: number;
  dependencies: string[];
  status?: 'pending' | 'running' | 'completed' | 'failed';
  provider?: string;
  model?: string;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
}

export interface UiDagEvent {
  time: string;
  runId?: string;
  type: string; // DagEvent['type'] — kept as string to avoid core dep
  taskId?: string;
  failureType?: string;
  message: string;
}

export type ChatRole = 'user' | 'assistant' | 'system';

export type SessionChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; name?: string };

export interface SessionChatMessage {
  role: ChatRole;
  content: string;
  contentParts?: SessionChatContentPart[];
  time: string;
  usage?: { input: number; output: number; cost: number };
}

export interface AgentTodoItem {
  id: string;
  text: string;
  status?: 'todo' | 'in_progress' | 'done';
  done: boolean;
  weight?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionOutput {
  text?: string;
  planPath?: string;
  failureType?: string;
}

export interface SharedContextFact {
  key: string;
  value: string;
  tags?: string[];
}

export interface ContextCompactionState {
  turnsSinceLastCompaction: number;
  previousCompressedHistory?: string;
}

// ---- Session configuration (written once at creation) -----------------------

export interface SessionConfig {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  prompt: string;
  promptParts?: SessionChatContentPart[];
  provider: string;
  model: string;
  autoApprove: boolean;
  adaptiveConcurrency: boolean;
  batchConcurrency: number;
  batchMinConcurrency: number;
  worktreePath?: string;
  worktreeBranch?: string;
  creationReason: SessionCreationReason;
  sourceSessionId?: string;
}

// ---- Event discriminated union ----------------------------------------------

export type SessionEventType =
  // Lifecycle
  | 'session:created'
  | 'session:started'
  | 'session:status-change'
  | 'session:llm-status-change'
  | 'session:error-change'
  | 'session:output-set'
  // DAG events (forwarded from orchestrator)
  | 'session:dag-event'
  | 'session:task-status-change'
  // Agent graph
  | 'session:agent-graph-set'
  | 'session:agent-graph-node-status'
  // Chat
  | 'session:chat-thread-created'
  | 'session:chat-message'
  // Todos
  | 'session:todos-set'
  | 'session:todo-item-added'
  | 'session:todo-item-toggled'
  | 'session:todo-item-removed'
  // Shared context
  | 'session:context-fact'
  | 'session:context-compaction'
  // Runner lifecycle
  | 'session:runner-heartbeat'
  // Stream deltas (high-frequency, used for real-time SSE replay)
  | 'session:stream-delta';

// Per-event payload types
export interface SessionCreatedPayload {
  config: SessionConfig;
}

export interface SessionStartedPayload {
  pid?: number;
}

export interface SessionStatusChangePayload {
  status: WorkState;
}

export interface SessionLlmStatusChangePayload {
  llmStatus: SessionLlmStatus;
}

export interface SessionErrorChangePayload {
  error: string | undefined;
}

export interface SessionOutputSetPayload {
  output: SessionOutput;
}

export interface SessionDagEventPayload {
  event: UiDagEvent;
}

export interface SessionTaskStatusChangePayload {
  taskId: string;
  taskStatus: string;
}

export interface SessionAgentGraphSetPayload {
  graph: SessionAgentGraphNode[];
}

export interface SessionAgentGraphNodeStatusPayload {
  nodeId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export interface SessionChatThreadCreatedPayload {
  provider: string;
  model: string;
  workspacePath: string;
  taskPrompt: string;
}

export interface SessionChatMessagePayload {
  message: SessionChatMessage;
}

export interface SessionTodosSetPayload {
  items: AgentTodoItem[];
}

export interface SessionTodoItemAddedPayload {
  item: AgentTodoItem;
}

export interface SessionTodoItemToggledPayload {
  itemId: string;
  done: boolean;
  status?: 'todo' | 'in_progress' | 'done';
}

export interface SessionTodoItemRemovedPayload {
  itemId: string;
}

export interface SessionContextFactPayload {
  fact: SharedContextFact;
}

export interface SessionContextCompactionPayload {
  state: ContextCompactionState;
}

export interface SessionRunnerHeartbeatPayload {
  pid: number;
}

export interface SessionStreamDeltaPayload {
  taskId: string;
  phase: 'planning' | 'implementation';
  delta: string;
}

// The discriminated union
export type SessionEvent =
  | { seq: number; time: string; type: 'session:created'; payload: SessionCreatedPayload }
  | { seq: number; time: string; type: 'session:started'; payload: SessionStartedPayload }
  | { seq: number; time: string; type: 'session:status-change'; payload: SessionStatusChangePayload }
  | { seq: number; time: string; type: 'session:llm-status-change'; payload: SessionLlmStatusChangePayload }
  | { seq: number; time: string; type: 'session:error-change'; payload: SessionErrorChangePayload }
  | { seq: number; time: string; type: 'session:output-set'; payload: SessionOutputSetPayload }
  | { seq: number; time: string; type: 'session:dag-event'; payload: SessionDagEventPayload }
  | { seq: number; time: string; type: 'session:task-status-change'; payload: SessionTaskStatusChangePayload }
  | { seq: number; time: string; type: 'session:agent-graph-set'; payload: SessionAgentGraphSetPayload }
  | { seq: number; time: string; type: 'session:agent-graph-node-status'; payload: SessionAgentGraphNodeStatusPayload }
  | { seq: number; time: string; type: 'session:chat-thread-created'; payload: SessionChatThreadCreatedPayload }
  | { seq: number; time: string; type: 'session:chat-message'; payload: SessionChatMessagePayload }
  | { seq: number; time: string; type: 'session:todos-set'; payload: SessionTodosSetPayload }
  | { seq: number; time: string; type: 'session:todo-item-added'; payload: SessionTodoItemAddedPayload }
  | { seq: number; time: string; type: 'session:todo-item-toggled'; payload: SessionTodoItemToggledPayload }
  | { seq: number; time: string; type: 'session:todo-item-removed'; payload: SessionTodoItemRemovedPayload }
  | { seq: number; time: string; type: 'session:context-fact'; payload: SessionContextFactPayload }
  | { seq: number; time: string; type: 'session:context-compaction'; payload: SessionContextCompactionPayload }
  | { seq: number; time: string; type: 'session:runner-heartbeat'; payload: SessionRunnerHeartbeatPayload }
  | { seq: number; time: string; type: 'session:stream-delta'; payload: SessionStreamDeltaPayload };

// Input type for appending (seq is auto-assigned)
export type SessionEventInput = Omit<SessionEvent, 'seq'>;

// ---- Session metadata (stored alongside event log) --------------------------

export interface SessionMetadata {
  id: string;
  pid?: number;
  createdAt: string;
  workspacePath: string;
}

// ---- Materialized session (derived from events) -----------------------------

export interface MaterializedSession {
  config: SessionConfig;
  status: WorkState;
  llmStatus: SessionLlmStatus;
  taskStatus: Record<string, string>;
  events: UiDagEvent[];
  agentGraph: SessionAgentGraphNode[];
  error?: string;
  output?: SessionOutput;
  chatThread?: {
    provider: string;
    model: string;
    workspacePath: string;
    taskPrompt: string;
    createdAt: string;
    updatedAt: string;
    messages: SessionChatMessage[];
  };
  todos: AgentTodoItem[];
  contextFacts: SharedContextFact[];
  contextCompaction: ContextCompactionState;
  lastHeartbeat?: string;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
}

// ---- Event store interface --------------------------------------------------

export interface EventStore {
  /** Append an event to a session's event log. Returns the assigned seq number. */
  append(sessionId: string, event: SessionEventInput): Promise<number>;

  /** Append multiple events atomically. Returns the seq of the last event. */
  appendBatch(sessionId: string, events: SessionEventInput[]): Promise<number>;

  /** Read all events for a session, optionally starting from a seq number. */
  read(sessionId: string, fromSeq?: number): Promise<SessionEvent[]>;

  /** Watch for new events. Returns an unsubscribe function. */
  watch(sessionId: string, fromSeq: number, cb: (event: SessionEvent) => void): () => void;

  /** List all session IDs that have event logs. */
  listSessions(): Promise<string[]>;

  /** Read session metadata. */
  getMetadata(sessionId: string): Promise<SessionMetadata | null>;

  /** Write session metadata. */
  setMetadata(sessionId: string, meta: SessionMetadata): Promise<void>;

  /** Delete a session's event log and metadata. */
  deleteSession(sessionId: string): Promise<void>;
}
