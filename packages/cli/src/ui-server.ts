import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  PromptSectionName,
  renderPromptSections,
  validateTaskPromptInput,
} from '@orchestrace/core';
import type { DagEvent, PromptSection, TaskPromptValidationErrorCode } from '@orchestrace/core';
import { getModels } from '@mariozechner/pi-ai';
import { PiAiAdapter, ProviderAuthManager, type LlmPromptInput, type LlmToolCallEvent } from '@orchestrace/provider';
import {
  createAgentToolset,
  createFileReadCache,
  listAgentTools,
  type AgentToolPhase,
  type SubAgentRequest,
  type SubAgentResult,
} from '@orchestrace/tools';
import {
  InMemorySharedContextStore,
  ContextEngine,
  countTokens,
  type ConversationTurn,
  type ModelInfo,
} from '@orchestrace/context';
import { now } from './ui-server/clock.js';
import { cleanupSessionWorktree, ensureSessionWorktree, resolveSessionWorktreeBranch } from './session-worktree.js';
import {
  buildChatContinuationInput,
  cloneChatContentParts,
  compactInlineImageMarkdown,
  createSessionChatMessage,
  createSessionChatThread,
  estimateTokensFromText,
  parseChatContentParts,
  scheduleChatStreamCleanup,
  summarizeChatContentParts,
  trimThreadMessages,
} from './ui-server/chat.js';
import { asString, toErrorMessage } from './ui-server/strings.js';
import { broadcastSessionUpdate, broadcastTodoUpdate, broadcastWorkStream, closeWorkStream, sendSse } from './ui-server/sse.js';
import type {
  AgentTodoItem,
  AuthSession,
  ChatTokenStream,
  PersistedUiState,
  PersistedWorkSession,
  PersistedUiPreferences,
  SessionAgentGraphNode,
  SessionChatContentPart,
  SessionChatMessage,
  SessionChatThread,
  SessionCheckpointInfo,
  SessionAgentModels,
  SessionLlmStatus,
  SessionRecoveryInfo,
    UiDagEvent,
  LogStreamErrorEvent,
  UiPreferences,

  UiServerOptions,
  WorkSession,
  WorkState,
  LlmSessionState,
  SessionCreationReason,
  SessionDeliveryStrategy,
  SessionWorkspaceAssignmentProvenance,
  SessionWorktreePathSessionIdRelation,
} from './ui-server/types.js';
import { WorkspaceManager } from './workspace-manager.js';
import {
  assertWorkspaceRuntimeIsComplete,
  formatMissingSourceDirsWarning,
  validateWorkspaceRuntime,
} from './workspace-runtime.js';
import { FileEventStore } from '@orchestrace/store';
import { materializeSession as materializeFromEvents } from '@orchestrace/store';
import type {
  SessionCheckpointPayload,
  SessionConfig,
  SessionEventInput,
  SessionRecoveryDetectedPayload,
} from '@orchestrace/store';
import { ObserverDaemon, SessionObserver, BackendLogger, LogWatcher } from './observer/index.js';
import type { LogWatcherRuntimeError, RealtimeFinding } from './observer/index.js';

import { sanitizeLogLine, sanitizeToolPayload } from './runner/log-sanitizer.js';
import { parseTaskRouteOverride } from './task-routing.js';
import { PrMergeScanner } from './pr-merge-scanner.js';



const GITHUB_PROVIDER_ID = 'github';
const GITHUB_API_BASE_URL = 'https://api.github.com';
const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const APP_AUTH_BEARER_PREFIX = 'Bearer ';
const GITHUB_DEVICE_AUTH_SCOPES_DEFAULT = ['repo', 'workflow', 'read:org'];
// Public OAuth app client id used for GitHub device flow (mirrors CLI-style auth UX).
const GITHUB_DEVICE_AUTH_CLIENT_ID_DEFAULT = '178c6fc778ccc68e1d6a';
const DEFAULT_UI_ADAPTIVE_CONCURRENCY = false;
const DEFAULT_UI_BATCH_CONCURRENCY = 8;
const DEFAULT_UI_BATCH_MIN_CONCURRENCY = 1;
const SUBAGENT_WORKER_PROMPT_PREVIEW_MAX_CHARS = 220;
const SUBAGENT_WORKER_OUTPUT_PREVIEW_MAX_CHARS = 420;
const SUBAGENT_RETRY_MAX_ATTEMPTS = 2;
const SUBAGENT_RETRY_BASE_DELAY_MS = 300;
const CHAT_RETRY_MAX_ATTEMPTS = 2;
const CHAT_RETRY_BASE_DELAY_MS = 300;
const RETRY_CONTINUATION_MAX_CHARS = 4_000;
const RETRY_OUTPUT_EXCERPT_MAX_CHARS = 1_200;
const DEFAULT_CONTEXT_COMPACTION_MODEL = 'gpt-4.1-mini';
const CONTEXT_COMPACTION_PROVIDER_ENV = 'ORCHESTRACE_CONTEXT_COMPACTION_PROVIDER';
const CONTEXT_COMPACTION_MODEL_ENV = 'ORCHESTRACE_CONTEXT_COMPACTION_MODEL';
const PERSIST_RAW_DEBUG_ENV = 'ORCHESTRACE_PERSIST_RAW_DEBUG';
const PERSIST_TEXT_MAX_CHARS = 3_000;
const PERSIST_EVENT_MESSAGE_MAX_CHARS = 1_200;
const PERSIST_CHAT_MESSAGE_MAX_CHARS = 2_400;
const SESSION_EVENT_HISTORY_LIMIT = 2_000;
const TOOL_EVENT_PREVIEW_MAX_CHARS = parsePositiveSetting(process.env.ORCHESTRACE_TOOL_EVENT_PREVIEW_MAX_CHARS) ?? 200_000;
const WORK_DIFF_MAX_CHARS = 300_000;
const PHASE_PROGRESS_PLAN_WEIGHT_DEFAULT = 30;
const PHASE_PROGRESS_IMPLEMENTATION_WEIGHT_DEFAULT = 70;
const STARTUP_RECOVERY_MODE_ENV = 'ORCHESTRACE_RECOVERY_MODE';
const SESSION_CHECKPOINT_FILE = 'checkpoint.json';
const CHECKPOINT_STASH_PREFIX = 'orchestrace-checkpoint';
const execFileAsync = promisify(execFile);

type SessionCheckpointMetadata = {
  sessionId: string;
  workspacePath: string;
  state: 'idle' | 'active' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: string;
  updatedAt: string;
  stashRef?: string;
  stashMessage?: string;
  checkpointName?: string;
};

type WorkStartModelResolutionFailureCode =
  | 'MODEL_LIST_FETCH_FAILED'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_UNAVAILABLE';

type WorkStartModelResolutionResult =
  | { ok: true; model: string }
  | {
      ok: false;
      statusCode: number;
      code: WorkStartModelResolutionFailureCode;
      error: string;
      details: Record<string, unknown>;
    };

type GithubDeviceAuthSessionState = 'awaiting-user' | 'polling' | 'completed' | 'failed';

interface GithubDeviceAuthSession {
  id: string;
  state: GithubDeviceAuthSessionState;
  clientId: string;
  scopes: string[];
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSeconds: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

interface SessionContextState {
  turnsSinceLastCompaction: number;
  previousCompressedHistory?: string;
}

type NativeGitWorktree = {
  path: string;
  branch?: string;
  detached: boolean;
};

type AppAuthConfig = {
  enabled: boolean;
  googleClientId: string;
  jwtSecret: string;
  tokenTtlSeconds: number;
};

type AppAuthJwtPayload = {

  sub: string;
  email: string;
  name?: string;
  picture?: string;
  iat: number;
  exp: number;
};


function createInheritedSubAgentToolset(
  cwd: string,
  options: {
    phase: AgentToolPhase;
    taskId: string;
    taskType?: string;
    graphId?: string;
    provider?: string;
    model?: string;
    reasoning?: 'minimal' | 'low' | 'medium' | 'high';
    adaptiveConcurrency?: boolean;
    batchConcurrency?: number;
    batchMinConcurrency?: number;
    resolveGithubToken: (options?: { allowRefresh?: boolean; minimumTtlSeconds?: number }) => Promise<string | undefined>;
    sharedContextStore?: import('@orchestrace/context').SharedContextStore;
    agentId?: string;
    fileReadCache?: ReturnType<typeof createFileReadCache> | Map<string, { content: string; mtimeMs: number; size: number; readAt: number }>;
  },
) {
  return createAgentToolset({
    cwd,
    phase: options.phase,
    taskId: options.taskId,
    taskType: options.taskType,
    graphId: options.graphId,
    provider: options.provider,
    model: options.model,
    reasoning: options.reasoning,
    adaptiveConcurrency: options?.adaptiveConcurrency,
    batchConcurrency: options?.batchConcurrency,
    batchMinConcurrency: options?.batchMinConcurrency,
    resolveGithubToken: options.resolveGithubToken,
    sharedContextStore: options.sharedContextStore,
    fileReadCache: options.fileReadCache,
    agentId: options.agentId,
  });
}

export async function validateSessionProvidersReadiness(
  authManager: Pick<ProviderAuthManager, 'validateProviderReadiness'>,
  planningProvider: string,
  implementationProvider: string,
): Promise<{ ok: true } | { ok: false; error: string; statusCode: 400 }> {
  const phaseProviders: Array<{ phase: 'planning' | 'implementation'; provider: string }> = [
    { phase: 'planning', provider: planningProvider },
    { phase: 'implementation', provider: implementationProvider },
  ];

  for (const phaseConfig of phaseProviders) {
    const readiness = await authManager.validateProviderReadiness(phaseConfig.provider);
    if (!readiness.ok) {
      return {
        ok: false,
        error: `${phaseConfig.phase === 'planning' ? 'Planning' : 'Implementation'} provider is not ready: ${readiness.message}`,
        statusCode: 400,
      };
    }
  }

  return { ok: true };
}

export async function startUiServer(options: UiServerOptions = {}): Promise<void> {

  const port = options.port ?? 4310;
  const hmrEnabled = options.hmr ?? process.env.ORCHESTRACE_UI_HMR !== 'false';
  const workspaceManager = new WorkspaceManager(process.cwd());
  if (options.workspace) {
    await workspaceManager.selectWorkspace(options.workspace);
  }

    const authManager = new ProviderAuthManager();
  const githubAuthManager = createGithubAuthManager();
  const llm = new PiAiAdapter();

    const appAuthConfig = resolveAppAuthConfig();
  const appAuthEnabled = appAuthConfig.enabled;

    const resolveProviderApiKey = async (
    providerId: string,
    options?: { allowRefresh?: boolean },
  ): Promise<string | undefined> => authManager.resolveApiKey(providerId, options);


  // -- Persistent backend log stream ------------------------------------------
  const orchestraceDir = join(workspaceManager.getRootDir(), '.orchestrace');
  const backendLogger = new BackendLogger({ orchestraceDir });
  backendLogger.start();

    const workSessions = new Map<string, WorkSession>();

  const authSessions = new Map<string, AuthSession>();
  const githubDeviceAuthSessions = new Map<string, GithubDeviceAuthSession>();
  const sessionChats = new Map<string, SessionChatThread>();
  const sessionTodos = new Map<string, AgentTodoItem[]>();
  const sessionSharedContextStores = new Map<string, InMemorySharedContextStore>();
  const sessionFileReadCaches = new Map<string, ReturnType<typeof createFileReadCache>>();
  const sessionContextEngines = new Map<string, ContextEngine>();
  const sessionContextStates = new Map<string, SessionContextState>();
  const pendingSubagentNodeIdsBySession = new Map<string, Map<string, string[]>>();
  const worktreePathLocks = new Map<string, string>();
  const sessionObservers = new Map<string, SessionObserver>();
  const chatStreams = new Map<string, ChatTokenStream>();
  let uiPreferences = resolveUiPreferencesDefaults();
  const hmrClients = new Set<ServerResponse>();
  const workStreamClients = new Map<string, Set<ServerResponse>>();
  const chatStreamClients = new Map<string, Set<ServerResponse>>();
  const sessionStatusStreamClients = new Set<ServerResponse>();
  const logStreamClients = new Set<ServerResponse>();
    const uiStatePath = join(workspaceManager.getRootDir(), '.orchestrace', 'ui-state.json');

  function broadcastLogStreamEvent(event: string, payload: unknown): void {
    for (const client of [...logStreamClients]) {
      try {
        sendSse(client, event, payload);
      } catch {
        logStreamClients.delete(client);
      }
    }
  }

    function reportLogStreamError(input: {
    source: LogStreamErrorEvent['source'];
    operation: string;
    message: string;
    severity?: LogStreamErrorEvent['severity'];
    context?: Record<string, unknown>;
  }): void {

    const event: LogStreamErrorEvent = {
      errorId: randomUUID(),
      source: input.source,
      operation: input.operation,
      message: input.message,
      severity: input.severity ?? 'error',
      timestamp: now(),
      context: input.context,
    };

    console.error(
      `[orchestrace][${event.source}] ${event.operation}: ${event.message}`,
      event.context ?? {},
    );

        broadcastLogStreamEvent('log-error', event);
  }

  // Stream log lines to SSE clients
  backendLogger.onLine((line) => {
    broadcastLogStreamEvent('log', { line });
  });

  // Event store for durable session event logs (Phase 2: dual-write alongside in-memory state)

  const eventStore = new FileEventStore(
    join(workspaceManager.getRootDir(), '.orchestrace', 'sessions'),
  );

  /** Append a session event to the durable event store. Fire-and-forget; errors are logged. */
  function emitSessionEvent(sessionId: string, event: SessionEventInput): void {
    void eventStore.append(sessionId, event).catch((err) => {
      console.error(`[orchestrace][event-store] Failed to append event for ${sessionId}:`, err);
    });
  }

  function serializeSessionsSnapshot(): Record<string, unknown>[] {
    return [...workSessions.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((session) => serializeWorkSession(session, sessionTodos.get(session.id) ?? []));
  }

  function broadcastSessionStatusReady(target: ServerResponse): void {
    sendSse(target, 'ready', {
      sessions: serializeSessionsSnapshot(),
      time: now(),
    });
  }

  function broadcastSessionStatusUpsert(session: WorkSession): void {
    if (sessionStatusStreamClients.size === 0) {
      return;
    }

    const payload = {
      session: serializeWorkSession(session, sessionTodos.get(session.id) ?? []),
      time: now(),
    };

    for (const client of [...sessionStatusStreamClients]) {
      try {
        sendSse(client, 'session-upsert', payload);
      } catch {
        sessionStatusStreamClients.delete(client);
      }
    }
  }

    function broadcastSessionStatusDelete(id: string): void {
    if (sessionStatusStreamClients.size === 0) {
      return;
    }

    const payload = {
      id,
      time: now(),
    };

    for (const client of [...sessionStatusStreamClients]) {
      try {
        sendSse(client, 'session-delete', payload);
      } catch {
        sessionStatusStreamClients.delete(client);
      }
    }
  }

  function isPublicRoute(pathname: string): boolean {
    if (pathname === '/api/health') {
      return true;
    }

    if (pathname === '/api/app-auth/config' || pathname === '/api/app-auth/google' || pathname === '/api/app-auth/status') {
      return true;
    }

    if (pathname === '/' || pathname === '/settings' || pathname === '/settings/' || pathname === '/logs' || pathname === '/logs/') {
      return true;
    }

    if (hmrEnabled && pathname === '/__hmr') {
      return true;
    }

    return false;
  }

  function resolveRequestJwt(req: IncomingMessage, url: URL): string | undefined {
    const authHeader = asString(req.headers.authorization)?.trim();
    if (authHeader && authHeader.startsWith(APP_AUTH_BEARER_PREFIX)) {
      return authHeader.slice(APP_AUTH_BEARER_PREFIX.length).trim() || undefined;
    }

    const token = asString(url.searchParams.get('token'))?.trim();
    return token || undefined;
  }

  function requireAppAuth(req: IncomingMessage, res: ServerResponse, url: URL): AppAuthJwtPayload | undefined {
    if (!appAuthEnabled) {
      return undefined;
    }

    const token = resolveRequestJwt(req, url);
    if (!token) {
      sendJson(res, 401, { error: 'Authentication required' });
      return undefined;
    }

    const payload = verifyJwtToken(token, appAuthConfig.jwtSecret);
    if (!payload) {
      sendJson(res, 401, { error: 'Invalid or expired token' });
      return undefined;
    }

    return payload;
  }


  /**
   * Restore session state from the event store (event-sourced reads).
   * Returns the number of sessions restored. If no event logs exist,
   * returns 0 so the caller can fall back to legacy ui-state.json.
   */
  async function restoreFromEventStore(): Promise<number> {
    const sessionIds = await eventStore.listSessions();
    if (sessionIds.length === 0) return 0;

    let restored = 0;
    for (const sessionId of sessionIds) {
      try {
        const events = await eventStore.read(sessionId);
        if (events.length === 0) continue;

        const materialized = materializeFromEvents(events);
        if (!materialized) continue;

        const c = materialized.config;
        const legacyConfig = c as unknown as Record<string, unknown>;
        const resolvedAgentModels = resolveSessionAgentModels({
          provider: c.provider,
          model: c.model,
          planningProvider: c.planningProvider,
          planningModel: c.planningModel,
          implementationProvider: c.implementationProvider,
          implementationModel: c.implementationModel,
          agentModels: c.agentModels,
        });
        const session: WorkSession = {
          id: c.id,
          workspaceId: c.workspaceId,
          workspaceName: c.workspaceName,
          workspacePath: c.workspacePath,
          prompt: c.prompt,
          promptParts: c.promptParts,
          provider: resolvedAgentModels.implementationProvider,
          model: resolvedAgentModels.implementationModel,
          agentModels: resolvedAgentModels.agentModels,
          planningProvider: resolvedAgentModels.planningProvider,
          planningModel: resolvedAgentModels.planningModel,
          implementationProvider: resolvedAgentModels.implementationProvider,
          implementationModel: resolvedAgentModels.implementationModel,
          deliveryStrategy: normalizeSessionDeliveryStrategy(c.deliveryStrategy),
          autoApprove: c.autoApprove,
          planningNoToolGuardMode: normalizePlanningNoToolGuardMode(c.planningNoToolGuardMode)
            ?? resolvePlanningNoToolGuardModeDefault(),
          quickStartMode: c.quickStartMode,
          quickStartMaxPreDelegationToolCalls: c.quickStartMaxPreDelegationToolCalls,
          adaptiveConcurrency: c.adaptiveConcurrency,
          batchConcurrency: c.batchConcurrency,
          batchMinConcurrency: c.batchMinConcurrency,
          enableTrivialTaskGate: c.enableTrivialTaskGate ?? resolveTrivialTaskGateDefault(),
          trivialTaskMaxPromptLength: c.trivialTaskMaxPromptLength ?? resolveTrivialTaskMaxPromptLengthDefault(),
          worktreePath: c.worktreePath,
          worktreeBranch: c.worktreeBranch,
          workspaceAssignment: isRecord(legacyConfig.workspaceAssignment)
            ? {
              assignmentSource: normalizeWorkspaceAssignmentSource(legacyConfig.workspaceAssignment.assignmentSource) ?? 'workspace-root',
              reusedExistingWorktree: parseBooleanSetting(legacyConfig.workspaceAssignment.reusedExistingWorktree) ?? undefined,
              cleanupApplied: parseBooleanSetting(legacyConfig.workspaceAssignment.cleanupApplied) ?? undefined,
              cleanupDefaultBranch: asString(legacyConfig.workspaceAssignment.cleanupDefaultBranch) || undefined,
              workspacePathSessionIdRelation: normalizeWorkspacePathSessionIdRelation(
                legacyConfig.workspaceAssignment.workspacePathSessionIdRelation,
              ),
              workspacePathSessionId: asString(legacyConfig.workspaceAssignment.workspacePathSessionId) || undefined,
            }
            : undefined,
          creationReason: c.creationReason,
          sourceSessionId: c.sourceSessionId,
          source: c.source,
          createdAt: materialized.createdAt,
          updatedAt: materialized.updatedAt,
          status: materialized.status,
          llmStatus: materialized.llmStatus,
          taskStatus: materialized.taskStatus,
          events: materialized.events as UiDagEvent[],
          agentGraph: materialized.agentGraph,
          error: materialized.error,
          output: materialized.output,
          lastCheckpoint: materialized.lastCheckpoint as SessionCheckpointInfo | undefined,
          lastRecovery: materialized.lastRecovery as SessionRecoveryInfo | undefined,
          controller: new AbortController(),
        };

        // If the session was 'running', check if the runner process is still alive
        if (session.status === 'running') {
          const meta = await eventStore.getMetadata(sessionId);
          let runnerAlive = false;
          if (meta?.pid) {
            try {
              process.kill(meta.pid, 0); // Signal 0 checks if process exists
              runnerAlive = true;
            } catch {
              // Process is dead
            }
          }

          if (runnerAlive) {
            // Runner is still alive — set up event watcher to observe its progress
            console.log(`[orchestrace][event-store] Session ${sessionId}: runner PID ${meta!.pid} is alive, reconnecting...`);
            const lastSeq = events[events.length - 1]?.seq ?? 0;
            const unwatch = eventStore.watch(sessionId, lastSeq, (event) => {
              session.updatedAt = event.time;
              switch (event.type) {
                case 'session:llm-status-change':
                  session.llmStatus = event.payload.llmStatus as SessionLlmStatus;
                  break;
                case 'session:status-change': {
                  const newStatus = event.payload.status as WorkState;
                  session.status = newStatus;
                  if (newStatus === 'completed' || newStatus === 'failed' || newStatus === 'cancelled') {
                    broadcastWorkStream(workStreamClients, sessionId, newStatus === 'completed' ? 'end' : 'error', {
                      id: sessionId, status: session.status, llmStatus: session.llmStatus, error: session.error, time: event.time,
                    });
                    unwatch();
                  }
                  break;
                }
                case 'session:error-change':
                  session.error = event.payload.error as string | undefined;
                  break;
                case 'session:output-set':
                  session.output = event.payload.output as WorkSession['output'];
                  break;
                case 'session:dag-event': {
                  const uiEvent = event.payload.event as UiDagEvent;
                  session.events.push(uiEvent);
                  if (session.events.length > SESSION_EVENT_HISTORY_LIMIT) session.events.shift();
                  break;
                }
                case 'session:stream-delta': {
                  const p = event.payload as { taskId: string; phase: string; delta: string };
                  broadcastWorkStream(workStreamClients, sessionId, 'token', {
                    id: sessionId, taskId: p.taskId, phase: p.phase, delta: p.delta, llmStatus: session.llmStatus, time: event.time,
                  });
                  break;
                }
                case 'session:task-status-change': {
                  const p = event.payload as { taskId: string; taskStatus: string };
                  session.taskStatus[p.taskId] = p.taskStatus;
                  break;
                }
                case 'session:todos-set': {
                  const items = (event.payload as { items: AgentTodoItem[] }).items;
                  sessionTodos.set(sessionId, items);
                  broadcastTodoUpdate(workStreamClients, sessionId, items);
                  break;
                }
                case 'session:todo-item-added': {
                  const item = (event.payload as { item: AgentTodoItem }).item;
                  const existing = sessionTodos.get(sessionId) ?? [];
                  existing.push(item);
                  sessionTodos.set(sessionId, existing);
                  broadcastTodoUpdate(workStreamClients, sessionId, existing);
                  break;
                }
                case 'session:todo-item-toggled': {
                  const p = event.payload as { itemId: string; done: boolean; status?: string };
                  const items = sessionTodos.get(sessionId) ?? [];
                  const idx = items.findIndex((i) => i.id === p.itemId);
                  if (idx >= 0) {
                    items[idx] = { ...items[idx], done: p.done, status: (p.status as AgentTodoItem['status']) ?? items[idx].status, updatedAt: event.time };
                    broadcastTodoUpdate(workStreamClients, sessionId, items);
                  }
                  break;
                }
                case 'session:agent-graph-set': {
                  session.agentGraph = (event.payload as { graph: SessionAgentGraphNode[] }).graph;
                  break;
                }
                case 'session:checkpoint': {
                  session.lastCheckpoint = {
                    ...(event.payload as SessionCheckpointPayload),
                    time: event.time,
                  };
                  break;
                }
                case 'session:recovery-detected': {
                  session.lastRecovery = {
                    ...(event.payload as SessionRecoveryDetectedPayload),
                    time: event.time,
                  };
                  break;
                }
                case 'session:chat-message': {
                  const msg = (event.payload as { message: SessionChatMessage }).message;
                  const thread = sessionChats.get(sessionId);
                  if (thread) {
                    thread.messages.push(msg);
                    trimThreadMessages(thread);
                    thread.updatedAt = event.time;
                  }
                  break;
                }
                default:
                  break;
              }
              // Broadcast session state for all events except high-frequency stream deltas
              if (event.type !== 'session:stream-delta') {
                broadcastSessionUpdate(workStreamClients, sessionId, serializeWorkSession(session, sessionTodos.get(sessionId) ?? []));
              }

              if (event.type === 'session:status-change' || event.type === 'session:llm-status-change' || event.type === 'session:error-change') {
                broadcastSessionStatusUpsert(session);
              }

              uiStatePersistence.schedule();
            });
          } else {
            // Runner is dead — mark session as failed with recovery guidance
            const failedAt = now();
            const recoveryGit = await inspectGitRecoveryState(session.worktreePath ?? session.workspacePath);
            session.lastRecovery = {
              reason: 'restore-dead-runner',
              runnerPid: meta?.pid,
              git: recoveryGit,
              time: failedAt,
            };
            const recoveryHint = recoveryGit.dirty
              ? 'Uncommitted changes were detected; review git diff/status to recover work from the crash.'
              : 'No uncommitted changes were detected; resume from the latest checkpoint commit.';
            session.status = 'failed';
            session.error = `Session interrupted because the runner process exited. ${recoveryHint}`;
            session.updatedAt = failedAt;
            session.llmStatus = createLlmStatus('failed', failedAt, {
              detail: session.error,
            });
            emitSessionEvent(sessionId, {
              time: failedAt,
              type: 'session:recovery-detected',
              payload: {
                reason: 'restore-dead-runner',
                runnerPid: meta?.pid,
                git: recoveryGit,
              },
            });
            emitSessionEvent(sessionId, { time: failedAt, type: 'session:error-change', payload: { error: session.error } });
            emitSessionEvent(sessionId, { time: failedAt, type: 'session:llm-status-change', payload: { llmStatus: session.llmStatus } });
            emitSessionEvent(sessionId, { time: failedAt, type: 'session:status-change', payload: { status: 'failed' } });
          }
        }

        workSessions.set(sessionId, session);

        // Restore chat thread
        if (materialized.chatThread) {
          const ct = materialized.chatThread;
          sessionChats.set(sessionId, {
            sessionId,
            provider: ct.provider,
            model: ct.model,
            workspacePath: ct.workspacePath,
            taskPrompt: ct.taskPrompt,
            createdAt: ct.createdAt,
            updatedAt: ct.updatedAt,
            messages: ct.messages,
          });
        }

        // Restore todos
        if (materialized.todos.length > 0) {
          sessionTodos.set(sessionId, materialized.todos);
        }

        restored++;
      } catch (err) {
        console.error(`[orchestrace][event-store][restore] Error restoring session ${sessionId}:`, err);
      }
    }

    const reconnected = [...workSessions.values()].filter((s) => s.status === 'running').length;
    const totalRestored = restored;
    if (reconnected > 0) {
      console.log(`[orchestrace][event-store] Restored ${totalRestored}/${sessionIds.length} sessions from event logs (${reconnected} running — reconnected to live runners).`);
    } else {
      console.log(`[orchestrace][event-store] Restored ${totalRestored}/${sessionIds.length} sessions from event logs.`);
    }
    return restored;
  }

  /**
   * Migrate sessions from legacy ui-state.json into the event store.
   * Synthesizes a minimal event log for each session so subsequent restarts use event logs.
   */
  async function migrateUiStateToEventStore(): Promise<void> {
    for (const [sessionId, session] of workSessions.entries()) {
      try {
        const existing = await eventStore.read(sessionId);
        if (existing.length > 0) continue; // Already has events

        const t = session.createdAt;
        const events: SessionEventInput[] = [];

        // session:created
        events.push({
          time: t,
          type: 'session:created',
          payload: {
            config: {
              id: session.id,
              workspaceId: session.workspaceId,
              workspaceName: session.workspaceName,
              workspacePath: session.workspacePath,
              prompt: session.prompt,
              promptParts: session.promptParts,
              provider: session.provider,
              model: session.model,
              autoApprove: session.autoApprove,
              planningNoToolGuardMode: session.planningNoToolGuardMode,
              quickStartMode: session.quickStartMode,
              quickStartMaxPreDelegationToolCalls: session.quickStartMaxPreDelegationToolCalls,
              adaptiveConcurrency: session.adaptiveConcurrency,
              batchConcurrency: session.batchConcurrency,
              batchMinConcurrency: session.batchMinConcurrency,
              worktreePath: session.worktreePath,
              worktreeBranch: session.worktreeBranch,
              creationReason: session.creationReason,
              sourceSessionId: session.sourceSessionId,
            },
          },
        });

        // dag events
        for (const evt of session.events) {
          events.push({ time: evt.time, type: 'session:dag-event', payload: { event: evt } });
        }

        // agent graph
        if (session.agentGraph.length > 0) {
          events.push({ time: t, type: 'session:agent-graph-set', payload: { graph: session.agentGraph } });
        }

        // todos
        const todos = sessionTodos.get(sessionId);
        if (todos && todos.length > 0) {
          events.push({ time: t, type: 'session:todos-set', payload: { items: todos } });
        }

        // chat thread
        const chatThread = sessionChats.get(sessionId);
        if (chatThread) {
          events.push({
            time: chatThread.createdAt,
            type: 'session:chat-thread-created',
            payload: {
              provider: chatThread.provider,
              model: chatThread.model,
              workspacePath: chatThread.workspacePath,
              taskPrompt: chatThread.taskPrompt,
            },
          });
          for (const msg of chatThread.messages) {
            events.push({ time: msg.time, type: 'session:chat-message', payload: { message: msg } });
          }
        }

        // Terminal state
        if (session.output) {
          events.push({ time: session.updatedAt, type: 'session:output-set', payload: { output: session.output } });
        }
        if (session.error) {
          events.push({ time: session.updatedAt, type: 'session:error-change', payload: { error: session.error } });
        }
        events.push({ time: session.updatedAt, type: 'session:llm-status-change', payload: { llmStatus: session.llmStatus } });
        events.push({ time: session.updatedAt, type: 'session:status-change', payload: { status: session.status } });

        await eventStore.appendBatch(sessionId, events);
      } catch (err) {
        console.error(`[orchestrace][event-store][migrate] Error migrating session ${sessionId}:`, err);
      }
    }
  }

  async function refreshSessionFromEventStore(sessionId: string): Promise<boolean> {
    const existing = workSessions.get(sessionId);
    if (!existing) {
      return false;
    }

    try {
      const events = await eventStore.read(sessionId);
      if (events.length === 0) {
        return false;
      }

      const materialized = materializeFromEvents(events);
      if (!materialized) {
        return false;
      }

      existing.updatedAt = materialized.updatedAt;
      existing.status = materialized.status;
      existing.llmStatus = materialized.llmStatus;
      existing.taskStatus = { ...materialized.taskStatus };
      existing.events = materialized.events as UiDagEvent[];
      existing.agentGraph = materialized.agentGraph;
      existing.error = materialized.error;
      existing.output = materialized.output;

      if (materialized.chatThread) {
        const thread = materialized.chatThread;
        sessionChats.set(sessionId, {
          sessionId,
          provider: thread.provider,
          model: thread.model,
          workspacePath: thread.workspacePath,
          taskPrompt: thread.taskPrompt,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          messages: thread.messages,
        });
      }

      sessionTodos.set(sessionId, materialized.todos);
      return true;
    } catch (err) {
      console.error(`[orchestrace][event-store][refresh] Error refreshing session ${sessionId}:`, err);
      return false;
    }
  }

  // Restore sessions: try event store first, fall back to legacy ui-state.json
  const eventStoreSessionCount = await restoreFromEventStore();
  let restoredUiPreferences: PersistedUiPreferences | undefined;
  if (eventStoreSessionCount === 0) {
    // No event logs — try legacy restoration and migrate
    restoredUiPreferences = await restoreUiState(uiStatePath, workSessions, sessionChats, sessionTodos);
    if (workSessions.size > 0) {
      console.log(`[orchestrace][event-store] Migrating ${workSessions.size} sessions from ui-state.json to event store...`);
      await migrateUiStateToEventStore();
    }
  } else {
    // Event store is authoritative; only read preferences from legacy file
    const payload = await readPersistedUiState(uiStatePath).catch(() => null);
    restoredUiPreferences = payload?.preferences;
  }
  uiPreferences = normalizeUiPreferences(restoredUiPreferences, resolveUiPreferencesDefaults());

  await detectStartupPartialChangesAndRecover();

  for (const [sessionId, restoredSession] of workSessions.entries()) {
    sessionSharedContextStores.set(sessionId, new InMemorySharedContextStore());
    sessionContextEngines.set(sessionId, createSessionContextEngine(restoredSession.provider, restoredSession.model));
    sessionContextStates.set(sessionId, { turnsSinceLastCompaction: 0 });
  }

  const uiStatePersistence = createUiStatePersistence(
    uiStatePath,
    workSessions,
    sessionChats,
    sessionTodos,
    () => ({ ...uiPreferences }),
  );

  function createCompactionDelegate(defaultProvider: string, defaultModel: string) {
    return {
      summarize: async (text: string, maxTokens: number, signal?: AbortSignal): Promise<string> => {
        const preferredProvider = asString(process.env[CONTEXT_COMPACTION_PROVIDER_ENV]) || defaultProvider;
        const preferredModel = asString(process.env[CONTEXT_COMPACTION_MODEL_ENV]) || DEFAULT_CONTEXT_COMPACTION_MODEL;

        const candidates: Array<{ provider: string; model: string }> = [];
        const addCandidate = (provider: string, model: string): void => {
          if (!provider || !model) {
            return;
          }
          if (candidates.some((entry) => entry.provider === provider && entry.model === model)) {
            return;
          }
          candidates.push({ provider, model });
        };

        addCandidate(preferredProvider, preferredModel);
        addCandidate(defaultProvider, defaultModel);

        for (const candidate of candidates) {
          try {
            const result = await llm.complete({
              provider: candidate.provider,
              model: candidate.model,
              systemPrompt: 'You compress conversation history into structured technical summaries while preserving decisions, blockers, and key details.',
              prompt: text,
              timeoutMs: Math.min(resolveLongTurnTimeoutMs(), 20_000),
              signal,
                            apiKey: await resolveProviderApiKey(candidate.provider),
              refreshApiKey: () => resolveProviderApiKey(candidate.provider),
              allowAuthRefreshRetry: true,


            });

            const trimmed = trimCompactionSummary(result.text, maxTokens);
            if (trimmed) {
              return trimmed;
            }
          } catch {
            // Try next candidate before degrading to heuristic-only fallback.
          }
        }

        return buildCompactionFallbackSummary(text, maxTokens);
      },
    };
  }

  function createSessionContextEngine(provider: string, model: string): ContextEngine {
    const modelInfo: ModelInfo = llm.getModelInfo(provider, model);
    return new ContextEngine({
      modelInfo,
      compactionDelegate: createCompactionDelegate(provider, model),
    });
  }

  async function readSessionCheckpointMetadata(sessionId: string): Promise<SessionCheckpointMetadata | undefined> {
    try {
      const checkpointPath = join(workspaceManager.getRootDir(), '.orchestrace', 'sessions', sessionId, SESSION_CHECKPOINT_FILE);
      const raw = await readFile(checkpointPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SessionCheckpointMetadata>;
      if (!parsed || typeof parsed !== 'object') return undefined;
      if (typeof parsed.sessionId !== 'string' || typeof parsed.workspacePath !== 'string' || typeof parsed.state !== 'string') {
        return undefined;
      }
      return parsed as SessionCheckpointMetadata;
    } catch {
      return undefined;
    }
  }

  async function getWorkspaceDirtySummary(workspacePath: string): Promise<{
    hasUncommittedChanges: boolean;
    hasStagedChanges: boolean;
    hasUntrackedChanges: boolean;
    dirtySummary: string[];
  }> {
    const [unstaged, staged, untracked] = await Promise.all([
      gitExec(workspacePath, ['diff', '--name-status']).catch(() => ''),
      gitExec(workspacePath, ['diff', '--cached', '--name-status']).catch(() => ''),
      gitExec(workspacePath, ['ls-files', '--others', '--exclude-standard']).catch(() => ''),
    ]);
    const unstagedLines = unstaged.split('\n').map((line) => line.trim()).filter(Boolean);
    const stagedLines = staged.split('\n').map((line) => line.trim()).filter(Boolean);
    const untrackedLines = untracked.split('\n').map((line) => line.trim()).filter(Boolean);
    return {
      hasUncommittedChanges: unstagedLines.length > 0,
      hasStagedChanges: stagedLines.length > 0,
      hasUntrackedChanges: untrackedLines.length > 0,
      dirtySummary: [...unstagedLines, ...stagedLines, ...untrackedLines.map((line) => `?? ${line}`)].slice(0, 200),
    };
  }

  async function maybeRollbackFromCheckpoint(workspacePath: string, checkpoint?: SessionCheckpointMetadata): Promise<boolean> {
    const recoveryMode = (process.env[STARTUP_RECOVERY_MODE_ENV] ?? 'flag').trim().toLowerCase();
    if (recoveryMode !== 'rollback') {
      return false;
    }
    if (!checkpoint?.stashRef) {
      return false;
    }
    if (!checkpoint.stashMessage?.includes(CHECKPOINT_STASH_PREFIX)) {
      return false;
    }

    try {
      await gitExec(workspacePath, ['stash', 'apply', '--index', checkpoint.stashRef]);
      return true;
    } catch (error) {
      console.warn(`[ui-server] Failed startup rollback from checkpoint ${checkpoint.stashRef}: ${toErrorMessage(error)}`);
      return false;
    }
  }

  async function detectStartupPartialChangesAndRecover(): Promise<void> {
    for (const [sessionId, session] of workSessions.entries()) {
      const interrupted =
        session.status === 'failed'
        && typeof session.error === 'string'
        && session.error.toLowerCase().includes('runner process exited');
      if (!interrupted) {
        continue;
      }

      const checkpoint = await readSessionCheckpointMetadata(sessionId);
      const checkpointSuggestsRecovery = checkpoint && (checkpoint.state === 'active' || checkpoint.state === 'interrupted');

      const rolledBack = checkpointSuggestsRecovery
        ? await maybeRollbackFromCheckpoint(session.workspacePath, checkpoint)
        : false;
      const dirty = await getWorkspaceDirtySummary(session.workspacePath).catch((error) => {
        console.warn(`[ui-server] Startup recovery probe failed for session ${sessionId}: ${toErrorMessage(error)}`);
        return {
          hasUncommittedChanges: false,
          hasStagedChanges: false,
          hasUntrackedChanges: false,
          dirtySummary: [] as string[],
        };
      });

      const hasDirty = dirty.hasUncommittedChanges || dirty.hasStagedChanges || dirty.hasUntrackedChanges;
      if (!hasDirty && !rolledBack) {
        continue;
      }

      const details = [
        rolledBack ? 'Applied rollback from checkpoint stash.' : 'Detected partial local changes from prior interrupted session.',
        ...dirty.dirtySummary.slice(0, 10),
      ].join('\n');

      const failureType = rolledBack ? 'startup-recovery-rollback' : 'startup-recovery-dirty';
      const recoveredAt = now();
      const error = rolledBack
        ? `Recovered interrupted session from checkpoint (${checkpoint?.stashRef ?? 'unknown stash'}).`
        : `Startup recovery detected uncommitted changes from interrupted session.\n${details}`;

      session.error = error;
      session.updatedAt = recoveredAt;
      session.llmStatus = createLlmStatus('failed', recoveredAt, {
        detail: error,
        failureType,
      });
      session.output = {
        ...session.output,
        failureType,
      };

      emitSessionEvent(sessionId, { time: recoveredAt, type: 'session:error-change', payload: { error } });
      emitSessionEvent(sessionId, { time: recoveredAt, type: 'session:llm-status-change', payload: { llmStatus: session.llmStatus } });
      emitSessionEvent(sessionId, { time: recoveredAt, type: 'session:output-set', payload: { output: session.output } });
      console.log(`[ui-server] Startup recovery ${rolledBack ? 'rollback' : 'dirty-flag'} for session ${sessionId}.`);
    }
  }

  function deleteWorkSession(id: string): boolean {
    const session = workSessions.get(id);
    if (!session) {
      return false;
    }

    if (session.status === 'running') {
      // Kill the detached runner process so it doesn't keep heartbeating after deletion.
      void eventStore.getMetadata(id).then((meta) => {
        if (meta?.pid) {
          const pid = meta.pid;
          try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
          // Give it a short grace period, then SIGKILL if still alive (e.g. blocked on network I/O).
          setTimeout(() => {
            try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
          }, 3000);
        }
      }).catch(() => { /* ignore */ });
      session.controller.abort();
      session.status = 'cancelled';
      session.updatedAt = now();
      session.llmStatus = createLlmStatus('cancelled', session.updatedAt, {
        detail: 'Cancelled by user.',
      });
      // Dual-write: cancellation before deletion
      emitSessionEvent(id, {
        time: session.updatedAt,
        type: 'session:llm-status-change',
        payload: { llmStatus: session.llmStatus },
      });
      emitSessionEvent(id, {
        time: session.updatedAt,
        type: 'session:status-change',
        payload: { status: 'cancelled' },
      });
        }

    // Clean up any auto-created per-session worktree.
    if (session.cleanupWorktree) {
      void session.cleanupWorktree().catch(() => {});
      session.cleanupWorktree = undefined;
    } else if (session.worktreePath && session.worktreeBranch === resolveSessionWorktreeBranch(id)) {
      const worktreePath = session.worktreePath;
      const worktreeBranch = session.worktreeBranch;
      // Persisted/restored sessions do not retain cleanupWorktree callback.
      // Fall back to direct cleanup so deleting a session always removes its managed worktree from disk.
      void (async () => {
        try {
          const repoRoot = (await gitExec(worktreePath, ['rev-parse', '--show-toplevel'])).trim();
          if (!repoRoot) {
            return;
          }
          await cleanupSessionWorktree({
            repoRoot,
            sessionId: id,
            worktreePath,
            branchName: worktreeBranch,
          });
        } catch {
          // Ignore cleanup failures during delete.
        }
      })();
    }

    closeWorkStream(workStreamClients, id);

    workSessions.delete(id);
    sessionChats.delete(id);
    sessionTodos.delete(id);
    sessionSharedContextStores.delete(id);
    sessionContextEngines.delete(id);
    sessionContextStates.delete(id);
    pendingSubagentNodeIdsBySession.delete(id);

    for (const [streamId, streamState] of [...chatStreams.entries()]) {
      if (streamState.sessionId !== id) {
        continue;
      }

      closeWorkStream(chatStreamClients, streamId);
      chatStreams.delete(streamId);
    }

    // Dual-write: delete event store data
    void eventStore.deleteSession(id).catch((err) => {
      console.error(`[orchestrace][event-store] Failed to delete session ${id}:`, err);
    });

    broadcastSessionStatusDelete(id);

    uiStatePersistence.schedule();
    return true;
  }

  function toSessionConfig(session: WorkSession): SessionConfig {
    const resolvedAgentModels = resolveSessionAgentModels({
      provider: session.provider,
      model: session.model,
      planningProvider: session.planningProvider,
      planningModel: session.planningModel,
      implementationProvider: session.implementationProvider,
      implementationModel: session.implementationModel,
      agentModels: session.agentModels,
    });
    return {
      id: session.id,
      workspaceId: session.workspaceId,
      workspaceName: session.workspaceName,
      workspacePath: session.workspacePath,
      prompt: session.executionPromptOverride ?? session.prompt,
      promptParts: session.promptParts ? cloneChatContentParts(session.promptParts) : undefined,
      provider: resolvedAgentModels.implementationProvider,
      model: resolvedAgentModels.implementationModel,
      agentModels: resolvedAgentModels.agentModels,
      planningProvider: resolvedAgentModels.planningProvider,
      planningModel: resolvedAgentModels.planningModel,
      implementationProvider: resolvedAgentModels.implementationProvider,
      implementationModel: resolvedAgentModels.implementationModel,
      deliveryStrategy: session.deliveryStrategy,
      autoApprove: session.autoApprove,
      planningNoToolGuardMode: session.planningNoToolGuardMode,
      quickStartMode: session.quickStartMode,
      quickStartMaxPreDelegationToolCalls: session.quickStartMaxPreDelegationToolCalls,
      adaptiveConcurrency: session.adaptiveConcurrency,
      batchConcurrency: session.batchConcurrency,
      batchMinConcurrency: session.batchMinConcurrency,
      enableTrivialTaskGate: session.enableTrivialTaskGate,
      trivialTaskMaxPromptLength: session.trivialTaskMaxPromptLength,
      worktreePath: session.worktreePath,
      worktreeBranch: session.worktreeBranch,
      creationReason: session.creationReason,
      sourceSessionId: session.sourceSessionId,
      source: session.source,
    };
  }

    async function resolveWorkspaceRuntimePath(workspacePath: string): Promise<{ workspacePath: string; warning?: string }> {
        const check = await validateWorkspaceRuntime(workspacePath);
    assertWorkspaceRuntimeIsComplete(check);
    return {
      workspacePath: check.normalizedPath,
      warning: formatMissingSourceDirsWarning(check.normalizedPath, check.missingExpectedDirs),
    };
  }

  async function initializeManagedSessionWorkspace(params: {
    sessionId: string;
    workspaceRoot: string;
    worktreePath?: string;
    worktreeBranch?: string;
  }): Promise<{
    workspacePath: string;
    worktreePath: string;
    worktreeBranch: string;
    cleanupWorktree: () => Promise<void>;
    warnings: string[];
  }> {
    const managedWorktree = await ensureSessionWorktree({
      repoRoot: params.workspaceRoot,
      sessionId: params.sessionId,
      worktreePath: params.worktreePath,
      branchName: params.worktreeBranch,
    });

    const warnings: string[] = [];
    if (managedWorktree.recreated && !managedWorktree.created) {
      warnings.push(`Recreated session worktree for session ${params.sessionId}.`);
    }

    const runtimePath = await resolveWorkspaceRuntimePath(managedWorktree.worktreePath);
    if (runtimePath.warning) {
      warnings.push(runtimePath.warning);
    }

    return {
      workspacePath: runtimePath.workspacePath,
      worktreePath: runtimePath.workspacePath,
      worktreeBranch: managedWorktree.branchName,
      cleanupWorktree: async () => {
        await cleanupSessionWorktree({
          repoRoot: params.workspaceRoot,
          sessionId: params.sessionId,
          worktreePath: runtimePath.workspacePath,
          branchName: managedWorktree.branchName,
        });
      },
      warnings,
    };
  }

  async function appendSessionCreatedEvent(session: WorkSession, time: string): Promise<void> {
    await eventStore.append(session.id, {
      time,
      type: 'session:created',
      payload: { config: toSessionConfig(session) },
    });
  }

  async function launchSessionRunner(session: WorkSession): Promise<void> {
    const id = session.id;
    const events = await eventStore.read(id);
    const watchFromSeq = events.length > 0 ? events[events.length - 1].seq : 0;

    // Watch event store for updates from the runner.
    const unwatch = eventStore.watch(id, watchFromSeq, (event) => {
      session.updatedAt = event.time;

      switch (event.type) {
        case 'session:llm-status-change':
          session.llmStatus = event.payload.llmStatus as SessionLlmStatus;
          break;

        case 'session:status-change': {
          const newStatus = event.payload.status as WorkState;
          session.status = newStatus;
          if (newStatus === 'completed' || newStatus === 'failed' || newStatus === 'cancelled') {
            // Terminal state — broadcast end event, stop watching, and stop observer.
            const obs = sessionObservers.get(id);
            if (obs) {
              obs.stop();
              sessionObservers.delete(id);
            }
            // Notify the observer daemon: close the loop on findings (auto-resolve if PR opened)
            observerDaemon.onFixSessionCompleted(id, newStatus, session.output?.text);
            broadcastWorkStream(workStreamClients, id, newStatus === 'completed' ? 'end' : 'error', {
              id,
              status: session.status,
              llmStatus: session.llmStatus,
              error: session.error,
              time: event.time,
            });
            unwatch();
          }
          break;
        }

        case 'session:error-change':
          session.error = event.payload.error as string | undefined;
          break;

        case 'session:output-set':
          session.output = event.payload.output as WorkSession['output'];
          break;

        case 'session:dag-event': {
          const uiEvent = event.payload.event as UiDagEvent;
          session.events.push(uiEvent);
          if (session.events.length > SESSION_EVENT_HISTORY_LIMIT) session.events.shift();
          break;
        }

        case 'session:stream-delta': {
          const p = event.payload as { taskId: string; phase: string; delta: string };
          broadcastWorkStream(workStreamClients, id, 'token', {
            id,
            taskId: p.taskId,
            phase: p.phase,
            delta: p.delta,
            llmStatus: session.llmStatus,
            time: event.time,
          });
          break;
        }

        case 'session:task-status-change': {
          const p = event.payload as { taskId: string; taskStatus: string };
          session.taskStatus[p.taskId] = p.taskStatus;
          break;
        }

        case 'session:todos-set': {
          const items = (event.payload as { items: AgentTodoItem[] }).items;
          sessionTodos.set(id, items);
          broadcastTodoUpdate(workStreamClients, id, items);
          break;
        }

        case 'session:todo-item-added': {
          const item = (event.payload as { item: AgentTodoItem }).item;
          const existing = sessionTodos.get(id) ?? [];
          existing.push(item);
          sessionTodos.set(id, existing);
          broadcastTodoUpdate(workStreamClients, id, existing);
          break;
        }

        case 'session:todo-item-toggled': {
          const p = event.payload as { itemId: string; done: boolean; status?: string };
          const items = sessionTodos.get(id) ?? [];
          const idx = items.findIndex((i) => i.id === p.itemId);
          if (idx >= 0) {
            items[idx] = {
              ...items[idx],
              done: p.done,
              status: (p.status as AgentTodoItem['status']) ?? items[idx].status,
              updatedAt: event.time,
            };
            broadcastTodoUpdate(workStreamClients, id, items);
          }
          break;
        }

        case 'session:agent-graph-set': {
          const graph = (event.payload as { graph: SessionAgentGraphNode[] }).graph;
          session.agentGraph = graph;
          break;
        }

        case 'session:agent-graph-node-status': {
          const p = event.payload as { nodeId: string; status: string };
          session.agentGraph = session.agentGraph.map((node) =>
            node.id === p.nodeId ? { ...node, status: p.status as SessionAgentGraphNode['status'] } : node,
          );
          break;
        }

        case 'session:checkpoint': {
          session.lastCheckpoint = {
            ...(event.payload as SessionCheckpointPayload),
            time: event.time,
          };
          break;
        }

        case 'session:recovery-detected': {
          session.lastRecovery = {
            ...(event.payload as SessionRecoveryDetectedPayload),
            time: event.time,
          };
          break;
        }

        case 'session:chat-message': {
          const msg = (event.payload as { message: SessionChatMessage }).message;
          const thread = sessionChats.get(id);
          if (thread) {
            thread.messages.push(msg);
            trimThreadMessages(thread);
            thread.updatedAt = event.time;
          }
          break;
        }

        // Observer real-time events — broadcast to UI via SSE.
        case 'session:observer-status-change': {
          broadcastWorkStream(workStreamClients, id, 'observer-status', {
            id,
            observer: event.payload,
            time: event.time,
          });
          break;
        }

        case 'session:observer-finding': {
          broadcastWorkStream(workStreamClients, id, 'observer-finding', {
            id,
            finding: (event.payload as { finding: unknown }).finding,
            time: event.time,
          });
          break;
        }

        default:
          break;
      }

      // Broadcast session state for all events except high-frequency stream deltas and observer events.
      if (event.type !== 'session:stream-delta' && event.type !== 'session:observer-status-change' && event.type !== 'session:observer-finding') {
        broadcastSessionUpdate(workStreamClients, id, serializeWorkSession(session, sessionTodos.get(id) ?? []));
      }

      if (event.type === 'session:status-change' || event.type === 'session:llm-status-change' || event.type === 'session:error-change') {
        broadcastSessionStatusUpsert(session);
      }

      uiStatePersistence.schedule();
    });

        // Spawn runner as a detached child process.
    const runnerPath = join(dirname(fileURLToPath(import.meta.url)), 'runner.ts');
    const runnerProcess = spawn(
      process.execPath,
      [...(process.execArgv.length > 0 ? process.execArgv : ['--import', 'tsx']), runnerPath, id, workspaceManager.getRootDir()],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: session.workspacePath,
        env: {
          ...process.env,
          ORCHESTRACE_SESSION_ID: id,
          ORCHESTRACE_TASK_ROUTE: resolveRunnerTaskRouteEnvValue(process.env.ORCHESTRACE_TASK_ROUTE),
        },
      },
    );


    // Capture runner stdout/stderr to persistent log stream.
    if (runnerProcess.stdout) {
      let stdoutBuf = '';
      runnerProcess.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) backendLogger.appendRunnerLine(id, 'stdout', line);
        }
      });
    }
    if (runnerProcess.stderr) {
      let stderrBuf = '';
      runnerProcess.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) backendLogger.appendRunnerLine(id, 'stderr', line);
        }
      });
    }
    runnerProcess.unref();

    // Record runner PID in metadata.
    void eventStore.setMetadata(id, {
      id,
      pid: runnerProcess.pid ?? 0,
      createdAt: now(),
      workspacePath: session.workspacePath,
    });

    // Attach per-session real-time observer (if observer is enabled and session is not from observer itself).
    if (observerDaemon.getConfig().enabled && session.source !== 'observer') {
      const sessionObs = new SessionObserver({
        sessionId: id,
        eventStore,
        llm,
        config: observerDaemon.getConfig(),
        resolveApiKey: (provider) => resolveProviderApiKey(provider),
        emit: (evt) => {
          emitSessionEvent(id, {
            time: new Date().toISOString(),
            type: evt.type as 'session:observer-status-change' | 'session:observer-finding',
            payload: evt.payload as Record<string, unknown>,
          });

          if (evt.type === 'session:observer-finding') {
            const finding = (evt.payload as { finding?: RealtimeFinding }).finding;
            if (finding) {
                            void observerDaemon.ingestSessionObserverFindings(id, [finding]).catch((error) => {
                reportLogStreamError({
                  source: 'session-observer-ingestion',
                  operation: 'ingest-session-observer-findings',
                  message: toErrorMessage(error),
                  context: {
                    sessionId: id,
                    findingTitle: finding.title,
                    category: finding.category,
                    severity: finding.severity,
                    relevantFiles: finding.relevantFiles ?? [],
                  },
                });
              });

            }
          }
        },
      });
      sessionObservers.set(id, sessionObs);
      sessionObs.start();
    }

    // Monitor runner process exit (backup for missed events).
    runnerProcess.on('exit', (code) => {
      // Immediately poll the event store so final runner events are delivered
      // before the 3-second fallback check runs (important when FS watcher missed events).
      eventStore.triggerPoll(id);

      // Give event store watcher time to deliver final events.
      setTimeout(async () => {
        if (session.status === 'running') {
          // Runner exited without writing terminal event — mark as failed with recovery guidance.
          const t = now();
          const recoveryGit = await inspectGitRecoveryState(session.worktreePath ?? session.workspacePath);
          session.lastRecovery = {
            reason: 'runner-exit-fallback',
            exitCode: code,
            git: recoveryGit,
            time: t,
          };
          const recoveryHint = recoveryGit.dirty
            ? 'Uncommitted changes were detected; review git diff/status to recover work from the crash.'
            : 'No uncommitted changes were detected; resume from the latest checkpoint commit.';
          session.status = 'failed';
          session.error = `Runner process exited unexpectedly (code ${code}). ${recoveryHint}`;
          session.llmStatus = createLlmStatus('failed', t, { detail: session.error });
          session.updatedAt = t;

          emitSessionEvent(id, {
            time: t,
            type: 'session:recovery-detected',
            payload: {
              reason: 'runner-exit-fallback',
              exitCode: code,
              git: recoveryGit,
            },
          });
          emitSessionEvent(id, { time: t, type: 'session:error-change', payload: { error: session.error } });
          emitSessionEvent(id, { time: t, type: 'session:llm-status-change', payload: { llmStatus: session.llmStatus } });
          emitSessionEvent(id, { time: t, type: 'session:status-change', payload: { status: 'failed' } });

          broadcastWorkStream(workStreamClients, id, 'error', {
            id,
            error: session.error,
            llmStatus: session.llmStatus,
            time: t,
          });

          uiStatePersistence.schedule();
          unwatch();

          // Stop per-session observer on unexpected exit.
          const obs = sessionObservers.get(id);
          if (obs) {
            obs.stop();
            sessionObservers.delete(id);
          }
        }
      }, 3_000);
    });
  }

  async function retryWorkSessionInPlace(params: {
    id: string;
    displayPrompt: string;
    executionPrompt: string;
    promptParts?: SessionChatContentPart[];
  }): Promise<{ id: string } | { error: string; statusCode: number }> {
    const session = workSessions.get(params.id);
    if (!session) {
      return { error: 'Unknown work session', statusCode: 404 };
    }

    if (session.status === 'running') {
      return { error: 'Cannot retry a running session.', statusCode: 409 };
    }

    const workspace = await workspaceManager.selectWorkspace(session.workspaceId);
    let managedWorkspace;
    try {
      managedWorkspace = await initializeManagedSessionWorkspace({
        sessionId: session.id,
        workspaceRoot: workspace.path,
        worktreePath: session.worktreePath,
        worktreeBranch: session.worktreeBranch,
      });
    } catch (error) {
      return {
        error: `Failed to initialize session worktree: ${toErrorMessage(error)}`,
        statusCode: 500,
      };
    }

    const promptParts = cloneChatContentParts(params.promptParts ?? []);
    const displayPrompt = asString(params.displayPrompt);
    const executionPrompt = asString(params.executionPrompt);
    if (!displayPrompt && promptParts.length === 0) {
      return { error: 'Missing prompt', statusCode: 400 };
    }

    const normalizedDisplayPrompt = promptParts.length > 0
      ? compactInlineImageMarkdown(displayPrompt || summarizeChatContentParts(promptParts))
      : (displayPrompt || summarizeChatContentParts(promptParts));
    const normalizedExecutionPrompt = executionPrompt.trim() || normalizedDisplayPrompt;

    const retryStartedAt = now();
    session.workspaceName = workspace.name;
    session.workspacePath = managedWorkspace.workspacePath;
    session.worktreePath = managedWorkspace.worktreePath;
    session.worktreeBranch = managedWorkspace.worktreeBranch;
    session.cleanupWorktree = managedWorkspace.cleanupWorktree;
    session.prompt = normalizedDisplayPrompt;
    session.executionPromptOverride = normalizedExecutionPrompt;
    session.promptParts = promptParts.length > 0 ? cloneChatContentParts(promptParts) : undefined;
    session.creationReason = 'retry';
    session.updatedAt = retryStartedAt;
    session.status = 'running';
    session.llmStatus = createLlmStatus('queued', retryStartedAt, {
      detail: 'Queued for orchestration.',
    });
    session.taskStatus = {};
    session.agentGraph = [];
    session.error = undefined;
    session.output = undefined;
    session.lastRecovery = undefined;
    session.controller = new AbortController();

    const existingObserver = sessionObservers.get(session.id);
    if (existingObserver) {
      existingObserver.stop();
      sessionObservers.delete(session.id);
    }

    const chatThread = sessionChats.get(session.id);
    if (chatThread) {
      chatThread.taskPrompt = normalizedDisplayPrompt;
      chatThread.updatedAt = retryStartedAt;
    }

    try {
      await appendSessionCreatedEvent(session, retryStartedAt);
    } catch (error) {
      session.status = 'failed';
      session.error = `Failed to persist retry session config: ${toErrorMessage(error)}`;
      session.llmStatus = createLlmStatus('failed', now(), { detail: session.error });
      uiStatePersistence.schedule();
      return { error: session.error, statusCode: 500 };
    }

    emitSessionEvent(session.id, {
      time: retryStartedAt,
      type: 'session:llm-status-change',
      payload: { llmStatus: session.llmStatus },
    });
    emitSessionEvent(session.id, {
      time: retryStartedAt,
      type: 'session:status-change',
      payload: { status: 'running' },
    });
    emitSessionEvent(session.id, {
      time: retryStartedAt,
      type: 'session:error-change',
      payload: { error: undefined },
    });
    emitSessionEvent(session.id, {
      time: retryStartedAt,
      type: 'session:output-set',
      payload: { output: {} },
    });

    broadcastSessionUpdate(workStreamClients, session.id, serializeWorkSession(session, sessionTodos.get(session.id) ?? []));
    broadcastSessionStatusUpsert(session);
    uiStatePersistence.schedule();

    await launchSessionRunner(session);
    return { id: session.id };
  }

  async function startWorkSession(request: {
    workspaceId?: string;
    prompt: unknown;
    promptParts?: SessionChatContentPart[];
    provider: string;
    model: string;
    agentModels?: SessionAgentModels;
    planningProvider?: string;
    planningModel?: string;
    implementationProvider?: string;
    implementationModel?: string;
    deliveryStrategy?: SessionDeliveryStrategy;
    autoApprove: boolean;
    planningNoToolGuardMode?: 'enforce' | 'warn';
    quickStartMode?: boolean;
    quickStartMaxPreDelegationToolCalls?: number;
    adaptiveConcurrency?: boolean;
    batchConcurrency?: number;
    batchMinConcurrency?: number;
    enableTrivialTaskGate?: boolean;
    trivialTaskMaxPromptLength?: number;
    creationReason?: SessionCreationReason;
    sourceSessionId?: string;
    source?: 'user' | 'observer';
    routingAuditContext?: {
      eventType: 'observer_fix_prompt_conversion';
      findingFingerprint: string;
      findingTitle: string;
      findingCategory: string;
      findingSeverity: string;
      observedSessionCount: number;
      relevantFileCount: number;
      promptCharLength: number;
      routeIntent: 'code_change';
      reason: string;
    };
  }): Promise<{ id: string; warnings?: string[] } | {
    error: string;
    statusCode: number;
    code?: TaskPromptValidationErrorCode;
    details?: Record<string, unknown>;
  }> {
    const promptParts = cloneChatContentParts(request.promptParts ?? []);
    const resolvedAgentModels = resolveSessionAgentModels({
      provider: request.provider,
      model: request.model,
      planningProvider: request.planningProvider,
      planningModel: request.planningModel,
      implementationProvider: request.implementationProvider,
      implementationModel: request.implementationModel,
      agentModels: request.agentModels,
    });
    const implementationProvider = resolvedAgentModels.implementationProvider;
    const implementationModel = resolvedAgentModels.implementationModel;
    const planningProvider = resolvedAgentModels.planningProvider;
    const planningModel = resolvedAgentModels.planningModel;
    const deliveryStrategy = normalizeSessionDeliveryStrategy(
      request.deliveryStrategy ?? uiPreferences.defaultDeliveryStrategy,
    );

            const providersReadiness = await validateSessionProvidersReadiness(
      authManager,
      planningProvider,
      implementationProvider,
    );
    if (!providersReadiness.ok) {
      return providersReadiness;
    }



    const promptValidation = validateAndNormalizeSessionPromptInput({
      prompt: request.prompt,
      promptParts,
    });

    if (!promptValidation.ok) {
      return {
        error: promptValidation.error,
        statusCode: 400,
        code: promptValidation.code,
        details: promptValidation.details,
      };
    }

    const workspace = request.workspaceId
      ? await workspaceManager.selectWorkspace(request.workspaceId)
      : await workspaceManager.getActiveWorkspace();

    const normalizedPrompt = promptValidation.normalizedPrompt;

    const id = randomUUID();
    const adaptiveConcurrency = request.adaptiveConcurrency ?? uiPreferences.adaptiveConcurrency;
    const batchConcurrency = normalizePositiveSetting(request.batchConcurrency, uiPreferences.batchConcurrency);
    const batchMinConcurrency = Math.min(
      batchConcurrency,
      normalizePositiveSetting(request.batchMinConcurrency, uiPreferences.batchMinConcurrency),
    );
    const quickStartMode = request.quickStartMode
      ?? (parseBooleanSetting(process.env.ORCHESTRACE_QUICK_START_MODE) ?? false);
    const quickStartMaxPreDelegationToolCalls = normalizePositiveSetting(
      request.quickStartMaxPreDelegationToolCalls,
      parsePositiveSetting(process.env.ORCHESTRACE_QUICK_START_MAX_PRE_DELEGATION_TOOL_CALLS) ?? 3,
    );
    const planningNoToolGuardMode = normalizePlanningNoToolGuardMode(request.planningNoToolGuardMode)
      ?? uiPreferences.planningNoToolGuardMode;
    const enableTrivialTaskGate = request.enableTrivialTaskGate ?? uiPreferences.enableTrivialTaskGate;
    const trivialTaskMaxPromptLength = normalizePositiveSetting(
      request.trivialTaskMaxPromptLength,
      uiPreferences.trivialTaskMaxPromptLength,
    );

    let managedWorkspace;
    try {
      managedWorkspace = await initializeManagedSessionWorkspace({
        sessionId: id,
        workspaceRoot: workspace.path,
      });
    } catch (error) {
      return {
        error: `Failed to initialize session worktree: ${toErrorMessage(error)}`,
        statusCode: 500,
      };
    }

    const controller = new AbortController();
    const createdAt = now();

    const session: WorkSession = {
      id,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePath: managedWorkspace.workspacePath,
      prompt: normalizedPrompt,
      promptParts: promptParts.length > 0 ? cloneChatContentParts(promptParts) : undefined,
      provider: implementationProvider,
      model: implementationModel,
      agentModels: resolvedAgentModels.agentModels,
      planningProvider,
      planningModel,
      implementationProvider,
      implementationModel,
      deliveryStrategy,
      autoApprove: request.autoApprove,
      planningNoToolGuardMode,
      quickStartMode,
      quickStartMaxPreDelegationToolCalls,
      adaptiveConcurrency,
      batchConcurrency,
      batchMinConcurrency,
      enableTrivialTaskGate,
      trivialTaskMaxPromptLength,
      worktreePath: managedWorkspace.worktreePath,
      worktreeBranch: managedWorkspace.worktreeBranch,
      creationReason: request.creationReason ?? 'start',
      sourceSessionId: asString(request.sourceSessionId) || undefined,
      source: request.source,
      createdAt,
      updatedAt: createdAt,
      status: 'running',
      llmStatus: createLlmStatus('queued', createdAt, {
        detail: 'Queued for orchestration.',
      }),
      taskStatus: {},
      events: [],
      agentGraph: [],
      controller,
      cleanupWorktree: managedWorkspace.cleanupWorktree,
    };

    workSessions.set(id, session);
    console.log(
      `[ui-server] session worktree initialized: ${JSON.stringify({
        sessionId: id,
        workspaceRoot: workspace.path,
        workspacePath: managedWorkspace.workspacePath,
        worktreeBranch: managedWorkspace.worktreeBranch,
        warnings: managedWorkspace.warnings,
      })}`,
    );
    sessionChats.set(id, createSessionChatThread(session, promptParts));
    sessionTodos.set(id, []);
    sessionSharedContextStores.set(id, new InMemorySharedContextStore());
    sessionContextEngines.set(id, createSessionContextEngine(implementationProvider, implementationModel));
    sessionContextStates.set(id, { turnsSinceLastCompaction: 0 });
    uiStatePersistence.schedule();
    broadcastTodoUpdate(workStreamClients, id, sessionTodos.get(id) ?? []);

    try {
      await appendSessionCreatedEvent(session, createdAt);
      await eventStore.append(id, {
        time: createdAt,
        type: 'session:chat-thread-created',
        payload: {
          provider: implementationProvider,
          model: implementationModel,
          workspacePath: managedWorkspace.workspacePath,
          taskPrompt: normalizedPrompt,
        },
      });
      if (request.routingAuditContext) {
        const ctx = request.routingAuditContext;
        await eventStore.append(id, {
          time: createdAt,
          type: 'session:dag-event',
          payload: {
            event: {
              time: createdAt,
              runId: id,
              type: 'task:routing',
              taskId: 'task',
              message: `Observer conversion audit: event=${ctx.eventType}; findingFingerprint=${ctx.findingFingerprint}; findingTitle=${ctx.findingTitle}; category=${ctx.findingCategory}; severity=${ctx.findingSeverity}; observedSessionCount=${ctx.observedSessionCount}; relevantFileCount=${ctx.relevantFileCount}; promptCharLength=${ctx.promptCharLength}; routeIntent=${ctx.routeIntent}; source=observer; reason=${ctx.reason}`,
            },
          },
        });
      }
    } catch (error) {
      void managedWorkspace.cleanupWorktree().catch(() => {});
      workSessions.delete(id);
      sessionChats.delete(id);
      sessionTodos.delete(id);
      sessionSharedContextStores.delete(id);
      sessionContextEngines.delete(id);
      sessionContextStates.delete(id);
      pendingSubagentNodeIdsBySession.delete(id);
      return {
        error: `Failed to persist initial session events: ${toErrorMessage(error)}`,
        statusCode: 500,
      };
    }

    broadcastSessionStatusUpsert(session);

    await launchSessionRunner(session);

    return { id, warnings: managedWorkspace.warnings.length > 0 ? managedWorkspace.warnings : undefined };
  }

    const prMergeScanner = new PrMergeScanner({
    eventStore,
    resolveGithubToken: () => githubAuthManager.resolveApiKey(GITHUB_PROVIDER_ID),
    scanIntervalMs: 60_000,
  });
  prMergeScanner.onSessionMerged((sessionId) => {
    const session = workSessions.get(sessionId);
    if (!session) {
      return;
    }

    session.status = 'merged';
    session.updatedAt = now();
    broadcastSessionStatusUpsert(session);
    uiStatePersistence.schedule();
  });
  prMergeScanner.start();

  // -- Observer daemon (autonomous background agent) --------------------------
  const observerDaemon = new ObserverDaemon({

    orchestraceDir: join(workspaceManager.getRootDir(), '.orchestrace'),
    eventStore,
    llm,
    startSession: startWorkSession,
    resolveApiKey: (provider) => resolveProviderApiKey(provider),
  });

  // -- Log watcher (analyzes backend logs for issues) -------------------------
  const logWatcher = new LogWatcher({
    llm,
    config: observerDaemon.getConfig(),
    logger: backendLogger,
    resolveApiKey: (provider) => resolveProviderApiKey(provider),
        onStateChange: (state) => {
      // Broadcast log watcher state to log stream SSE clients
      broadcastLogStreamEvent('log-watcher-state', { state });
    },
    onFindings: (findings) => {
      void observerDaemon.ingestLogWatcherFindings(findings).catch((error) => {
        reportLogStreamError({
          source: 'observer-ingestion',
          operation: 'ingest-log-watcher-findings',
          message: toErrorMessage(error),
          context: {
            findingsCount: findings.length,
            findingTitles: findings.map((finding) => finding.title),
          },
        });
      });
    },
    onError: (error: LogWatcherRuntimeError) => {
      reportLogStreamError({
        source: 'log-watcher',
        operation: error.operation,
        message: error.message,
        context: error.context,
      });
    },

  });

  void observerDaemon.start().then(() => {
    logWatcher.updateConfig(observerDaemon.getConfig());
    if (observerDaemon.getConfig().enabled) {
      logWatcher.start(backendLogger);
      console.log('[orchestrace][log-watcher] Started');
    }
  }).catch((err) => {
    console.error('[orchestrace][observer] Failed to start daemon:', err);
  });

  let hmrWatcher: FSWatcher | undefined;
  if (hmrEnabled) {
    const watchPath = resolveUiWatchPath(workspaceManager.getRootDir());
    if (watchPath) {
      let pendingReload = false;
      hmrWatcher = watch(watchPath, { recursive: true }, (_eventType, changedPath) => {
        const changed = typeof changedPath === 'string' ? changedPath : String(changedPath ?? '');
        if (!changed || changed.includes('node_modules') || changed.includes('.git')) {
          return;
        }

        if (pendingReload) {
          return;
        }

        pendingReload = true;
        setTimeout(() => {
          pendingReload = false;
          const payload = JSON.stringify({ time: now(), file: changed });
          for (const client of hmrClients) {
            client.write(`event: reload\ndata: ${payload}\n\n`);
          }
        }, 120);
      });
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const { pathname } = url;

      if (req.method === 'GET' && (pathname === '/' || pathname === '/settings' || pathname === '/settings/' || pathname === '/logs' || pathname === '/logs/')) {
        sendHtml(res, renderDashboardHtml(hmrEnabled));
        return;
      }

            if (hmrEnabled && req.method === 'GET' && pathname === '/__hmr') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        hmrClients.add(res);
        req.on('close', () => {
          hmrClients.delete(res);
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/app-auth/config') {
        sendJson(res, 200, {
          authEnabled: appAuthEnabled,
          provider: appAuthEnabled ? 'google' : null,
          googleClientId: appAuthEnabled ? appAuthConfig.googleClientId : null,
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/app-auth/status') {
        const token = resolveRequestJwt(req, url);
        if (!appAuthEnabled) {
          sendJson(res, 200, { authenticated: true, authEnabled: false });
          return;
        }

        if (!token) {
          sendJson(res, 200, { authenticated: false, authEnabled: true });
          return;
        }

        const payload = verifyJwtToken(token, appAuthConfig.jwtSecret);
        if (!payload) {
          sendJson(res, 200, { authenticated: false, authEnabled: true });
          return;
        }

        sendJson(res, 200, {
          authenticated: true,
          authEnabled: true,
          user: {
            email: payload.email,
            name: payload.name,
            picture: payload.picture,
          },
          expiresAt: payload.exp,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/app-auth/google') {
        if (!appAuthEnabled) {
          sendJson(res, 400, { error: 'App authentication is disabled.' });
          return;
        }

        const body = await readJsonBody(req);
        const idToken = asString(body.idToken)?.trim();
        if (!idToken) {
          sendJson(res, 400, { error: 'Missing idToken' });
          return;
        }

        try {
          const googleClaims = await verifyGoogleIdToken({
            idToken,
            expectedAudience: appAuthConfig.googleClientId,
          });
                    const sessionId = randomUUID();
          const expiresAt = Date.now() + (appAuthConfig.tokenTtlSeconds * 1_000);

          const token = signJwtToken({
            sub: sessionId,

            email: googleClaims.email,
            name: googleClaims.name,
            picture: googleClaims.picture,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(expiresAt / 1000),
          }, appAuthConfig.jwtSecret);

          sendJson(res, 200, {
            token,
            tokenType: 'Bearer',
            expiresIn: appAuthConfig.tokenTtlSeconds,
            user: {
              email: googleClaims.email,
              name: googleClaims.name,
              picture: googleClaims.picture,
            },
          });
        } catch (error) {
          sendJson(res, 401, { error: toErrorMessage(error) });
        }
        return;
      }

      if (!isPublicRoute(pathname)) {
        const authPayload = requireAppAuth(req, res, url);
        if (appAuthEnabled && !authPayload) {
          return;
        }
      }

      if (req.method === 'GET' && pathname === '/api/workspaces') {

        const state = await workspaceManager.list();
        sendJson(res, 200, {
          activeWorkspaceId: state.activeWorkspaceId,
          workspaces: state.workspaces,
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/work/stream') {
        const id = asString(url.searchParams.get('id'));
        if (!id) {
          sendJson(res, 400, { error: 'Missing id' });
          return;
        }

        const session = workSessions.get(id);
        if (!session) {
          sendJson(res, 404, { error: 'Unknown work session' });
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });

        let clients = workStreamClients.get(id);
        if (!clients) {
          clients = new Set<ServerResponse>();
          workStreamClients.set(id, clients);
        }
        clients.add(res);

        const todos = (sessionTodos.get(id) ?? []).map((item) => ({ ...item }));
        const thread = sessionChats.get(id) ?? createSessionChatThread(session);
        sessionChats.set(id, thread);

        sendSse(res, 'ready', {
          id,
          session: serializeWorkSession(session, sessionTodos.get(id) ?? []),
          messages: thread.messages.filter((message) => message.role !== 'system'),
          todos,
          status: session.status,
          llmStatus: session.llmStatus,
          observer: sessionObservers.get(id)?.getState() ?? null,
          time: now(),
        });

        req.on('close', () => {
          const group = workStreamClients.get(id);
          if (!group) {
            return;
          }
          group.delete(res);
          if (group.size === 0) {
            workStreamClients.delete(id);
          }
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/work/sessions/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');

        sessionStatusStreamClients.add(res);
        broadcastSessionStatusReady(res);

        req.on('close', () => {
          sessionStatusStreamClients.delete(res);
        });
        return;
      }

      // -- Health endpoint for deployment tooling ---
      if (req.method === 'GET' && pathname === '/api/health') {
        const runningSessions = [...workSessions.values()].filter((s) => s.status === 'running').length;
        sendJson(res, isDraining() ? 503 : 200, {
          status: isDraining() ? 'draining' : 'ok',
          sessions: { total: workSessions.size, running: runningSessions },
          uptime: process.uptime(),
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/workspaces/readiness') {
        const provider = asString(url.searchParams.get('provider'))
          || process.env.ORCHESTRACE_DEFAULT_PROVIDER
          || 'anthropic';

        const state = await workspaceManager.list();
        const statuses = await authManager.getAllStatus();
        const providerStatus = statuses.find((item) => item.provider === provider);
        const authSource = providerStatus?.source ?? 'none';
        const authReady = authSource !== 'none';

        const workspaces = state.workspaces.map((workspace) => {
          const pathExists = existsSync(workspace.path);
          const hasGit = pathExists && existsSync(join(workspace.path, '.git'));
          const hasNodeProject = pathExists
            && (existsSync(join(workspace.path, 'package.json')) || existsSync(join(workspace.path, 'pnpm-workspace.yaml')));

          return {
            ...workspace,
            active: workspace.id === state.activeWorkspaceId,
            checks: {
              pathExists,
              hasGit,
              hasNodeProject,
              authReady,
            },
            ready: pathExists && hasGit && authReady,
          };
        });

        sendJson(res, 200, {
          provider,
          authSource,
          workspaces,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/workspaces/add') {
        const body = await readJsonBody(req);
        const path = asString(body.path);
        const name = asString(body.name);

        if (!path) {
          sendJson(res, 400, { error: 'Missing path' });
          return;
        }

        const workspace = await workspaceManager.addWorkspace(path, name || undefined);
        sendJson(res, 200, { workspace });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/workspaces/select') {
        const body = await readJsonBody(req);
        const workspace = asString(body.workspace);
        if (!workspace) {
          sendJson(res, 400, { error: 'Missing workspace identifier' });
          return;
        }

        const selected = await workspaceManager.selectWorkspace(workspace);
        sendJson(res, 200, { workspace: selected });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/workspaces/remove') {
        const body = await readJsonBody(req);
        const workspace = asString(body.workspace);
        if (!workspace) {
          sendJson(res, 400, { error: 'Missing workspace identifier' });
          return;
        }

        const result = await workspaceManager.removeWorkspace(workspace);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/providers') {
        const providers = authManager.listProviders();
        const statuses = await authManager.getAllStatus();
        sendJson(res, 200, {
          providers,
          statuses,
          defaults: {
            provider: process.env.ORCHESTRACE_DEFAULT_PROVIDER ?? 'anthropic',
            model: process.env.ORCHESTRACE_DEFAULT_MODEL ?? 'claude-sonnet-4-20250514',
          },
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/ui/preferences') {
        sendJson(res, 200, { preferences: { ...uiPreferences } });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/ui/preferences') {
        const body = await readJsonBody(req);
        if (!isRecord(body)) {
          sendJson(res, 400, { error: 'Invalid preferences payload' });
          return;
        }

        uiPreferences = normalizeUiPreferences(body, uiPreferences);
        await uiStatePersistence.flush();
        sendJson(res, 200, { preferences: { ...uiPreferences } });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/models') {
        const provider = asString(url.searchParams.get('provider'));
        if (!provider) {
          sendJson(res, 400, { error: 'Missing provider query parameter' });
          return;
        }

                const readiness = await authManager.validateProviderReadiness(provider, { allowRefresh: false });
        if (!readiness.ok) {
          sendJson(res, 403, { error: readiness.message, code: readiness.code, remediation: readiness.remediation });
          return;
        }


        try {
          const models = getModels(provider as never).map((model) => model.id);
          sendJson(res, 200, { provider, models });
        } catch (error) {
          sendJson(res, 400, { error: toErrorMessage(error) });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/auth/start') {
        const body = await readJsonBody(req);
        const providerId = asString(body.providerId);

        if (!providerId) {
          sendJson(res, 400, { error: 'Missing providerId' });
          return;
        }

        const provider = authManager.listProviders().find((item) => item.id === providerId);
        if (!provider) {
          sendJson(res, 404, { error: `Unknown provider: ${providerId}` });
          return;
        }

        if (provider.authType === 'api-key') {
          sendJson(res, 400, {
            error: `Provider ${providerId} requires API key setup. Use CLI: pnpm --filter @orchestrace/cli dev auth ${providerId}`,
          });
          return;
        }

        const authSession = createAuthSession(providerId);
        authSessions.set(authSession.id, authSession);

        void authManager.loginOAuth(providerId, {
          onAuth: (info) => {
            authSession.state = 'awaiting-auth';
            authSession.authUrl = info.url;
            authSession.authInstructions = info.instructions;
            authSession.updatedAt = now();
          },
          onProgress: () => {
            authSession.state = 'running';
            authSession.updatedAt = now();
          },
          onPrompt: async (prompt) => {
            authSession.state = 'awaiting-input';
            authSession.promptMessage = prompt.message;
            authSession.promptPlaceholder = prompt.placeholder;
            authSession.updatedAt = now();

            return new Promise<string>((resolve) => {
              authSession.resolveInput = resolve;
            });
          },
        }).then(() => {
          authSession.state = 'completed';
          authSession.resolveInput = undefined;
          authSession.updatedAt = now();
        }).catch((error) => {
          authSession.state = 'failed';
          authSession.error = toErrorMessage(error);
          authSession.resolveInput = undefined;
          authSession.updatedAt = now();
        });

        sendJson(res, 200, { sessionId: authSession.id });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/auth/session') {
        const id = url.searchParams.get('id') ?? '';
        const session = authSessions.get(id);
        if (!session) {
          sendJson(res, 404, { error: 'Unknown auth session' });
          return;
        }

        sendJson(res, 200, { session: serializeAuthSession(session) });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/auth/respond') {
        const body = await readJsonBody(req);
        const sessionId = asString(body.sessionId);
        const value = asString(body.value);

        if (!sessionId) {
          sendJson(res, 400, { error: 'Missing sessionId' });
          return;
        }

        const session = authSessions.get(sessionId);
        if (!session) {
          sendJson(res, 404, { error: 'Unknown auth session' });
          return;
        }

        if (session.state !== 'awaiting-input' || !session.resolveInput) {
          sendJson(res, 400, { error: 'Session is not waiting for input' });
          return;
        }

        session.resolveInput(value ?? '');
        session.resolveInput = undefined;
        session.state = 'running';
        session.updatedAt = now();

        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/github/auth/status') {
        const status = await resolveGithubAuthStatus(githubAuthManager);
        sendJson(res, 200, { status });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/github/auth/start') {
        const body = await readJsonBody(req);
        const requestedClientId = asString(body.clientId)?.trim();
        const envClientId = asString(process.env.ORCHESTRACE_GITHUB_OAUTH_CLIENT_ID)?.trim();
        const clientId = requestedClientId || envClientId || GITHUB_DEVICE_AUTH_CLIENT_ID_DEFAULT;
        if (!clientId) {
          sendJson(res, 400, {
            error: 'Unable to resolve GitHub OAuth client id.',
          });
          return;
        }

        const requestedScopes = Array.isArray(body.scopes)
          ? body.scopes
            .map((entry) => asString(entry))
            .filter((entry): entry is string => Boolean(entry))
          : [];
        const scopes = requestedScopes.length > 0 ? requestedScopes : [...GITHUB_DEVICE_AUTH_SCOPES_DEFAULT];

        try {
          const session = await startGithubDeviceAuthSession({
            clientId,
            scopes,
          });
          githubDeviceAuthSessions.set(session.id, session);
          void pollGithubDeviceAuthSession({
            session,
            githubAuthManager,
            sessions: githubDeviceAuthSessions,
          });

          sendJson(res, 200, {
            sessionId: session.id,
            session: serializeGithubDeviceAuthSession(session),
          });
        } catch (error) {
          sendJson(res, 400, { error: toErrorMessage(error) });
        }

        return;
      }

      if (req.method === 'GET' && pathname === '/api/github/auth/session') {
        const id = asString(url.searchParams.get('id'));
        if (!id) {
          sendJson(res, 400, { error: 'Missing id' });
          return;
        }

        const session = githubDeviceAuthSessions.get(id);
        if (!session) {
          sendJson(res, 404, { error: 'Unknown GitHub auth session' });
          return;
        }

        sendJson(res, 200, { session: serializeGithubDeviceAuthSession(session) });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/github/request') {
        const body = await readJsonBody(req);
        const token = await githubAuthManager.resolveApiKey(GITHUB_PROVIDER_ID);
        if (!token) {
          sendJson(res, 401, { error: 'GitHub PR auth is not configured. Complete device login in Settings first and ensure you have access to the remote workspace repository.' });
          return;
        }

        const path = asString(body.path);
        const method = asString(body.method);
        const graphqlQuery = asString(body.graphqlQuery);
        const graphqlVariables = body.graphqlVariables;
        const requestBody = body.body;

        if (!path && !graphqlQuery) {
          sendJson(res, 400, { error: 'Provide either path (REST) or graphqlQuery (GraphQL).' });
          return;
        }

        if (path && graphqlQuery) {
          sendJson(res, 400, { error: 'Provide either path or graphqlQuery, not both.' });
          return;
        }

        try {
          const response = await runGithubApiRequest({
            token,
            method,
            path,
            body: requestBody,
            graphqlQuery,
            graphqlVariables,
            signal: undefined,
          });

          sendJson(res, 200, { response });
        } catch (error) {
          sendJson(res, 400, { error: toErrorMessage(error) });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/work/start') {
        if (isDraining()) {
          sendJson(res, 503, { error: 'Server is shutting down. Please retry after restart.' });
          return;
        }
        const body = await readJsonBody(req);
        const workspaceId = asString(body.workspaceId);
        const prompt = body.prompt;
        const promptParts = parseChatContentParts(body.promptParts);
        const requestedAgentModels = normalizeSessionAgentModels(body.agentModels);
        const legacyProvider = asString(body.provider);
        const implementationProvider = asString(requestedAgentModels.implementer?.provider)
          || asString(body.implementationProvider)
          || legacyProvider
          || asString(process.env.ORCHESTRACE_IMPLEMENTER_PROVIDER)
          || process.env.ORCHESTRACE_DEFAULT_PROVIDER
          || 'anthropic';
        const planningProvider = asString(requestedAgentModels.planner?.provider)
          || asString(body.planningProvider)
          || asString(process.env.ORCHESTRACE_PLANNER_PROVIDER)
          || implementationProvider;
        const legacyRequestedModel = asString(body.model);
        const requestedImplementationModel = asString(requestedAgentModels.implementer?.model)
          || asString(body.implementationModel)
          || asString(process.env.ORCHESTRACE_IMPLEMENTER_MODEL)
          || legacyRequestedModel;
        const requestedPlanningModel = asString(requestedAgentModels.planner?.model)
          || asString(body.planningModel)
          || asString(process.env.ORCHESTRACE_PLANNER_MODEL)
          || requestedImplementationModel;

        const implementationModelResolution = resolveWorkStartModel({
          provider: implementationProvider,
          requestedModel: requestedImplementationModel,
          envFallbackModel: resolveDefaultModelFromEnv(),
        });

        if (implementationModelResolution.ok === false) {
          sendJson(res, implementationModelResolution.statusCode, {
            error: implementationModelResolution.error,
            code: implementationModelResolution.code,
            phase: 'implementation',
            details: implementationModelResolution.details,
          });
          return;
        }

        const planningModelResolution = resolveWorkStartModel({
          provider: planningProvider,
          requestedModel: requestedPlanningModel,
          envFallbackModel: resolveDefaultModelFromEnv(),
        });

        if (planningModelResolution.ok === false) {
          sendJson(res, planningModelResolution.statusCode, {
            error: planningModelResolution.error,
            code: planningModelResolution.code,
            phase: 'planning',
            details: planningModelResolution.details,
          });
          return;
        }

        const autoApprove = Boolean(body.autoApprove);
        const deliveryStrategy = normalizeSessionDeliveryStrategy(body.deliveryStrategy);
        const quickStartMode = parseBooleanSetting(body.quickStartMode)
          ?? parseBooleanSetting(body.quickStart)
          ?? parseBooleanSetting(body.enableQuickStart);
        const planningNoToolGuardMode = normalizePlanningNoToolGuardMode(body.planningNoToolGuardMode)
          ?? (parseBooleanSetting(body.planningNoToolWarnOnly) ? 'warn' : undefined);
        const quickStartMaxPreDelegationToolCalls = parsePositiveSetting(body.quickStartMaxPreDelegationToolCalls)
          ?? parsePositiveSetting(body.quickStartToolCallLimit)
          ?? parsePositiveSetting(body.maxPreDelegationToolCalls);
        const adaptiveConcurrency = parseBooleanSetting(body.adaptiveConcurrency)
          ?? parseBooleanSetting(body.adaptiveToolConcurrency);
        const batchConcurrency = parsePositiveSetting(body.batchConcurrency)
          ?? parsePositiveSetting(body.toolBatchConcurrency);
        const batchMinConcurrency = parsePositiveSetting(body.batchMinConcurrency)
          ?? parsePositiveSetting(body.toolBatchMinConcurrency);
        const enableTrivialTaskGate = parseBooleanSetting(body.enableTrivialTaskGate)
          ?? parseBooleanSetting(body.trivialTaskGateEnabled);
        const trivialTaskMaxPromptLength = parsePositiveSetting(body.trivialTaskMaxPromptLength)
          ?? parsePositiveSetting(body.trivialPromptMaxLength);
        const result = await startWorkSession({
          workspaceId,
          prompt,
          promptParts,
          provider: implementationProvider,
          model: implementationModelResolution.model,
          agentModels: normalizeSessionAgentModels(body.agentModels, {
            ...requestedAgentModels,
            planner: {
              ...requestedAgentModels.planner,
              provider: planningProvider,
              model: planningModelResolution.model,
            },
            implementer: {
              ...requestedAgentModels.implementer,
              provider: implementationProvider,
              model: implementationModelResolution.model,
            },
          }),
          planningProvider,
          planningModel: planningModelResolution.model,
          implementationProvider,
          implementationModel: implementationModelResolution.model,
          deliveryStrategy,
          autoApprove,
          planningNoToolGuardMode,
          quickStartMode,
          quickStartMaxPreDelegationToolCalls,
          adaptiveConcurrency,
          batchConcurrency,
          batchMinConcurrency,
          enableTrivialTaskGate,
          trivialTaskMaxPromptLength,
          creationReason: 'start',
        });

        if ('error' in result) {
          sendJson(res, result.statusCode, {
            error: result.error,
            code: result.code,
            details: result.details,
          });
          return;
        }

        sendJson(res, 200, {
          id: result.id,
          warnings: result.warnings,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/work/retry') {
        if (isDraining()) {
          sendJson(res, 503, { error: 'Server is shutting down. Please retry after restart.' });
          return;
        }
        const body = await readJsonBody(req);
        const id = asString(body.id);

        if (!id) {
          sendJson(res, 400, { error: 'Missing id' });
          return;
        }

        const sourceSession = workSessions.get(id);
        if (!sourceSession) {
          sendJson(res, 404, { error: 'Unknown work session' });
          return;
        }

        if (sourceSession.status === 'running') {
          sendJson(res, 409, { error: 'Cannot retry a running session.' });
          return;
        }

        const followUpText = asString(body.followUp).trim();
        const followUpParts = parseChatContentParts(body.followUpParts);
        const retryBasePrompt = stripRetryContinuationFromPrompt(sourceSession.prompt);
        const retryContext = buildRetryContinuationSummary({
          session: sourceSession,
          todos: sessionTodos.get(id) ?? [],
        });
        const retryDisplayPrompt = mergeRetryPromptWithFollowUp({
          prompt: retryBasePrompt,
          followUpText,
          followUpParts,
        });
        const retryExecutionPrompt = mergeRetryPromptWithFollowUp({
          prompt: retryBasePrompt,
          retryContext,
          followUpText,
          followUpParts,
        });
        const retryPromptParts = mergeRetryPromptPartsWithFollowUp({
          promptParts: sourceSession.promptParts,
          followUpText,
          followUpParts,
        });

        const result = await retryWorkSessionInPlace({
          id,
          displayPrompt: retryDisplayPrompt,
          executionPrompt: retryExecutionPrompt,
          promptParts: retryPromptParts,
        });

        if ('error' in result) {
          sendJson(res, result.statusCode, { error: result.error });
          return;
        }

        sendJson(res, 200, {
          id: result.id,
          sourceId: id,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/work/cancel') {
        const body = await readJsonBody(req);
        const id = asString(body.id);

        if (!id) {
          sendJson(res, 400, { error: 'Missing id' });
          return;
        }

        const session = workSessions.get(id);
        if (!session) {
          sendJson(res, 404, { error: 'Unknown work session' });
          return;
        }

        if (session.status === 'running') {
          // Send SIGTERM to the runner process if it's alive
          const meta = await eventStore.getMetadata(id);
          if (meta?.pid) {
            try { process.kill(meta.pid, 'SIGTERM'); } catch { /* already dead */ }
          }
          // Also abort in-process controller (for backward compat / chat cancellation)
          session.controller.abort();
          session.status = 'cancelled';
          session.updatedAt = now();
          session.llmStatus = createLlmStatus('cancelled', session.updatedAt, {
            detail: 'Cancelled by user.',
          });

          broadcastWorkStream(workStreamClients, session.id, 'end', {
            id: session.id,
            status: session.status,
            llmStatus: session.llmStatus,
            time: now(),
          });
          broadcastSessionStatusUpsert(session);

          // Dual-write: cancellation events
          emitSessionEvent(session.id, {
            time: session.updatedAt,
            type: 'session:llm-status-change',
            payload: { llmStatus: session.llmStatus },
          });
          emitSessionEvent(session.id, {
            time: session.updatedAt,
            type: 'session:status-change',
            payload: { status: 'cancelled' },
          });

          uiStatePersistence.schedule();
        }

        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/work/delete') {
        const body = await readJsonBody(req);
        const id = asString(body.id);

        if (!id) {
          sendJson(res, 400, { error: 'Missing id' });
          return;
        }

        const removed = deleteWorkSession(id);
        if (!removed) {
          sendJson(res, 404, { error: 'Unknown work session' });
          return;
        }

        sendJson(res, 200, { ok: true, id });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/work') {
        const sessions = serializeSessionsSnapshot();
        sendJson(res, 200, { sessions });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/work/diff') {
        const id = asString(url.searchParams.get('id'));
        if (!id) {
          sendJson(res, 400, { error: 'Missing id' });
          return;
        }

        const session = workSessions.get(id);
        if (!session) {
          sendJson(res, 404, { error: 'Unknown work session' });
          return;
        }

        try {
          const diff = await resolveSessionWorkDiff(session);
          sendJson(res, 200, {
            id,
            ...diff,
          });
        } catch (error) {
          sendJson(res, 500, { error: toErrorMessage(error) });
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/api/work/tools') {
        const id = asString(url.searchParams.get('id'));
        if (!id) {
          sendJson(res, 400, { error: 'Missing id' });
          return;
        }

        const session = workSessions.get(id);
        if (!session) {
          sendJson(res, 404, { error: 'Unknown work session' });
          return;
        }

        const requestedMode = normalizeAgentToolPhase(asString(url.searchParams.get('mode')));
        const mode = requestedMode ?? resolveSessionToolMode(session);
        const tools = listAgentTools({
          cwd: session.workspacePath,
          phase: mode,
          modeController: {
            getMode: () => mode,
            setMode: async (nextMode, reason) => ({
              mode: nextMode,
              changed: nextMode !== mode,
              detail: reason
                ? `Mode switch preview: ${mode} -> ${nextMode} (${reason}).`
                : `Mode switch preview: ${mode} -> ${nextMode}.`,
            }),
            availableModes: ['chat', 'planning', 'implementation'],
          },
          adaptiveConcurrency: session.adaptiveConcurrency,
          batchConcurrency: session.batchConcurrency,
          batchMinConcurrency: session.batchMinConcurrency,
                    resolveGithubToken: (resolveOptions) => githubAuthManager.resolveApiKey(GITHUB_PROVIDER_ID, resolveOptions),

          runSubAgent: async () => ({ text: '' }),
        });

        sendJson(res, 200, { id, mode, tools });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/work/agent') {
        const id = asString(url.searchParams.get('id'));
        if (!id) {
          sendJson(res, 400, { error: 'Missing id' });
          return;
        }

        const session = workSessions.get(id);
        if (!session) {
          sendJson(res, 404, { error: 'Unknown work session' });
          return;
        }

        const thread = sessionChats.get(id) ?? createSessionChatThread(session);
        sessionChats.set(id, thread);

        if ((sessionTodos.get(id)?.length ?? 0) === 0) {
          const changed = backfillChecklistFromUiEvents(id, session.events, sessionTodos);
          if (changed) {
            uiStatePersistence.schedule();
            broadcastTodoUpdate(workStreamClients, id, sessionTodos.get(id) ?? []);
          }
        }

        uiStatePersistence.schedule();

        sendJson(res, 200, {
          session: serializeWorkSession(session, sessionTodos.get(id) ?? []),
          messages: thread.messages.filter((message) => message.role !== 'system'),
          todos: (sessionTodos.get(id) ?? []).map((item) => ({ ...item })),
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/work/todos') {
        const id = asString(url.searchParams.get('id'));
        if (!id) {
          sendJson(res, 400, { error: 'Missing id' });
          return;
        }

        const session = workSessions.get(id);
        if (!session) {
          sendJson(res, 404, { error: 'Unknown work session' });
          return;
        }

        const todos = (sessionTodos.get(id) ?? []).map((item) => ({ ...item }));
        sendJson(res, 200, { id, todos });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/work/todos/add') {
        const body = await readJsonBody(req);
        const id = asString(body.id);
        const text = asString(body.text);

        if (!id) {
          sendJson(res, 400, { error: 'Missing id' });
          return;
        }

        if (!text) {
          sendJson(res, 400, { error: 'Missing todo text' });
          return;
        }

        const session = workSessions.get(id);
        if (!session) {
          sendJson(res, 404, { error: 'Unknown work session' });
          return;
        }

        const items = sessionTodos.get(id) ?? [];
        const todo: AgentTodoItem = {
          id: randomUUID(),
          text,
          status: 'todo',
          done: false,
          createdAt: now(),
          updatedAt: now(),
        };

        items.push(todo);
        sessionTodos.set(id, items);
        session.updatedAt = now();
        uiStatePersistence.schedule();
        broadcastTodoUpdate(workStreamClients, id, items);

        // Dual-write: todo added
        emitSessionEvent(id, {
          time: session.updatedAt,
          type: 'session:todo-item-added',
          payload: { item: todo },
        });

        sendJson(res, 200, { ok: true, todo: { ...todo }, todos: items.map((item) => ({ ...item })) });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/work/todos/toggle') {
        const body = await readJsonBody(req);
        const id = asString(body.id);
        const todoId = asString(body.todoId);

        if (!id || !todoId) {
          sendJson(res, 400, { error: 'Missing id or todoId' });
          return;
        }

        const session = workSessions.get(id);
        if (!session) {
          sendJson(res, 404, { error: 'Unknown work session' });
          return;
        }

        const items = sessionTodos.get(id) ?? [];
        const target = items.find((item) => item.id === todoId);
        if (!target) {
          sendJson(res, 404, { error: 'Unknown todo item' });
          return;
        }

        const requested = body.done;
        const nextDone = typeof requested === 'boolean' ? requested : !target.done;
        target.done = nextDone;
        target.status = nextDone ? 'done' : 'todo';
        target.updatedAt = now();
        session.updatedAt = now();
        uiStatePersistence.schedule();
        broadcastTodoUpdate(workStreamClients, id, items);

        // Dual-write: todo toggled
        emitSessionEvent(id, {
          time: session.updatedAt,
          type: 'session:todo-item-toggled',
          payload: { itemId: todoId, done: nextDone, status: target.status },
        });

        sendJson(res, 200, {
          ok: true,
          todo: { ...target },
          todos: items.map((item) => ({ ...item })),
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/work/todos/remove') {
        const body = await readJsonBody(req);
        const id = asString(body.id);
        const todoId = asString(body.todoId);

        if (!id || !todoId) {
          sendJson(res, 400, { error: 'Missing id or todoId' });
          return;
        }

        const session = workSessions.get(id);
        if (!session) {
          sendJson(res, 404, { error: 'Unknown work session' });
          return;
        }

        const items = sessionTodos.get(id) ?? [];
        const nextItems = items.filter((item) => item.id !== todoId);
        if (nextItems.length === items.length) {
          sendJson(res, 404, { error: 'Unknown todo item' });
          return;
        }

        sessionTodos.set(id, nextItems);
        session.updatedAt = now();
        uiStatePersistence.schedule();
        broadcastTodoUpdate(workStreamClients, id, nextItems);

        // Dual-write: todo removed
        emitSessionEvent(id, {
          time: session.updatedAt,
          type: 'session:todo-item-removed',
          payload: { itemId: todoId },
        });

        sendJson(res, 200, { ok: true, todos: nextItems.map((item) => ({ ...item })) });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/work/chat') {
        const id = asString(url.searchParams.get('id'));
        if (!id) {
          sendJson(res, 400, { error: 'Missing id' });
          return;
        }

        const session = workSessions.get(id);
        if (!session) {
          sendJson(res, 404, { error: 'Unknown work session' });
          return;
        }

        const thread = sessionChats.get(id) ?? createSessionChatThread(session);
        sessionChats.set(id, thread);
        uiStatePersistence.schedule();

        sendJson(res, 200, {
          id,
          provider: thread.provider,
          model: thread.model,
          messages: thread.messages.filter((message) => message.role !== 'system'),
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/work/chat/stream') {
        const streamId = asString(url.searchParams.get('streamId'));
        if (!streamId) {
          sendJson(res, 400, { error: 'Missing streamId' });
          return;
        }

        const streamState = chatStreams.get(streamId);
        if (!streamState) {
          sendJson(res, 404, { error: 'Unknown chat stream' });
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });

        let clients = chatStreamClients.get(streamId);
        if (!clients) {
          clients = new Set<ServerResponse>();
          chatStreamClients.set(streamId, clients);
        }
        clients.add(res);

        sendSse(res, 'ready', {
          streamId,
          sessionId: streamState.sessionId,
          status: streamState.status,
          usage: streamState.usage,
          usageEstimated: streamState.usageEstimated ?? false,
          time: now(),
        });

        if (streamState.replyText) {
          sendSse(res, 'snapshot', {
            streamId,
            sessionId: streamState.sessionId,
            text: streamState.replyText,
            usage: streamState.usage,
            usageEstimated: streamState.usageEstimated ?? false,
            time: now(),
          });
        }

        if (streamState.status === 'completed') {
          sendSse(res, 'end', {
            streamId,
            sessionId: streamState.sessionId,
            usage: streamState.usage,
            time: now(),
          });
          res.end();
          clients.delete(res);
          if (clients.size === 0) {
            chatStreamClients.delete(streamId);
          }
          return;
        }

        if (streamState.status === 'failed') {
          sendSse(res, 'chat-error', {
            streamId,
            sessionId: streamState.sessionId,
            error: streamState.error ?? 'Chat stream failed',
            time: now(),
          });
          res.end();
          clients.delete(res);
          if (clients.size === 0) {
            chatStreamClients.delete(streamId);
          }
          return;
        }

        req.on('close', () => {
          const group = chatStreamClients.get(streamId);
          if (!group) {
            return;
          }

          group.delete(res);
          if (group.size === 0) {
            chatStreamClients.delete(streamId);
          }
        });

        return;
      }

      if (req.method === 'POST' && pathname === '/api/work/chat/send-stream') {
        if (isDraining()) {
          sendJson(res, 503, { error: 'Server is shutting down. Please retry after restart.' });
          return;
        }
        const body = await readJsonBody(req);
        const id = asString(body.id);
        const message = asString(body.message);
        const messageParts = parseChatContentParts(body.messageParts);

        if (!id) {
          sendJson(res, 400, { error: 'Missing id' });
          return;
        }

        if (!message && messageParts.length === 0) {
          sendJson(res, 400, { error: 'Missing message' });
          return;
        }

        const session = workSessions.get(id);
        if (!session) {
          sendJson(res, 404, { error: 'Unknown work session' });
          return;
        }

                const readiness = await authManager.validateProviderReadiness(session.provider);
        if (!readiness.ok) {
          sendJson(res, 400, { error: readiness.message, code: readiness.code, remediation: readiness.remediation });
          return;
        }


        await ensureSessionWorkspaceReady(session, workspaceManager, uiStatePersistence);

        const thread = sessionChats.get(id) ?? createSessionChatThread(session);
        sessionChats.set(id, thread);

        const userMessage = createSessionChatMessage('user', message, messageParts);
        thread.messages.push(userMessage);
        trimThreadMessages(thread);
        thread.updatedAt = now();

        // Dual-write: user chat message
        emitSessionEvent(id, {
          time: thread.updatedAt,
          type: 'session:chat-message',
          payload: { message: userMessage },
        });

        const continuationPhase = resolveSessionToolMode(session);
        const previousSessionStatus = session.status;
        const chatStartedAt = now();
                        session.status = 'running';
        session.updatedAt = chatStartedAt;
        session.llmStatus = createLlmStatus('analyzing', chatStartedAt, {
          detail: 'Processing follow-up prompt.',
          phase: continuationPhase === 'planning' || continuationPhase === 'implementation'
            ? continuationPhase
            : undefined,
                });
        uiStatePersistence.schedule();
        broadcastSessionStatusUpsert(session);

        // Dual-write: session status + llm status change for chat follow-up
        emitSessionEvent(id, {

          time: chatStartedAt,
          type: 'session:status-change',
          payload: { status: 'running' },
        });
        emitSessionEvent(id, {
          time: chatStartedAt,
          type: 'session:llm-status-change',
          payload: { llmStatus: session.llmStatus },
        });

        const streamId = randomUUID();
        const streamState: ChatTokenStream = {
          id: streamId,
          sessionId: session.id,
          status: 'running',
          replyText: '',
          usage: { input: 0, output: 0, cost: 0 },
          usageEstimated: true,
          createdAt: now(),
          updatedAt: now(),
        };
        chatStreams.set(streamId, streamState);

        void (async () => {
          try {
            const systemPrompt = continuationPhase === 'planning'
              ? buildPlanningSystemPrompt(session)
              : continuationPhase === 'implementation'
                ? buildImplementationSystemPrompt(session)
                : buildChatSystemPrompt(session);
            const sharedContextStore = sessionSharedContextStores.get(session.id)
              ?? new InMemorySharedContextStore();
            sessionSharedContextStores.set(session.id, sharedContextStore);
            const fileReadCache = sessionFileReadCaches.get(session.id) ?? createFileReadCache();
            sessionFileReadCaches.set(session.id, fileReadCache);
            const contextEngine = sessionContextEngines.get(session.id)
              ?? createSessionContextEngine(session.provider, session.model);
            sessionContextEngines.set(session.id, contextEngine);
            const contextState = sessionContextStates.get(session.id) ?? { turnsSinceLastCompaction: 0 };

            const managedContext = await buildManagedChatContinuationInput({
              session,
              thread,
              systemPrompt,
              todos: sessionTodos.get(session.id) ?? [],
              contextEngine,
              contextState,
              sharedContextStore,
            });
            sessionContextStates.set(session.id, managedContext.nextState);

            const chatAgent = await llm.spawnAgent({
              provider: session.provider,
              model: session.model,
              timeoutMs: resolveLongTurnTimeoutMs(),
              systemPrompt,
              toolset: createAgentToolset({
                cwd: session.workspacePath,
                phase: continuationPhase,
                adaptiveConcurrency: session.adaptiveConcurrency,
                batchConcurrency: session.batchConcurrency,
                batchMinConcurrency: session.batchMinConcurrency,
                          resolveGithubToken: (resolveOptions) => githubAuthManager.resolveApiKey(GITHUB_PROVIDER_ID, resolveOptions),

                sharedContextStore: sessionSharedContextStores.get(session.id),
                fileReadCache,
                agentId: `chat::${session.id}`,
                runSubAgent: async (runSubAgentRequest, _signal) => {
                  const subProvider = runSubAgentRequest.provider ?? session.provider;
                  const subModel = runSubAgentRequest.model ?? session.model;
                  const subAgentSignal = session.controller.signal;
                  const toolCallId = `subagent-worker-${randomUUID()}`;
                  const subAgentTaskId = `chat::subagent::${runSubAgentRequest.nodeId ?? toolCallId}`;
                  const subAgentPhase: 'planning' | 'implementation' = continuationPhase === 'planning'
                    ? 'planning'
                    : 'implementation';
                  emitSubAgentWorkerEvent({
                    session,
                    uiStatePersistence,
                    persistEvent: emitSessionEvent,
                    taskId: 'chat',
                    phase: subAgentPhase,
                    toolCallId,
                    status: 'started',
                    provider: subProvider,
                    model: subModel,
                    reasoning: runSubAgentRequest.reasoning,
                    nodeId: runSubAgentRequest.nodeId,
                    prompt: runSubAgentRequest.prompt,
                  });
                  const subAgentToolset = createInheritedSubAgentToolset(session.workspacePath, {
                    phase: continuationPhase,
                    taskId: subAgentTaskId,
                    provider: subProvider,
                    model: subModel,
                    reasoning: runSubAgentRequest.reasoning,
                    adaptiveConcurrency: session.adaptiveConcurrency,
                    batchConcurrency: session.batchConcurrency,
                    batchMinConcurrency: session.batchMinConcurrency,
                              resolveGithubToken: (resolveOptions) => githubAuthManager.resolveApiKey(GITHUB_PROVIDER_ID, resolveOptions),

                    sharedContextStore: sessionSharedContextStores.get(session.id),
                    fileReadCache,
                    agentId: `subagent::${subAgentTaskId}`,
                  });
                  try {
                    const subAgent = await llm.spawnAgent({
                      provider: subProvider,
                      model: subModel,
                      reasoning: runSubAgentRequest.reasoning,
                      timeoutMs: resolveSubAgentTimeoutMs(),
                      systemPrompt: resolveSubAgentSystemPrompt(runSubAgentRequest),
                      signal: subAgentSignal,
                      toolset: subAgentToolset,
                                            apiKey: await resolveProviderApiKey(subProvider),
                      refreshApiKey: () => resolveProviderApiKey(subProvider),
                      allowAuthRefreshRetry: true,


                    });

                    const result = await completeSubAgentWithRetry(
                      subAgent,
                      runSubAgentRequest.prompt,
                      subAgentSignal,
                    );
                    const structuredResult = buildStructuredSubAgentResult(result);
                    emitSubAgentWorkerEvent({
                      session,
                      uiStatePersistence,
                      persistEvent: emitSessionEvent,
                      taskId: 'chat',
                      phase: subAgentPhase,
                      toolCallId,
                      status: 'completed',
                      provider: subProvider,
                      model: subModel,
                      reasoning: runSubAgentRequest.reasoning,
                      nodeId: runSubAgentRequest.nodeId,
                      prompt: runSubAgentRequest.prompt,
                      outputText: structuredResult.summary ?? result.text,
                      usage: result.usage,
                    });
                    return structuredResult;
                  } catch (error) {
                    emitSubAgentWorkerEvent({
                      session,
                      uiStatePersistence,
                      persistEvent: emitSessionEvent,
                      taskId: 'chat',
                      phase: subAgentPhase,
                      toolCallId,
                      status: 'failed',
                      provider: subProvider,
                      model: subModel,
                      reasoning: runSubAgentRequest.reasoning,
                      nodeId: runSubAgentRequest.nodeId,
                      prompt: runSubAgentRequest.prompt,
                      error: toErrorMessage(error),
                    });
                    throw error;
                  }
                },
              }),
                            apiKey: await resolveProviderApiKey(session.provider),
              refreshApiKey: () => resolveProviderApiKey(session.provider),
              allowAuthRefreshRetry: true,


            });

            const chatPrompt = managedContext.prompt;
            let response: Awaited<ReturnType<typeof chatAgent.complete>> | undefined;
            let receivedTextDelta = false;
            for (let attempt = 1; attempt <= CHAT_RETRY_MAX_ATTEMPTS; attempt += 1) {
              try {
                response = await chatAgent.complete(chatPrompt, undefined, {
                  onTextDelta: (delta) => {
                    if (!delta) {
                      return;
                    }

                    console.info(
                      `[trace:${session.id}] stream task=chat phase=${continuationPhase === 'planning' ? 'planning' : 'implementation'} delta=${stringifyTracePayload(delta)}`,
                    );

                    receivedTextDelta = true;
                    streamState.replyText += delta;
                    streamState.updatedAt = now();

                    const estimatedOutput = estimateTokensFromText(streamState.replyText);
                    streamState.usage = {
                      input: streamState.usage?.input ?? 0,
                      output: estimatedOutput,
                      cost: streamState.usage?.cost ?? 0,
                    };
                    streamState.usageEstimated = true;

                    // Dual-write: persist stream deltas for chat turns
                    emitSessionEvent(session.id, {
                      time: now(),
                      type: 'session:stream-delta',
                      payload: { taskId: 'chat', phase: continuationPhase === 'planning' ? 'planning' : 'implementation', delta },
                    });

                    broadcastWorkStream(chatStreamClients, streamId, 'token', {
                      streamId,
                      sessionId: session.id,
                      delta,
                      time: now(),
                    });

                    broadcastWorkStream(chatStreamClients, streamId, 'usage', {
                      streamId,
                      sessionId: session.id,
                      usage: streamState.usage,
                      estimated: true,
                      time: now(),
                    });
                  },
                  onUsage: (usage) => {
                    const isZeroUsage = usage.input === 0 && usage.output === 0 && usage.cost === 0;
                    if (isZeroUsage && streamState.replyText.length > 0) {
                      return;
                    }

                    const previous = streamState.usage;
                    if (
                      previous
                      && previous.input === usage.input
                      && previous.output === usage.output
                      && previous.cost === usage.cost
                    ) {
                      return;
                    }

                    streamState.usage = usage;
                    streamState.usageEstimated = false;
                    streamState.updatedAt = now();

                    broadcastWorkStream(chatStreamClients, streamId, 'usage', {
                      streamId,
                      sessionId: session.id,
                      usage,
                      estimated: false,
                      time: now(),
                    });
                  },
                  onToolCall: (toolEvent) => {
                    handleChatToolCallEvent(
                      session,
                      toolEvent,
                      sessionTodos,
                      pendingSubagentNodeIdsBySession,
                      workStreamClients,
                      uiStatePersistence,
                      emitSessionEvent,
                    );
                  },
                });
                break;
              } catch (error) {
                if (
                  attempt >= CHAT_RETRY_MAX_ATTEMPTS
                  || receivedTextDelta
                  || !isRetryableSubAgentError(error)
                ) {
                  throw error;
                }

                await new Promise<void>((resolve) => {
                  setTimeout(resolve, CHAT_RETRY_BASE_DELAY_MS * attempt);
                });
              }
            }

            if (!response) {
              throw new Error('Chat completion failed before producing a response.');
            }

            const responseText = ensureFollowUpSuggestions(response.text, continuationPhase);

            const assistantMessage: SessionChatMessage = {
              role: 'assistant',
              content: responseText,
              time: now(),
              usage: response.usage,
            };

            thread.messages.push(assistantMessage);
            trimThreadMessages(thread);
            const completedAt = now();
            thread.updatedAt = completedAt;
                        applyFollowUpCompletionState(
              session,
              sessionTodos.get(session.id) ?? [],
              continuationPhase,
              completedAt,
            );
            uiStatePersistence.schedule();
            broadcastSessionStatusUpsert(session);


            // Dual-write: chat assistant message + follow-up state
            emitSessionEvent(session.id, {
              time: completedAt,
              type: 'session:chat-message',
              payload: { message: assistantMessage },
            });
            emitSessionEvent(session.id, {
              time: completedAt,
              type: 'session:status-change',
              payload: { status: session.status },
            });
            emitSessionEvent(session.id, {
              time: completedAt,
              type: 'session:llm-status-change',
              payload: { llmStatus: session.llmStatus },
            });

            streamState.status = 'completed';
            streamState.replyText = responseText;
            streamState.usage = response.usage;
            streamState.usageEstimated = false;
            streamState.updatedAt = now();

            broadcastWorkStream(chatStreamClients, streamId, 'end', {
              streamId,
              sessionId: session.id,
              usage: response.usage,
              usageEstimated: false,
              time: now(),
            });
            closeWorkStream(chatStreamClients, streamId);
            scheduleChatStreamCleanup(chatStreams, streamId);
          } catch (error) {
            streamState.status = 'failed';
            streamState.error = toErrorMessage(error);
            streamState.updatedAt = now();

            const failedAt = now();
                        applyFollowUpFailureState(
              session,
              sessionTodos.get(session.id) ?? [],
              continuationPhase,
              previousSessionStatus,
              streamState.error,
              failedAt,
            );
            uiStatePersistence.schedule();
            broadcastSessionStatusUpsert(session);


            // Dual-write: streaming chat failure state
            emitSessionEvent(session.id, { time: failedAt, type: 'session:status-change', payload: { status: session.status } });
            emitSessionEvent(session.id, { time: failedAt, type: 'session:llm-status-change', payload: { llmStatus: session.llmStatus } });

            broadcastWorkStream(chatStreamClients, streamId, 'chat-error', {
              streamId,
              sessionId: session.id,
              error: streamState.error,
              time: now(),
            });
            closeWorkStream(chatStreamClients, streamId);
            scheduleChatStreamCleanup(chatStreams, streamId);
          }
        })();

        sendJson(res, 200, { ok: true, streamId, sessionId: session.id });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/work/chat/send') {
        if (isDraining()) {
          sendJson(res, 503, { error: 'Server is shutting down. Please retry after restart.' });
          return;
        }
        const body = await readJsonBody(req);
        const id = asString(body.id);
        const message = asString(body.message);
        const messageParts = parseChatContentParts(body.messageParts);

        if (!id) {
          sendJson(res, 400, { error: 'Missing id' });
          return;
        }

        if (!message && messageParts.length === 0) {
          sendJson(res, 400, { error: 'Missing message' });
          return;
        }

        const session = workSessions.get(id);
        if (!session) {
          sendJson(res, 404, { error: 'Unknown work session' });
          return;
        }

                const readiness = await authManager.validateProviderReadiness(session.provider);
        if (!readiness.ok) {
          sendJson(res, 400, { error: readiness.message, code: readiness.code, remediation: readiness.remediation });
          return;
        }


        await ensureSessionWorkspaceReady(session, workspaceManager, uiStatePersistence);

        const thread = sessionChats.get(id) ?? createSessionChatThread(session);
        sessionChats.set(id, thread);
        uiStatePersistence.schedule();

        const userMessage = createSessionChatMessage('user', message, messageParts);
        thread.messages.push(userMessage);
        trimThreadMessages(thread);
        const continuationPhase = resolveSessionToolMode(session);
        const previousSessionStatus = session.status;
        const chatStartedAt = now();
                thread.updatedAt = chatStartedAt;
        session.status = 'running';
        session.updatedAt = chatStartedAt;
        session.llmStatus = createLlmStatus('analyzing', chatStartedAt, {
          detail: 'Processing follow-up prompt.',
          phase: continuationPhase === 'planning' || continuationPhase === 'implementation'
            ? continuationPhase
            : undefined,
        });
        uiStatePersistence.schedule();
        broadcastSessionStatusUpsert(session);

        // Dual-write: sync chat user message + status
        emitSessionEvent(id, { time: chatStartedAt, type: 'session:chat-message', payload: { message: userMessage } });
        emitSessionEvent(id, { time: chatStartedAt, type: 'session:status-change', payload: { status: 'running' } });
        emitSessionEvent(id, { time: chatStartedAt, type: 'session:llm-status-change', payload: { llmStatus: session.llmStatus } });


        try {
          const systemPrompt = continuationPhase === 'planning'
            ? buildPlanningSystemPrompt(session)
            : continuationPhase === 'implementation'
              ? buildImplementationSystemPrompt(session)
              : buildChatSystemPrompt(session);
          const sharedContextStore = sessionSharedContextStores.get(session.id)
            ?? new InMemorySharedContextStore();
          sessionSharedContextStores.set(session.id, sharedContextStore);
          const fileReadCache = sessionFileReadCaches.get(session.id) ?? createFileReadCache();
          sessionFileReadCaches.set(session.id, fileReadCache);
          const contextEngine = sessionContextEngines.get(session.id)
            ?? createSessionContextEngine(session.provider, session.model);
          sessionContextEngines.set(session.id, contextEngine);
          const contextState = sessionContextStates.get(session.id) ?? { turnsSinceLastCompaction: 0 };

          const managedContext = await buildManagedChatContinuationInput({
            session,
            thread,
            systemPrompt,
            todos: sessionTodos.get(session.id) ?? [],
            contextEngine,
            contextState,
            sharedContextStore,
          });
          sessionContextStates.set(session.id, managedContext.nextState);

          const chatAgent = await llm.spawnAgent({
            provider: session.provider,
            model: session.model,
            timeoutMs: resolveLongTurnTimeoutMs(),
            systemPrompt,
            toolset: createAgentToolset({
              cwd: session.workspacePath,
              phase: continuationPhase,
              adaptiveConcurrency: session.adaptiveConcurrency,
              batchConcurrency: session.batchConcurrency,
              batchMinConcurrency: session.batchMinConcurrency,
                        resolveGithubToken: (resolveOptions) => githubAuthManager.resolveApiKey(GITHUB_PROVIDER_ID, resolveOptions),

              sharedContextStore: sessionSharedContextStores.get(session.id),
              fileReadCache,
              agentId: `chat::${session.id}`,
              runSubAgent: async (runSubAgentRequest, _signal) => {
                const subProvider = runSubAgentRequest.provider ?? session.provider;
                const subModel = runSubAgentRequest.model ?? session.model;
                const subAgentSignal = session.controller.signal;
                const toolCallId = `subagent-worker-${randomUUID()}`;
                const subAgentTaskId = `chat::subagent::${runSubAgentRequest.nodeId ?? toolCallId}`;
                const subAgentPhase: 'planning' | 'implementation' = continuationPhase === 'planning'
                  ? 'planning'
                  : 'implementation';
                emitSubAgentWorkerEvent({
                  session,
                  uiStatePersistence,
                  persistEvent: emitSessionEvent,
                  taskId: 'chat',
                  phase: subAgentPhase,
                  toolCallId,
                  status: 'started',
                  provider: subProvider,
                  model: subModel,
                  reasoning: runSubAgentRequest.reasoning,
                  nodeId: runSubAgentRequest.nodeId,
                  prompt: runSubAgentRequest.prompt,
                });
                const subAgentToolset = createInheritedSubAgentToolset(session.workspacePath, {
                  phase: continuationPhase,
                  taskId: subAgentTaskId,
                  provider: subProvider,
                  model: subModel,
                  reasoning: runSubAgentRequest.reasoning,
                  adaptiveConcurrency: session.adaptiveConcurrency,
                  batchConcurrency: session.batchConcurrency,
                  batchMinConcurrency: session.batchMinConcurrency,
                            resolveGithubToken: (resolveOptions) => githubAuthManager.resolveApiKey(GITHUB_PROVIDER_ID, resolveOptions),

                  sharedContextStore: sessionSharedContextStores.get(session.id),
                  fileReadCache,
                  agentId: `subagent::${subAgentTaskId}`,
                });
                try {
                  const subAgent = await llm.spawnAgent({
                    provider: subProvider,
                    model: subModel,
                    reasoning: runSubAgentRequest.reasoning,
                    timeoutMs: resolveSubAgentTimeoutMs(),
                    systemPrompt: resolveSubAgentSystemPrompt(runSubAgentRequest),
                    signal: subAgentSignal,
                    toolset: subAgentToolset,
                                        apiKey: await resolveProviderApiKey(subProvider),
                    refreshApiKey: () => resolveProviderApiKey(subProvider),
                    allowAuthRefreshRetry: true,


                  });

                  const result = await completeSubAgentWithRetry(
                    subAgent,
                    runSubAgentRequest.prompt,
                    subAgentSignal,
                  );
                  const structuredResult = buildStructuredSubAgentResult(result);
                  emitSubAgentWorkerEvent({
                    session,
                    uiStatePersistence,
                    persistEvent: emitSessionEvent,
                    taskId: 'chat',
                    phase: subAgentPhase,
                    toolCallId,
                    status: 'completed',
                    provider: subProvider,
                    model: subModel,
                    reasoning: runSubAgentRequest.reasoning,
                    nodeId: runSubAgentRequest.nodeId,
                    prompt: runSubAgentRequest.prompt,
                    outputText: structuredResult.summary ?? result.text,
                    usage: result.usage,
                  });
                  return structuredResult;
                } catch (error) {
                  emitSubAgentWorkerEvent({
                    session,
                    uiStatePersistence,
                    persistEvent: emitSessionEvent,
                    taskId: 'chat',
                    phase: subAgentPhase,
                    toolCallId,
                    status: 'failed',
                    provider: subProvider,
                    model: subModel,
                    reasoning: runSubAgentRequest.reasoning,
                    nodeId: runSubAgentRequest.nodeId,
                    prompt: runSubAgentRequest.prompt,
                    error: toErrorMessage(error),
                  });
                  throw error;
                }
              },
            }),
                        apiKey: await resolveProviderApiKey(session.provider),
            refreshApiKey: () => resolveProviderApiKey(session.provider),
            allowAuthRefreshRetry: true,


          });

          const chatPrompt = managedContext.prompt;
          let response: Awaited<ReturnType<typeof chatAgent.complete>> | undefined;
          for (let attempt = 1; attempt <= CHAT_RETRY_MAX_ATTEMPTS; attempt += 1) {
            try {
              response = await chatAgent.complete(chatPrompt, undefined, {
                onToolCall: (toolEvent) => {
                  handleChatToolCallEvent(
                    session,
                    toolEvent,
                    sessionTodos,
                    pendingSubagentNodeIdsBySession,
                    workStreamClients,
                    uiStatePersistence,
                    emitSessionEvent,
                  );
                },
              });
              break;
            } catch (error) {
              if (attempt >= CHAT_RETRY_MAX_ATTEMPTS || !isRetryableSubAgentError(error)) {
                throw error;
              }

              await new Promise<void>((resolve) => {
                setTimeout(resolve, CHAT_RETRY_BASE_DELAY_MS * attempt);
              });
            }
          }

          if (!response) {
            throw new Error('Chat completion failed before producing a response.');
          }
          const text = ensureFollowUpSuggestions(response.text, continuationPhase);

          const assistantMessage: SessionChatMessage = {
            role: 'assistant',
            content: text,
            time: now(),
            usage: response.usage,
          };

          thread.messages.push(assistantMessage);
          trimThreadMessages(thread);
          const completedAt = now();
          thread.updatedAt = completedAt;
                    applyFollowUpCompletionState(
            session,
            sessionTodos.get(session.id) ?? [],
            continuationPhase,
            completedAt,
          );
          uiStatePersistence.schedule();
          broadcastSessionStatusUpsert(session);


          // Dual-write: sync chat assistant message + follow-up state
          emitSessionEvent(session.id, { time: completedAt, type: 'session:chat-message', payload: { message: assistantMessage } });
          emitSessionEvent(session.id, { time: completedAt, type: 'session:status-change', payload: { status: session.status } });
          emitSessionEvent(session.id, { time: completedAt, type: 'session:llm-status-change', payload: { llmStatus: session.llmStatus } });

          sendJson(res, 200, {
            ok: true,
            reply: assistantMessage,
            messages: thread.messages.filter((entry) => entry.role !== 'system'),
          });
          return;
        } catch (error) {
          const failedAt = now();
          const detail = toErrorMessage(error);
                    applyFollowUpFailureState(
            session,
            sessionTodos.get(session.id) ?? [],
            continuationPhase,
            previousSessionStatus,
            detail,
            failedAt,
          );
          uiStatePersistence.schedule();
          broadcastSessionStatusUpsert(session);


          // Dual-write: sync chat failure state
          emitSessionEvent(session.id, { time: failedAt, type: 'session:status-change', payload: { status: session.status } });
          emitSessionEvent(session.id, { time: failedAt, type: 'session:llm-status-change', payload: { llmStatus: session.llmStatus } });

          sendJson(res, 500, { error: detail });
          return;
        }
      }

      // -- Observer API -------------------------------------------------------

      // Per-session observer state
      if (req.method === 'GET' && pathname === '/api/observer/session') {
        const sessionId = asString(url.searchParams.get('id'));
        if (!sessionId) {
          sendJson(res, 400, { error: 'Missing id' });
          return;
        }
        const obs = sessionObservers.get(sessionId);
        sendJson(res, 200, {
          active: !!obs,
          state: obs?.getState() ?? null,
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/observer/status') {
        sendJson(res, 200, {
          config: observerDaemon.getConfig(),
          state: observerDaemon.getState(),
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/observer/findings') {
        sendJson(res, 200, { findings: observerDaemon.getFindings() });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/observer/failed-sessions') {
        const findings = observerDaemon.getFindings();
        const analyzedSessionIds = new Set(observerDaemon.getAnalyzedSessionIds());
        const monitoredSessions = [...workSessions.values()]
          .filter((session) => session.status === 'failed' && session.source !== 'observer')
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          .map((session) => {
            const relatedFindings = findings.filter((finding) => (
              finding.observedInSessions.includes(session.id)
              || finding.additionalSessions.includes(session.id)
            ));
            const fixStatusCounts = {
              pending: relatedFindings.filter((finding) => finding.fixStatus === 'pending').length,
              spawned: relatedFindings.filter((finding) => finding.fixStatus === 'spawned').length,
              completed: relatedFindings.filter((finding) => finding.fixStatus === 'completed').length,
              failed: relatedFindings.filter((finding) => finding.fixStatus === 'failed').length,
            };
            const latestFindingAt = relatedFindings
              .map((finding) => finding.detectedAt)
              .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;

            return {
              sessionId: session.id,
              workspaceId: session.workspaceId,
              workspaceName: session.workspaceName,
              prompt: session.prompt,
              status: session.status,
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
              observer: {
                analyzed: analyzedSessionIds.has(session.id) || relatedFindings.length > 0,
                findings: relatedFindings.length,
                latestFindingAt,
                fixStatusCounts,
              },
            };
          });

        sendJson(res, 200, { sessions: monitoredSessions });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/observer/enable') {
        await observerDaemon.setEnabled(true);
        if (logWatcher.getState().status === 'idle' || logWatcher.getState().status === 'stopped') {
          logWatcher.start(backendLogger);
        }
        sendJson(res, 200, { enabled: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/observer/disable') {
        await observerDaemon.setEnabled(false);
        logWatcher.stop();
        sendJson(res, 200, { enabled: false });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/observer/config') {
        const body = await readJsonBody(req);
        await observerDaemon.updateConfig(body);
        logWatcher.updateConfig(observerDaemon.getConfig());
        sendJson(res, 200, { config: observerDaemon.getConfig() });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/observer/trigger') {
        const result = await observerDaemon.triggerAnalysis();
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/observer/spawn-all') {
        const spawned = await observerDaemon.spawnAll();
        sendJson(res, 200, { spawned });
        return;
      }

      // -- Log watcher API ---------------------------------------------------
      if (req.method === 'GET' && pathname === '/api/logs/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');

        // Preload a recent log tail so the UI has immediate content.
        try {
          const logText = await readFile(backendLogger.getLogPath(), 'utf8');
          const lines = logText
            .split(/\r?\n/)
            .map((line) => line.trimEnd())
            .filter((line) => line.length > 0);
          const recentLines = lines.slice(-400);
          for (const line of recentLines) {
            sendSse(res, 'log', { line });
          }
                } catch (error) {
          reportLogStreamError({
            source: 'log-stream',
            operation: 'preload-log-tail',
            message: toErrorMessage(error),
            severity: 'warning',
            context: {
              logPath: backendLogger.getLogPath(),
            },
          });
        }


        logStreamClients.add(res);
        // Send current state as initial payload
        sendSse(res, 'log-watcher-state', { state: logWatcher.getState() });
        req.on('close', () => {
          logStreamClients.delete(res);
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/logs/status') {
        sendJson(res, 200, { state: logWatcher.getState() });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/logs/findings') {
        sendJson(res, 200, { findings: logWatcher.getFindings() });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(res, 500, { error: toErrorMessage(error) });
    }
  });

  // -- Graceful shutdown state ------------------------------------------------
  let draining = false;

  await new Promise<void>((resolvePromise) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`UI server listening on http://127.0.0.1:${port}`);
      if (hmrEnabled) {
        console.log('UI HMR enabled (live reload).');
      }
      resolvePromise();
    });
  });

  // -- Graceful shutdown on SIGTERM / SIGINT ----------------------------------
  const gracefulShutdown = (signal: string) => {
    if (draining) return; // already shutting down
    draining = true;

    const runningSessions = [...workSessions.values()].filter((s) => s.status === 'running');
    console.log(
      `\n[orchestrace] Received ${signal} — shutting down gracefully.` +
      (runningSessions.length > 0
        ? ` ${runningSessions.length} runner(s) will continue in the background and reconnect on next startup.`
        : ''),
    );

    // Notify all SSE clients that the server is shutting down so UIs can show a reconnect state
    const shutdownPayload = { reason: signal, time: now() };
    for (const clients of workStreamClients.values()) {
      for (const client of clients) {
        try { sendSse(client, 'server-shutdown', shutdownPayload); } catch { /* ignore */ }
      }
    }
    for (const client of sessionStatusStreamClients) {
      try { sendSse(client, 'server-shutdown', shutdownPayload); } catch { /* ignore */ }
    }
    for (const client of logStreamClients) {
      try { sendSse(client, 'server-shutdown', shutdownPayload); } catch { /* ignore */ }
    }

    // Close the HTTP server (stops accepting new connections, drains inflight)
    server.close(() => {
      console.log('[orchestrace] Server closed. Exiting.');
      process.exit(0);
    });

    // Force exit after 10s if draining hangs
    setTimeout(() => {
      console.warn('[orchestrace] Graceful shutdown timed out after 10s — forcing exit.');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  /** Check whether the server is draining (shutting down). Used by request handlers to reject new work. */
  function isDraining(): boolean {
    return draining;
  }

    server.on('close', () => {
    void uiStatePersistence.flush();
    prMergeScanner.stop();
    observerDaemon.stop();

    logWatcher.stop();
    backendLogger.stop();
    // Stop all per-session observers
    for (const [, obs] of sessionObservers) {
      obs.stop();
    }
    sessionObservers.clear();
    // Close log stream SSE clients
    for (const client of logStreamClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    logStreamClients.clear();
    hmrWatcher?.close();
    hmrClients.clear();
    for (const [id] of workStreamClients) {
      closeWorkStream(workStreamClients, id);
    }
    for (const [id] of chatStreamClients) {
      closeWorkStream(chatStreamClients, id);
    }
    for (const client of sessionStatusStreamClients) {
      try {
        client.end();
      } catch {
        // ignore close errors
      }
    }
    sessionStatusStreamClients.clear();
  });
}

function createUiStatePersistence(
  path: string,
  workSessions: Map<string, WorkSession>,
  sessionChats: Map<string, SessionChatThread>,
  sessionTodos: Map<string, AgentTodoItem[]>,
  getUiPreferences: () => UiPreferences,
): { schedule: () => void; flush: () => Promise<void> } {
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing = false;

  const writeNow = async (): Promise<void> => {
    if (!dirty) {
      return;
    }

    if (writing) {
      return;
    }

    writing = true;
    try {
      while (dirty) {
        dirty = false;
        await persistUiState(path, workSessions, sessionChats, sessionTodos, getUiPreferences());
      }
    } finally {
      writing = false;
    }
  };

  return {
    schedule: () => {
      dirty = true;
      if (timer) {
        return;
      }

      timer = setTimeout(() => {
        timer = undefined;
        void writeNow();
      }, 220);
    },
    flush: async () => {
      dirty = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await writeNow();
    },
  };
}

async function restoreUiState(
  path: string,
  workSessions: Map<string, WorkSession>,
  sessionChats: Map<string, SessionChatThread>,
  sessionTodos: Map<string, AgentTodoItem[]>,
): Promise<PersistedUiPreferences | undefined> {
  const payload = await readPersistedUiState(path);
  if (!payload) {
    return undefined;
  }

  for (const persisted of payload.sessions) {
    workSessions.set(persisted.id, hydratePersistedSession(persisted));
  }

  for (const thread of payload.chats) {
    const session = workSessions.get(thread.sessionId);
    if (!session) {
      continue;
    }

    sessionChats.set(thread.sessionId, {
      sessionId: thread.sessionId,
      provider: thread.provider || session.provider,
      model: thread.model || session.model,
      workspacePath: thread.workspacePath || session.workspacePath,
      taskPrompt: thread.taskPrompt || session.prompt,
      createdAt: thread.createdAt || session.createdAt,
      updatedAt: thread.updatedAt || session.updatedAt,
      messages: Array.isArray(thread.messages) ? thread.messages : [],
    });
  }

  const persistedTodos = Array.isArray(payload.todos) ? payload.todos : [];
  for (const entry of persistedTodos) {
    const sessionId = asString(entry.sessionId);
    if (!sessionId || !workSessions.has(sessionId)) {
      continue;
    }

    const items = Array.isArray(entry.items)
      ? entry.items
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          id: asString(item.id) || randomUUID(),
          text: asString(item.text),
          status: normalizeChecklistTodoStatus(item.status) ?? (Boolean(item.done) ? 'done' : 'todo'),
          done: Boolean(item.done),
          weight: normalizeProgressWeight(item.weight),
          createdAt: asString(item.createdAt) || now(),
          updatedAt: asString(item.updatedAt) || now(),
        }))
        .filter((item) => item.text.length > 0)
      : [];

    sessionTodos.set(sessionId, items);
  }

  for (const [sessionId, session] of workSessions.entries()) {
    const existingItems = sessionTodos.get(sessionId) ?? [];
    if (existingItems.length > 0) {
      if ((session.agentGraph?.length ?? 0) === 0) {
        backfillAgentGraphFromUiEvents(session);
      }
      continue;
    }

    if (backfillChecklistFromUiEvents(sessionId, session.events, sessionTodos)) {
      // Derived checklist entries from past tool-call events.
    }

    if ((session.agentGraph?.length ?? 0) === 0) {
      backfillAgentGraphFromUiEvents(session);
    }
  }

  return payload.preferences;
}

function computeSessionCompletionState(
  session: WorkSession,
  todos: AgentTodoItem[],
): {
  satisfied: boolean;
  pendingTodoCount: number;
  nonCompletedNodeCount: number;
  failedNodeCount: number;
} {
  const pendingTodoCount = todos.filter((item) => !item.done).length;
  const nonCompletedNodes = session.agentGraph.filter((node) => node.status !== 'completed');
  const nonCompletedNodeCount = nonCompletedNodes.length;
  const failedNodeCount = nonCompletedNodes.filter((node) => node.status === 'failed').length;

  return {
    satisfied: pendingTodoCount === 0 && nonCompletedNodeCount === 0,
    pendingTodoCount,
    nonCompletedNodeCount,
    failedNodeCount,
  };
}

function describeRemainingCompletionWork(completion: {
  pendingTodoCount: number;
  nonCompletedNodeCount: number;
}): string {
  const remaining: string[] = [];
  if (completion.pendingTodoCount > 0) {
    remaining.push(`${completion.pendingTodoCount} todo(s) pending`);
  }
  if (completion.nonCompletedNodeCount > 0) {
    remaining.push(`${completion.nonCompletedNodeCount} graph node(s) pending`);
  }

  return remaining.join(', ');
}

function applyFollowUpCompletionState(
  session: WorkSession,
  todos: AgentTodoItem[],
  phase: SessionPromptPhase,
  updatedAt: string,
): void {
  const completion = computeSessionCompletionState(session, todos);
  if (completion.satisfied) {
    session.status = 'completed';
    session.updatedAt = updatedAt;
    session.error = undefined;
    session.llmStatus = createLlmStatus('completed', updatedAt, {
      detail: 'Follow-up response generated.',
    });
    return;
  }

  const phaseForStatus: LlmSessionState = phase === 'planning'
    ? 'planning'
    : phase === 'implementation'
      ? 'implementing'
      : 'thinking';
  const phaseDetail = phase === 'planning' || phase === 'implementation' ? phase : undefined;

  session.status = 'running';
  session.updatedAt = updatedAt;
  session.error = undefined;
  session.llmStatus = createLlmStatus(phaseForStatus, updatedAt, {
    detail: `Follow-up response generated; ${describeRemainingCompletionWork(completion)}.`,
    phase: phaseDetail,
  });
}

function applyFollowUpFailureState(
  session: WorkSession,
  todos: AgentTodoItem[],
  phase: SessionPromptPhase,
  previousStatus: WorkState,
  detail: string,
  updatedAt: string,
): void {
  const completion = computeSessionCompletionState(session, todos);
  if (previousStatus === 'completed' && completion.satisfied) {
    session.status = 'completed';
    session.updatedAt = updatedAt;
    session.error = undefined;
    session.llmStatus = createLlmStatus('completed', updatedAt, {
      detail: 'Follow-up request failed; preserving completed run state.',
    });
    return;
  }

  const phaseDetail = phase === 'planning' || phase === 'implementation' ? phase : undefined;
  session.status = 'running';
  session.updatedAt = updatedAt;
  session.error = undefined;
  session.llmStatus = createLlmStatus('failed', updatedAt, {
    detail,
    phase: phaseDetail,
  });
}

async function persistUiState(
  path: string,
  workSessions: Map<string, WorkSession>,
  sessionChats: Map<string, SessionChatThread>,
  sessionTodos: Map<string, AgentTodoItem[]>,
  preferences: UiPreferences,
): Promise<void> {
  const persistRawDebug = shouldPersistRawDebugArtifacts();
  const rawSessions = [...workSessions.values()]
    .map(toPersistedSession)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const rawChats = [...sessionChats.values()]
    .map((thread) => ({
      ...thread,
      messages: [...thread.messages],
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const safePayload: PersistedUiState = {
    version: 1,
    updatedAt: now(),
    sessions: rawSessions.map((session) => sanitizePersistedSession(session)),
    chats: rawChats.map((thread) => sanitizePersistedChatThread(thread)),
    todos: [...sessionTodos.entries()]
      .map(([sessionId, items]) => ({
        sessionId,
        items: items.map((item) => ({ ...item })),
      }))
      .sort((a, b) => b.sessionId.localeCompare(a.sessionId)),
    preferences: { ...preferences },
  };

  const rawPayload: PersistedUiState | undefined = persistRawDebug
    ? {
      ...safePayload,
      sessions: rawSessions,
      chats: rawChats,
    }
    : undefined;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(safePayload, null, 2), 'utf-8');

  if (rawPayload) {
    await writeFile(resolveRawArtifactPath(path), JSON.stringify(rawPayload, null, 2), 'utf-8');
  }
}

async function readPersistedUiState(path: string): Promise<PersistedUiState | undefined> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistedUiState>;

    if (!parsed || parsed.version !== 1) {
      return undefined;
    }

    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now(),
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions as PersistedWorkSession[] : [],
      chats: Array.isArray(parsed.chats) ? parsed.chats as SessionChatThread[] : [],
      todos: Array.isArray(parsed.todos)
        ? parsed.todos as Array<{ sessionId: string; items: AgentTodoItem[] }>
        : [],
      preferences: isRecord(parsed.preferences) ? parsed.preferences as PersistedUiPreferences : undefined,
    };
  } catch {
    return undefined;
  }
}

function shouldPersistRawDebugArtifacts(): boolean {
  return parseBooleanSetting(process.env[PERSIST_RAW_DEBUG_ENV]) ?? false;
}

function resolveRawArtifactPath(path: string): string {
  if (path.endsWith('.json')) {
    return `${path.slice(0, -5)}.raw.json`;
  }

  return `${path}.raw.json`;
}

function sanitizePersistedSession(session: PersistedWorkSession): PersistedWorkSession {
  return {
    ...session,
    prompt: sanitizePersistedText(session.prompt, PERSIST_TEXT_MAX_CHARS),
    promptParts: sanitizePersistedContentParts(session.promptParts),
    events: session.events.map((event) => ({
      ...event,
      message: sanitizePersistedText(event.message, PERSIST_EVENT_MESSAGE_MAX_CHARS),
    })),
    error: session.error ? sanitizePersistedText(session.error, PERSIST_TEXT_MAX_CHARS) : undefined,
    output: session.output
      ? {
        ...session.output,
        text: session.output.text
          ? sanitizePersistedText(session.output.text, PERSIST_TEXT_MAX_CHARS)
          : session.output.text,
      }
      : session.output,
  };
}

function sanitizePersistedChatThread(thread: SessionChatThread): SessionChatThread {
  return {
    ...thread,
    taskPrompt: sanitizePersistedText(thread.taskPrompt, PERSIST_TEXT_MAX_CHARS),
    messages: thread.messages.map((message) => ({
      ...message,
      content: sanitizePersistedText(message.content, PERSIST_CHAT_MESSAGE_MAX_CHARS),
      contentParts: sanitizePersistedContentParts(message.contentParts),
    })),
  };
}

function sanitizePersistedContentParts(parts: SessionChatContentPart[] | undefined): SessionChatContentPart[] | undefined {
  if (!parts || parts.length === 0) {
    return undefined;
  }

  const sanitized = parts.map((part): SessionChatContentPart => {
    if (part.type === 'text') {
      return {
        type: 'text',
        text: sanitizePersistedText(part.text, PERSIST_CHAT_MESSAGE_MAX_CHARS),
      };
    }

    return {
      type: 'text',
      text: `[image omitted${part.name ? `: ${part.name}` : ''}]`,
    };
  });

  return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizePersistedText(text: string, maxChars: number): string {
  const redacted = sanitizeLogLine(asString(text));
  if (redacted.length <= maxChars) {
    return redacted;
  }

  return `${redacted.slice(0, maxChars)}... [truncated]`;
}

function toPersistedSession(session: WorkSession): PersistedWorkSession {
  const resolvedAgentModels = resolveSessionAgentModels({
    provider: session.provider,
    model: session.model,
    planningProvider: session.planningProvider,
    planningModel: session.planningModel,
    implementationProvider: session.implementationProvider,
    implementationModel: session.implementationModel,
    agentModels: session.agentModels,
  });
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    workspaceName: session.workspaceName,
    workspacePath: session.workspacePath,
    prompt: session.prompt,
    promptParts: session.promptParts
      ? session.promptParts.map((part) => {
        if (part.type === 'text') {
          return { type: 'text', text: part.text };
        }

        return {
          type: 'image',
          data: part.data,
          mimeType: part.mimeType,
          name: part.name,
        };
      })
      : undefined,
    provider: resolvedAgentModels.implementationProvider,
    model: resolvedAgentModels.implementationModel,
    agentModels: resolvedAgentModels.agentModels,
    planningProvider: resolvedAgentModels.planningProvider,
    planningModel: resolvedAgentModels.planningModel,
    implementationProvider: resolvedAgentModels.implementationProvider,
    implementationModel: resolvedAgentModels.implementationModel,
    deliveryStrategy: session.deliveryStrategy,
    autoApprove: session.autoApprove,
    planningNoToolGuardMode: session.planningNoToolGuardMode,
    quickStartMode: session.quickStartMode,
    quickStartMaxPreDelegationToolCalls: session.quickStartMaxPreDelegationToolCalls,
    adaptiveConcurrency: session.adaptiveConcurrency,
    batchConcurrency: session.batchConcurrency,
    batchMinConcurrency: session.batchMinConcurrency,
    enableTrivialTaskGate: session.enableTrivialTaskGate,
    trivialTaskMaxPromptLength: session.trivialTaskMaxPromptLength,
    worktreePath: session.worktreePath,
    worktreeBranch: session.worktreeBranch,
    creationReason: session.creationReason,
    sourceSessionId: session.sourceSessionId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status,
    llmStatus: session.llmStatus,
    taskStatus: { ...session.taskStatus },
    events: [...session.events],
    agentGraph: session.agentGraph.map((node) => ({
      ...node,
      dependencies: [...node.dependencies],
    })),
    error: session.error,
    output: session.output,
  };
}

function hydratePersistedSession(session: PersistedWorkSession): WorkSession {
  const resumedStatus: WorkState = session.status === 'running' ? 'failed' : session.status;
  const resumedError = session.status === 'running'
    ? 'Session interrupted because the UI server restarted.'
    : session.error;
  const resumedUpdatedAt = asString(session.updatedAt) || now();
  const promptParts = parseChatContentParts(session.promptParts);
  const persistedLlmStatus = session.llmStatus
    ? normalizeLlmStatus(session.llmStatus, resumedUpdatedAt)
    : undefined;
  const resumedLlmStatus = resolveHydratedLlmStatus(
    resumedStatus,
    resumedUpdatedAt,
    resumedError,
    persistedLlmStatus,
  );
  const resolvedAgentModels = resolveSessionAgentModels({
    provider: asString(session.provider),
    model: asString(session.model),
    planningProvider: asString(session.planningProvider),
    planningModel: asString(session.planningModel),
    implementationProvider: asString(session.implementationProvider),
    implementationModel: asString(session.implementationModel),
    agentModels: session.agentModels,
  });

  return {
    ...session,
    planningProvider: resolvedAgentModels.planningProvider,
    planningModel: resolvedAgentModels.planningModel,
    implementationProvider: resolvedAgentModels.implementationProvider,
    implementationModel: resolvedAgentModels.implementationModel,
    deliveryStrategy: normalizeSessionDeliveryStrategy(session.deliveryStrategy),
    provider: resolvedAgentModels.implementationProvider,
    model: resolvedAgentModels.implementationModel,
    agentModels: resolvedAgentModels.agentModels,
    promptParts: promptParts.length > 0 ? promptParts : undefined,
    planningNoToolGuardMode: normalizePlanningNoToolGuardMode(session.planningNoToolGuardMode)
      ?? resolvePlanningNoToolGuardModeDefault(),
    quickStartMode: parseBooleanSetting(session.quickStartMode)
      ?? (parseBooleanSetting(process.env.ORCHESTRACE_QUICK_START_MODE) ?? false),
    quickStartMaxPreDelegationToolCalls: normalizePositiveSetting(
      session.quickStartMaxPreDelegationToolCalls,
      parsePositiveSetting(process.env.ORCHESTRACE_QUICK_START_MAX_PRE_DELEGATION_TOOL_CALLS) ?? 3,
    ),
    adaptiveConcurrency: parseBooleanSetting(session.adaptiveConcurrency) ?? resolveAdaptiveConcurrencyDefault(),
    batchConcurrency: normalizePositiveSetting(session.batchConcurrency, resolveBatchConcurrencyDefault()),
    batchMinConcurrency: Math.min(
      normalizePositiveSetting(session.batchConcurrency, resolveBatchConcurrencyDefault()),
      normalizePositiveSetting(session.batchMinConcurrency, resolveBatchMinConcurrencyDefault()),
    ),
    enableTrivialTaskGate: parseBooleanSetting(session.enableTrivialTaskGate) ?? resolveTrivialTaskGateDefault(),
    trivialTaskMaxPromptLength: normalizePositiveSetting(
      session.trivialTaskMaxPromptLength,
      resolveTrivialTaskMaxPromptLengthDefault(),
    ),
    worktreePath: asString(session.worktreePath) || undefined,
    worktreeBranch: asString(session.worktreeBranch) || undefined,
    creationReason: normalizeSessionCreationReason(session.creationReason),
    sourceSessionId: asString(session.sourceSessionId) || undefined,
    agentGraph: normalizeSessionAgentGraphNodes(session.agentGraph),
    status: resumedStatus,
    llmStatus: resumedLlmStatus,
    error: resumedError,
    controller: new AbortController(),
  };
}

function resolveHydratedLlmStatus(
  status: WorkState,
  updatedAt: string,
  error: string | undefined,
  persisted: SessionLlmStatus | undefined,
): SessionLlmStatus {
  if (!persisted) {
    return deriveLlmStatusFromWorkState(status, updatedAt, error);
  }

  if (status === 'completed' && persisted.state !== 'completed') {
    return deriveLlmStatusFromWorkState(status, updatedAt, error);
  }

  if (status === 'failed' && persisted.state !== 'failed') {
    return deriveLlmStatusFromWorkState(status, updatedAt, error);
  }

  if (status === 'cancelled' && persisted.state !== 'cancelled') {
    return deriveLlmStatusFromWorkState(status, updatedAt, error);
  }

  return persisted;
}

function createAuthSession(providerId: string): AuthSession {
  return {
    id: randomUUID(),
    providerId,
    state: 'running',
    createdAt: now(),
    updatedAt: now(),
  };
}

function createGithubAuthManager(): ProviderAuthManager {
  return new ProviderAuthManager({
    authFilePath: join(homedir(), '.orchestrace', 'github-auth.json'),
  });
}

async function startGithubDeviceAuthSession(params: {
  clientId: string;
  scopes: string[];
}): Promise<GithubDeviceAuthSession> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    scope: params.scopes.join(' '),
  });

  const response = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const payload = await readJsonLikeResponse(response);
  if (!isRecord(payload)) {
    throw new Error('Invalid GitHub device auth response.');
  }

  if (!response.ok) {
    throw new Error(formatGithubOAuthError(payload));
  }

  const deviceCode = asString(payload.device_code);
  const userCode = asString(payload.user_code);
  const verificationUri = asString(payload.verification_uri);
  const verificationUriComplete = asString(payload.verification_uri_complete);
  const expiresIn = asPositiveInt(payload.expires_in) ?? 900;
  const intervalSeconds = asPositiveInt(payload.interval) ?? 5;

  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error('GitHub device auth response is missing required fields.');
  }

  const createdAt = now();
  const expiresAt = new Date(Date.now() + (expiresIn * 1000)).toISOString();
  return {
    id: randomUUID(),
    state: 'awaiting-user',
    clientId: params.clientId,
    scopes: [...params.scopes],
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    intervalSeconds,
    expiresAt,
    createdAt,
    updatedAt: createdAt,
  };
}

async function pollGithubDeviceAuthSession(params: {
  session: GithubDeviceAuthSession;
  githubAuthManager: ProviderAuthManager;
  sessions: Map<string, GithubDeviceAuthSession>;
}): Promise<void> {
  const { session, githubAuthManager, sessions } = params;
  const deadline = Date.parse(session.expiresAt);
  let intervalMs = Math.max(2, session.intervalSeconds) * 1000;

  session.state = 'polling';
  session.updatedAt = now();

  while (Date.now() < deadline) {
    await waitMs(intervalMs);

    const activeSession = sessions.get(session.id);
    if (!activeSession) {
      return;
    }

    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: activeSession.clientId,
        device_code: activeSession.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const payload = await readJsonLikeResponse(response);
    if (!isRecord(payload)) {
      activeSession.state = 'failed';
      activeSession.error = 'Invalid GitHub token response payload.';
      activeSession.updatedAt = now();
      return;
    }

    const accessToken = asString(payload.access_token);
    if (response.ok && accessToken) {
      await githubAuthManager.configureApiKey(GITHUB_PROVIDER_ID, accessToken);
      activeSession.state = 'completed';
      activeSession.updatedAt = now();
      return;
    }

    const oauthError = asString(payload.error);
    if (oauthError === 'authorization_pending') {
      activeSession.updatedAt = now();
      continue;
    }

    if (oauthError === 'slow_down') {
      intervalMs += 5000;
      activeSession.updatedAt = now();
      continue;
    }

    activeSession.state = 'failed';
    activeSession.error = formatGithubOAuthError(payload);
    activeSession.updatedAt = now();
    return;
  }

  const activeSession = sessions.get(session.id);
  if (activeSession && activeSession.state !== 'completed') {
    activeSession.state = 'failed';
    activeSession.error = 'GitHub device login timed out before authorization completed.';
    activeSession.updatedAt = now();
  }
}

async function readJsonLikeResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function serializeGithubDeviceAuthSession(session: GithubDeviceAuthSession): Record<string, unknown> {
  return {
    id: session.id,
    state: session.state,
    userCode: session.userCode,
    verificationUri: session.verificationUri,
    verificationUriComplete: session.verificationUriComplete,
    scopes: [...session.scopes],
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    error: session.error,
  };
}

function formatGithubOAuthError(payload: Record<string, unknown>): string {
  const error = asString(payload.error) ?? 'unknown_error';
  const description = asString(payload.error_description);
  return description ? `${error}: ${description}` : error;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function resolveAppAuthConfig(): AppAuthConfig {
  const googleClientId = asString(process.env.ORCHESTRACE_GOOGLE_CLIENT_ID)?.trim() ?? '';
  const jwtSecret = asString(process.env.ORCHESTRACE_APP_JWT_SECRET)?.trim() ?? '';
  const tokenTtlSeconds = parsePositiveSetting(process.env.ORCHESTRACE_APP_JWT_TTL_SECONDS) ?? 60 * 60 * 8;
  const enabled = Boolean(googleClientId && jwtSecret);

  return {
    enabled,
    googleClientId,
    jwtSecret,
    tokenTtlSeconds,
  };
}

function base64UrlEncode(input: string | Buffer): string {
  const source = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input;
  return source.toString('base64url');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf-8');
}

function signJwtToken(payload: AppAuthJwtPayload, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerSegment = base64UrlEncode(JSON.stringify(header));
  const payloadSegment = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

function verifyJwtToken(token: string, secret: string): AppAuthJwtPayload | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return undefined;
  }

  const [headerSegment, payloadSegment, signatureSegment] = parts;
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const expectedSignature = createHmac('sha256', secret).update(signingInput).digest();
  const actualSignature = Buffer.from(signatureSegment, 'base64url');

  if (expectedSignature.length !== actualSignature.length) {
    return undefined;
  }

  if (!timingSafeEqual(expectedSignature, actualSignature)) {
    return undefined;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(payloadSegment));
  } catch {
    return undefined;
  }

  if (!isRecord(payload)) {
    return undefined;
  }

  const sub = asString(payload.sub)?.trim();
  const email = asString(payload.email)?.trim();
  const name = asString(payload.name)?.trim();
  const picture = asString(payload.picture)?.trim();
  const iat = typeof payload.iat === 'number' ? payload.iat : Number.NaN;
  const exp = typeof payload.exp === 'number' ? payload.exp : Number.NaN;

  if (!sub || !email || !Number.isFinite(iat) || !Number.isFinite(exp)) {
    return undefined;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (exp <= nowSeconds) {
    return undefined;
  }

  return {
    sub,
    email,
    ...(name ? { name } : {}),
    ...(picture ? { picture } : {}),
    iat,
    exp,
  };
}

async function verifyGoogleIdToken(params: { idToken: string; expectedAudience: string }): Promise<{
  email: string;
  name?: string;
  picture?: string;
}> {
  const response = await fetch(`${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(params.idToken)}`);
  if (!response.ok) {
    throw new Error(`Google token verification failed (${response.status}).`);
  }

  const payload = await readJsonLikeResponse(response);
  if (!isRecord(payload)) {
    throw new Error('Google token verification returned an invalid payload.');
  }

  const audience = asString(payload.aud)?.trim();
  if (!audience || audience !== params.expectedAudience) {
    throw new Error('Google token audience mismatch.');
  }

  const email = asString(payload.email)?.trim();
  const emailVerified = asString(payload.email_verified)?.trim();
  if (!email || emailVerified !== 'true') {
    throw new Error('Google account email is missing or unverified.');
  }

  const expSecondsRaw = asString(payload.exp)?.trim();
  const expSeconds = expSecondsRaw ? Number.parseInt(expSecondsRaw, 10) : Number.NaN;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(expSeconds) || expSeconds <= nowSeconds) {
    throw new Error('Google token is expired.');
  }

  const name = asString(payload.name)?.trim();
  const picture = asString(payload.picture)?.trim();

  return {
    email,
    ...(name ? { name } : {}),
    ...(picture ? { picture } : {}),
  };
}


async function waitMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function resolveGithubAuthStatus(authManager: ProviderAuthManager): Promise<Record<string, unknown>> {
  const status = await authManager.getStatus(GITHUB_PROVIDER_ID);
  const token = await authManager.resolveApiKey(GITHUB_PROVIDER_ID);
  const tokenTtl = status.tokenTtl;
  const authWarning = tokenTtl?.isNearExpiry
    ? `GitHub Copilot token expires in ${Math.max(0, tokenTtl.expiresInSeconds ?? 0)}s. Re-authentication may be needed soon.`
    : undefined;

  if (!token) {
    return {
      connected: false,
      source: status.source,
      storedApiKeyConfigured: status.storedApiKeyConfigured,
      scopes: [],
      tokenTtl,
      warning: authWarning,
    };
  }

  try {
    const profile = await runGithubApiRequest({ token, path: '/user', method: 'GET' });
    const data = profile.data;
    const login = isRecord(data) && typeof data.login === 'string' ? data.login : undefined;
    const name = isRecord(data) && typeof data.name === 'string' ? data.name : undefined;
    const scopes = parseGithubScopes(asString(profile.scopes.oauth));
    const profileError = profile.ok ? undefined : toGithubProfileError(profile.data);

    return {
      connected: profile.ok,
      source: status.source,
      storedApiKeyConfigured: status.storedApiKeyConfigured,
      login,
      name,
      scopes,
      tokenTtl,
      warning: authWarning,
      rateLimit: profile.rateLimit,
      lastStatusCode: profile.status,
      error: profileError,
    };
  } catch (error) {
    return {
      connected: false,
      source: status.source,
      storedApiKeyConfigured: status.storedApiKeyConfigured,
      scopes: [],
      tokenTtl,
      warning: authWarning,
      error: toErrorMessage(error),
    };
  }
}

function toGithubProfileError(data: unknown): string {
  if (isRecord(data)) {
    const message = asString(data.message);
    const documentationUrl = asString(data.documentation_url);
    if (message && documentationUrl) {
      return `${message} (${documentationUrl})`;
    }

    if (message) {
      return message;
    }
  }

  return toErrorMessage(data);
}

async function runGithubApiRequest(params: {
  token: string;
  method?: string;
  path?: string;
  body?: unknown;
  graphqlQuery?: string;
  graphqlVariables?: unknown;
  signal?: AbortSignal;
}): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  data: unknown;
  rateLimit: {
    limit?: string;
    remaining?: string;
    reset?: string;
    resource?: string;
  };
  scopes: {
    oauth?: string;
    accepted?: string;
  };
}> {
  const method = toGithubApiMethod(params.method);
  const graphqlQuery = asString(params.graphqlQuery);
  const path = asString(params.path);
  const isGraphql = Boolean(graphqlQuery);
  const url = isGraphql
    ? `${GITHUB_API_BASE_URL}/graphql`
    : `${GITHUB_API_BASE_URL}${normalizeGithubApiPath(path ?? '')}`;

  if (!isGraphql && (method === 'GET' || method === 'HEAD') && params.body !== undefined) {
    throw new Error(`HTTP ${method} request must not include body.`);
  }

  const payload = isGraphql
    ? {
        query: graphqlQuery,
        ...(params.graphqlVariables !== undefined ? { variables: params.graphqlVariables } : {}),
      }
    : params.body;

  const response = await fetch(url, {
    method: isGraphql ? 'POST' : method,
    headers: {
      Authorization: `token ${params.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
    signal: params.signal,
  });

  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  let data: unknown = text;
  if (contentType.includes('application/json') && text.trim().length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    data,
    rateLimit: {
      limit: response.headers.get('x-ratelimit-limit') ?? undefined,
      remaining: response.headers.get('x-ratelimit-remaining') ?? undefined,
      reset: response.headers.get('x-ratelimit-reset') ?? undefined,
      resource: response.headers.get('x-ratelimit-resource') ?? undefined,
    },
    scopes: {
      oauth: response.headers.get('x-oauth-scopes') ?? undefined,
      accepted: response.headers.get('x-accepted-oauth-scopes') ?? undefined,
    },
  };
}

function toGithubApiMethod(value: string | undefined): string {
  const normalized = (value ?? 'GET').trim().toUpperCase();
  if (!normalized) {
    return 'GET';
  }

  const allowed = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
  if (!allowed.has(normalized)) {
    throw new Error(`Unsupported GitHub API method: ${normalized}`);
  }

  return normalized;
}

function normalizeGithubApiPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error('Missing GitHub REST path.');
  }

  if (trimmed.startsWith('https://api.github.com/')) {
    return `/${trimmed.slice('https://api.github.com/'.length)}`;
  }

  if (!trimmed.startsWith('/')) {
    return `/${trimmed}`;
  }

  return trimmed;
}

function parseGithubScopes(scopes: string | undefined): string[] {
  if (!scopes) {
    return [];
  }

  return scopes
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function resolveDefaultModelFromEnv(): string | undefined {
  const value = asString(process.env.ORCHESTRACE_DEFAULT_MODEL)?.trim();
  return value || undefined;
}

function listProviderModelIds(provider: string): string[] {
  return getModels(provider as never)
    .map((model) => asString(model.id)?.trim())
    .filter((modelId): modelId is string => Boolean(modelId));
}

function resolveWorkStartModel(params: {
  provider: string;
  requestedModel?: string;
  envFallbackModel?: string;
}): WorkStartModelResolutionResult {
  const provider = params.provider;
  const requestedModel = asString(params.requestedModel)?.trim();
  const envFallbackModel = asString(params.envFallbackModel)?.trim();

  let availableModels: string[];
  try {
    availableModels = listProviderModelIds(provider);
  } catch (error) {
    if (requestedModel) {
      return { ok: true, model: requestedModel };
    }

    if (envFallbackModel) {
      console.warn(
        `[ui-server] /api/work/start model discovery failed for provider "${provider}"; falling back to ORCHESTRACE_DEFAULT_MODEL="${envFallbackModel}". Error: ${toErrorMessage(error)}`,
      );
      return { ok: true, model: envFallbackModel };
    }

    return {
      ok: false,
      statusCode: 502,
      code: 'MODEL_LIST_FETCH_FAILED',
      error: `Failed to load models for provider ${provider}.`,
      details: {
        provider,
        requestedModel: null,
        reason: 'provider_model_fetch_failed',
        retryable: true,
        cause: toErrorMessage(error),
      },
    };
  }

  if (requestedModel) {
    if (availableModels.includes(requestedModel)) {
      return { ok: true, model: requestedModel };
    }

    return {
      ok: false,
      statusCode: 400,
      code: 'MODEL_NOT_FOUND',
      error: `Requested model "${requestedModel}" is not available for provider ${provider}.`,
      details: {
        provider,
        requestedModel,
        availableModels,
      },
    };
  }

  const firstAvailableModel = availableModels[0];
  if (firstAvailableModel) {
    return { ok: true, model: firstAvailableModel };
  }

  if (envFallbackModel) {
    console.warn(
      `[ui-server] /api/work/start no models available for provider "${provider}"; falling back to ORCHESTRACE_DEFAULT_MODEL="${envFallbackModel}".`,
    );
    return { ok: true, model: envFallbackModel };
  }

  return {
    ok: false,
    statusCode: 400,
    code: 'MODEL_UNAVAILABLE',
    error: `No models are available for provider ${provider}, and no model was specified.`,
    details: {
      provider,
      requestedModel: null,
      availableModels,
      reason: 'no_model_available',
      retryable: false,
    },
  };
}

function parseBooleanSetting(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return undefined;
}

function parsePositiveSetting(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : undefined;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function normalizePositiveSetting(value: unknown, fallback: number): number {
  return parsePositiveSetting(value) ?? fallback;
}

function resolveLongTurnTimeoutMs(): number {
  return resolveConfiguredTimeoutMs(
    ['ORCHESTRACE_LLM_LONG_TURN_TIMEOUT_MS', 'ORCHESTRACE_LLM_TIMEOUT_MS'],
    600_000,
  );
}

function resolveSubAgentTimeoutMs(): number {
  return resolveConfiguredTimeoutMs(
    ['ORCHESTRACE_SUBAGENT_TIMEOUT_MS', 'ORCHESTRACE_LLM_DELEGATION_TIMEOUT_MS', 'ORCHESTRACE_LLM_LONG_TURN_TIMEOUT_MS'],
    300_000,
  );
}

function resolveConfiguredTimeoutMs(keys: string[], fallbackMs: number): number {
  for (const key of keys) {
    const raw = process.env[key];
    const parsed = parsePositiveInt(raw);
    if (parsed) {
      return parsed;
    }
  }

  return fallbackMs;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function normalizeSessionCreationReason(raw: unknown): SessionCreationReason {
  const value = asString(raw).trim().toLowerCase();
  if (value === 'retry') {
    return 'retry';
  }

  return 'start';
}

function normalizeSessionDeliveryStrategy(raw: unknown): SessionDeliveryStrategy {
  const value = asString(raw).trim().toLowerCase();
  if (value === 'merge-after-ci') {
    return 'merge-after-ci';
  }

  return 'pr-only';
}

const AGENT_MODEL_ROLES = ['router', 'planner', 'implementer', 'reviewer', 'investigator'] as const;

type AgentModelRole = (typeof AGENT_MODEL_ROLES)[number];

function normalizeReasoningLevel(value: unknown): 'minimal' | 'low' | 'medium' | 'high' | undefined {
  const normalized = asString(value).trim().toLowerCase();
  if (normalized === 'minimal' || normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }

  return undefined;
}

function normalizeAgentModelConfig(value: unknown): { provider?: string; model?: string; reasoning?: 'minimal' | 'low' | 'medium' | 'high' } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const provider = asString(value.provider).trim();
  const model = asString(value.model).trim();
  const reasoning = normalizeReasoningLevel(value.reasoning);
  if (!provider && !model && !reasoning) {
    return undefined;
  }

  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

function mergeAgentModelConfig(
  value: unknown,
  fallback?: { provider?: string; model?: string; reasoning?: 'minimal' | 'low' | 'medium' | 'high' },
): { provider?: string; model?: string; reasoning?: 'minimal' | 'low' | 'medium' | 'high' } | undefined {
  const normalized = normalizeAgentModelConfig(value);
  const provider = normalized?.provider ?? fallback?.provider;
  const model = normalized?.model ?? fallback?.model;
  const reasoning = normalized?.reasoning ?? fallback?.reasoning;
  if (!provider && !model && !reasoning) {
    return undefined;
  }

  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

function normalizeSessionAgentModels(
  value: unknown,
  fallback: SessionAgentModels = {},
): SessionAgentModels {
  const source = isRecord(value) ? value : {};
  const normalized: SessionAgentModels = {};
  for (const role of AGENT_MODEL_ROLES) {
    const merged = mergeAgentModelConfig(source[role], fallback[role]);
    if (merged) {
      normalized[role] = merged;
    }
  }

  return normalized;
}

function resolveSessionAgentModels(params: {
  provider: string;
  model: string;
  planningProvider?: string;
  planningModel?: string;
  implementationProvider?: string;
  implementationModel?: string;
  agentModels?: SessionAgentModels;
}): {
  agentModels: SessionAgentModels;
  planningProvider: string;
  planningModel: string;
  implementationProvider: string;
  implementationModel: string;
} {
  const implementationProvider = asString(params.implementationProvider).trim() || asString(params.provider).trim();
  const implementationModel = asString(params.implementationModel).trim() || asString(params.model).trim();
  const planningProvider = asString(params.planningProvider).trim() || implementationProvider;
  const planningModel = asString(params.planningModel).trim() || implementationModel;

  const normalizedAgentModels = normalizeSessionAgentModels(params.agentModels, {
    planner: {
      provider: planningProvider,
      model: planningModel,
    },
    implementer: {
      provider: implementationProvider,
      model: implementationModel,
    },
  });

  const resolvedPlanningProvider = asString(normalizedAgentModels.planner?.provider).trim() || planningProvider;
  const resolvedPlanningModel = asString(normalizedAgentModels.planner?.model).trim() || planningModel;
  const resolvedImplementationProvider = asString(normalizedAgentModels.implementer?.provider).trim() || implementationProvider;
  const resolvedImplementationModel = asString(normalizedAgentModels.implementer?.model).trim() || implementationModel;

  return {
    agentModels: {
      ...normalizedAgentModels,
      planner: {
        ...normalizedAgentModels.planner,
        provider: resolvedPlanningProvider,
        model: resolvedPlanningModel,
      },
      implementer: {
        ...normalizedAgentModels.implementer,
        provider: resolvedImplementationProvider,
        model: resolvedImplementationModel,
      },
    },
    planningProvider: resolvedPlanningProvider,
    planningModel: resolvedPlanningModel,
    implementationProvider: resolvedImplementationProvider,
    implementationModel: resolvedImplementationModel,
  };
}

function resolveUiPreferencesDefaults(): UiPreferences {
  const batchConcurrency = resolveBatchConcurrencyDefault();
  const batchMinConcurrency = Math.min(batchConcurrency, resolveBatchMinConcurrencyDefault());
  const defaultProvider = resolveDefaultProviderPreferenceDefault();
  const defaultModel = resolveDefaultModelPreferenceDefault();
  const defaultPlanningProvider = resolveDefaultPlanningProviderPreferenceDefault(defaultProvider);
  const defaultPlanningModel = resolveDefaultPlanningModelPreferenceDefault(defaultModel);
  const defaultImplementationProvider = resolveDefaultImplementationProviderPreferenceDefault(defaultProvider);
  const defaultImplementationModel = resolveDefaultImplementationModelPreferenceDefault(defaultModel);
  const defaultRouterProvider = resolveDefaultRouterProviderPreferenceDefault(defaultImplementationProvider);
  const defaultRouterModel = resolveDefaultRouterModelPreferenceDefault(defaultImplementationModel);
  const defaultReviewerProvider = resolveDefaultReviewerProviderPreferenceDefault(defaultImplementationProvider);
  const defaultReviewerModel = resolveDefaultReviewerModelPreferenceDefault(defaultImplementationModel);
  const defaultInvestigatorProvider = resolveDefaultInvestigatorProviderPreferenceDefault(defaultImplementationProvider);
  const defaultInvestigatorModel = resolveDefaultInvestigatorModelPreferenceDefault(defaultImplementationModel);
  const defaultDeliveryStrategy = resolveDefaultDeliveryStrategyPreferenceDefault();
  const planningNoToolGuardMode = resolvePlanningNoToolGuardModeDefault();
  const executionContext: UiPreferences['executionContext'] = 'workspace';
  const useWorktree = false;
  const defaultAgentModels = normalizeSessionAgentModels({
    router: {
      provider: defaultRouterProvider,
      model: defaultRouterModel,
    },
    planner: {
      provider: defaultPlanningProvider,
      model: defaultPlanningModel,
    },
    implementer: {
      provider: defaultImplementationProvider,
      model: defaultImplementationModel,
    },
    reviewer: {
      provider: defaultReviewerProvider,
      model: defaultReviewerModel,
    },
    investigator: {
      provider: defaultInvestigatorProvider,
      model: defaultInvestigatorModel,
    },
  });
  return {
    activeTab: resolveUiTabDefault(),
    observerShowFindings: resolveObserverShowFindingsDefault(),
    defaultProvider: defaultImplementationProvider,
    defaultModel: defaultImplementationModel,
    defaultAgentModels,
    defaultPlanningProvider,
    defaultPlanningModel,
    defaultImplementationProvider,
    defaultImplementationModel,
    defaultDeliveryStrategy,
    planningNoToolGuardMode,
    executionContext,
    useWorktree,
    adaptiveConcurrency: resolveAdaptiveConcurrencyDefault(),
    batchConcurrency,
    batchMinConcurrency,
    enableTrivialTaskGate: resolveTrivialTaskGateDefault(),
    trivialTaskMaxPromptLength: resolveTrivialTaskMaxPromptLengthDefault(),
  };
}

function normalizeUiPreferences(value: unknown, fallback: UiPreferences): UiPreferences {
  if (!isRecord(value)) {
    return { ...fallback };
  }

  const batchConcurrency = normalizePositiveSetting(value.batchConcurrency, fallback.batchConcurrency);
  const batchMinConcurrency = Math.min(
    batchConcurrency,
    normalizePositiveSetting(value.batchMinConcurrency, fallback.batchMinConcurrency),
  );
  const legacyDefaultProvider = normalizeStringPreference(value.defaultProvider, fallback.defaultProvider);
  const legacyDefaultModel = normalizeStringPreference(value.defaultModel, fallback.defaultModel);
  const defaultPlanningProvider = normalizeStringPreference(
    value.defaultPlanningProvider,
    legacyDefaultProvider || fallback.defaultPlanningProvider,
  );
  const defaultPlanningModel = normalizeStringPreference(
    value.defaultPlanningModel,
    legacyDefaultModel || fallback.defaultPlanningModel,
  );
  const defaultImplementationProvider = normalizeStringPreference(
    value.defaultImplementationProvider,
    legacyDefaultProvider || fallback.defaultImplementationProvider,
  );
  const defaultImplementationModel = normalizeStringPreference(
    value.defaultImplementationModel,
    legacyDefaultModel || fallback.defaultImplementationModel,
  );
  const defaultAgentModels = normalizeSessionAgentModels(value.defaultAgentModels, fallback.defaultAgentModels);
  const resolvedPlanningProvider = asString(defaultAgentModels.planner?.provider).trim() || defaultPlanningProvider;
  const resolvedPlanningModel = asString(defaultAgentModels.planner?.model).trim() || defaultPlanningModel;
  const resolvedImplementationProvider = asString(defaultAgentModels.implementer?.provider).trim() || defaultImplementationProvider;
  const resolvedImplementationModel = asString(defaultAgentModels.implementer?.model).trim() || defaultImplementationModel;
  const defaultDeliveryStrategy = normalizeSessionDeliveryStrategy(
    value.defaultDeliveryStrategy ?? value.deliveryStrategy,
  );
  const planningNoToolGuardMode = normalizePlanningNoToolGuardMode(value.planningNoToolGuardMode)
    ?? (parseBooleanSetting(value.planningNoToolWarnOnly) ? 'warn' : undefined)
    ?? fallback.planningNoToolGuardMode;
  const executionContext = value.executionContext === 'git-worktree' || value.executionContext === 'workspace'
    ? value.executionContext
    : fallback.executionContext;
  const useWorktree = parseBooleanSetting(value.useWorktree)
    ?? (executionContext === 'git-worktree');

  return {
    activeTab: normalizeUiTab(value.activeTab) ?? fallback.activeTab,
    observerShowFindings: parseBooleanSetting(value.observerShowFindings) ?? fallback.observerShowFindings,
    defaultProvider: resolvedImplementationProvider,
    defaultModel: resolvedImplementationModel,
    defaultAgentModels: {
      ...defaultAgentModels,
      planner: {
        ...defaultAgentModels.planner,
        provider: resolvedPlanningProvider,
        model: resolvedPlanningModel,
      },
      implementer: {
        ...defaultAgentModels.implementer,
        provider: resolvedImplementationProvider,
        model: resolvedImplementationModel,
      },
    },
    defaultPlanningProvider: resolvedPlanningProvider,
    defaultPlanningModel: resolvedPlanningModel,
    defaultImplementationProvider: resolvedImplementationProvider,
    defaultImplementationModel: resolvedImplementationModel,
    defaultDeliveryStrategy,
    planningNoToolGuardMode,
    executionContext,
    useWorktree,
    adaptiveConcurrency: parseBooleanSetting(value.adaptiveConcurrency) ?? fallback.adaptiveConcurrency,
    batchConcurrency,
    batchMinConcurrency,
    enableTrivialTaskGate: parseBooleanSetting(value.enableTrivialTaskGate) ?? fallback.enableTrivialTaskGate,
    trivialTaskMaxPromptLength: normalizePositiveSetting(
      value.trivialTaskMaxPromptLength,
      fallback.trivialTaskMaxPromptLength,
    ),
  };
}

function resolveUiTabDefault(): 'graph' | 'settings' {
  return normalizeUiTab(process.env.ORCHESTRACE_UI_ACTIVE_TAB) ?? 'graph';
}

function resolveObserverShowFindingsDefault(): boolean {
  return parseBooleanSetting(process.env.ORCHESTRACE_UI_OBSERVER_SHOW_FINDINGS) ?? false;
}

function resolveDefaultProviderPreferenceDefault(): string {
  return asString(process.env.ORCHESTRACE_UI_DEFAULT_PROVIDER) || '';
}

function resolveDefaultModelPreferenceDefault(): string {
  return asString(process.env.ORCHESTRACE_UI_DEFAULT_MODEL) || '';
}

function resolveDefaultPlanningProviderPreferenceDefault(fallback: string): string {
  return asString(process.env.ORCHESTRACE_UI_DEFAULT_PLANNING_PROVIDER) || fallback;
}

function resolveDefaultPlanningModelPreferenceDefault(fallback: string): string {
  return asString(process.env.ORCHESTRACE_UI_DEFAULT_PLANNING_MODEL) || fallback;
}

function resolveDefaultImplementationProviderPreferenceDefault(fallback: string): string {
  return asString(process.env.ORCHESTRACE_UI_DEFAULT_IMPLEMENTATION_PROVIDER) || fallback;
}

function resolveDefaultImplementationModelPreferenceDefault(fallback: string): string {
  return asString(process.env.ORCHESTRACE_UI_DEFAULT_IMPLEMENTATION_MODEL) || fallback;
}

function resolveDefaultRouterProviderPreferenceDefault(fallback: string): string {
  return asString(process.env.ORCHESTRACE_UI_DEFAULT_ROUTER_PROVIDER) || fallback;
}

function resolveDefaultRouterModelPreferenceDefault(fallback: string): string {
  return asString(process.env.ORCHESTRACE_UI_DEFAULT_ROUTER_MODEL) || fallback;
}

function resolveDefaultReviewerProviderPreferenceDefault(fallback: string): string {
  return asString(process.env.ORCHESTRACE_UI_DEFAULT_REVIEWER_PROVIDER) || fallback;
}

function resolveDefaultReviewerModelPreferenceDefault(fallback: string): string {
  return asString(process.env.ORCHESTRACE_UI_DEFAULT_REVIEWER_MODEL) || fallback;
}

function resolveDefaultInvestigatorProviderPreferenceDefault(fallback: string): string {
  return asString(process.env.ORCHESTRACE_UI_DEFAULT_INVESTIGATOR_PROVIDER) || fallback;
}

function resolveDefaultInvestigatorModelPreferenceDefault(fallback: string): string {
  return asString(process.env.ORCHESTRACE_UI_DEFAULT_INVESTIGATOR_MODEL) || fallback;
}

function resolveDefaultDeliveryStrategyPreferenceDefault(): SessionDeliveryStrategy {
  return normalizeSessionDeliveryStrategy(process.env.ORCHESTRACE_UI_DEFAULT_DELIVERY_STRATEGY);
}

function resolvePlanningNoToolGuardModeDefault(): 'enforce' | 'warn' {
  const envMode = normalizePlanningNoToolGuardMode(process.env.ORCHESTRACE_PLANNING_NO_TOOL_GUARD_MODE);
  if (envMode) {
    return envMode;
  }

  const warnOnly = parseBooleanSetting(process.env.ORCHESTRACE_PLANNING_NO_TOOL_WARN_ONLY);
  if (warnOnly === true) {
    return 'warn';
  }

  return 'enforce';
}

function normalizePlanningNoToolGuardMode(value: unknown): 'enforce' | 'warn' | undefined {
  const normalized = asString(value).toLowerCase();
  if (normalized === 'enforce' || normalized === 'warn') {
    return normalized;
  }

  return undefined;
}

function normalizeWorkspaceAssignmentSource(
  value: unknown,
): SessionWorkspaceAssignmentProvenance['assignmentSource'] | undefined {
  const normalized = asString(value).toLowerCase();
  if (
    normalized === 'workspace-root'
    || normalized === 'selected-worktree'
    || normalized === 'fallback-worktree'
    || normalized === 'auto-created-worktree'
  ) {
    return normalized;
  }

  return undefined;
}

function normalizeWorkspacePathSessionIdRelation(
  value: unknown,
): SessionWorktreePathSessionIdRelation | undefined {
  const normalized = asString(value).toLowerCase();
  if (normalized === 'match' || normalized === 'mismatch' || normalized === 'none') {
    return normalized;
  }

  return undefined;
}

function normalizeUiTab(value: unknown): 'graph' | 'settings' | undefined {
  const normalized = asString(value).toLowerCase();
  if (normalized === 'graph' || normalized === 'settings') {
    return normalized;
  }

  return undefined;
}

function normalizeStringPreference(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  return value.trim();
}

function resolveAdaptiveConcurrencyDefault(): boolean {
  const raw = process.env.ORCHESTRACE_UI_ADAPTIVE_CONCURRENCY ?? process.env.ORCHESTRACE_ADAPTIVE_CONCURRENCY;
  const parsed = parseBooleanSetting(raw);
  return parsed ?? DEFAULT_UI_ADAPTIVE_CONCURRENCY;
}

function resolveBatchConcurrencyDefault(): number {
  return parsePositiveInt(process.env.ORCHESTRACE_UI_BATCH_CONCURRENCY)
    ?? parsePositiveInt(process.env.ORCHESTRACE_BATCH_CONCURRENCY)
    ?? DEFAULT_UI_BATCH_CONCURRENCY;
}

function resolveBatchMinConcurrencyDefault(): number {
  return parsePositiveInt(process.env.ORCHESTRACE_UI_BATCH_MIN_CONCURRENCY)
    ?? parsePositiveInt(process.env.ORCHESTRACE_BATCH_MIN_CONCURRENCY)
    ?? DEFAULT_UI_BATCH_MIN_CONCURRENCY;
}

function resolveTrivialTaskGateDefault(): boolean {
  const raw = process.env.ORCHESTRACE_UI_TRIVIAL_TASK_GATE_ENABLED
    ?? process.env.ORCHESTRACE_TRIVIAL_TASK_GATE_ENABLED;
  return parseBooleanSetting(raw) ?? false;
}

function resolveTrivialTaskMaxPromptLengthDefault(): number {
  return parsePositiveInt(process.env.ORCHESTRACE_UI_TRIVIAL_TASK_MAX_PROMPT_LENGTH)
    ?? parsePositiveInt(process.env.ORCHESTRACE_TRIVIAL_TASK_MAX_PROMPT_LENGTH)
    ?? 120;
}

function normalizeLlmSessionState(raw: unknown): LlmSessionState {
  const value = asString(raw).toLowerCase();
  switch (value) {
    case 'queued':
      return 'queued';
    case 'analyzing':
      return 'analyzing';
    case 'thinking':
      return 'thinking';
    case 'planning':
      return 'planning';
    case 'awaiting_approval':
    case 'awaiting-approval':
      return 'awaiting-approval';
    case 'implementing':
      return 'implementing';
    case 'using_tools':
    case 'using-tools':
      return 'using-tools';
    case 'validating':
      return 'validating';
    case 'retrying':
      return 'retrying';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'queued';
  }
}

function normalizeAgentToolPhase(value: string): AgentToolPhase | undefined {
  if (value === 'chat' || value === 'planning' || value === 'implementation') {
    return value;
  }

  return undefined;
}

function hasImplementationGraphActivity(session: WorkSession): boolean {
  return session.agentGraph.some((node) => {
    const status = node.status ?? 'pending';
    return status === 'running' || status === 'completed' || status === 'failed';
  });
}

function resolveSessionToolMode(session: WorkSession): AgentToolPhase {
  const phase = session.llmStatus.phase;
  if (phase === 'planning' || phase === 'implementation') {
    return phase;
  }

  switch (session.llmStatus.state) {
    case 'queued':
    case 'planning':
    case 'awaiting-approval':
    case 'analyzing':
    case 'thinking':
      return 'planning';
    case 'implementing':
    case 'using-tools':
    case 'validating':
    case 'retrying':
      return 'implementation';
    case 'completed':
    case 'failed':
    case 'cancelled':
      return hasImplementationGraphActivity(session) ? 'implementation' : 'planning';
    default:
      return 'planning';
  }
}

function llmStatusLabel(state: LlmSessionState): string {
  switch (state) {
    case 'queued':
      return 'Queued';
    case 'analyzing':
      return 'Analyzing';
    case 'thinking':
      return 'Thinking';
    case 'planning':
      return 'Planning';
    case 'awaiting-approval':
      return 'Awaiting Approval';
    case 'implementing':
      return 'Implementing';
    case 'using-tools':
      return 'Using Tools';
    case 'validating':
      return 'Validating';
    case 'retrying':
      return 'Retrying';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Queued';
  }
}

function createLlmStatus(
  state: LlmSessionState,
  updatedAt: string,
  options: { detail?: string; failureType?: string; taskId?: string; phase?: 'planning' | 'implementation' } = {},
): SessionLlmStatus {
  return {
    state,
    label: llmStatusLabel(state),
    detail: asString(options.detail) || undefined,
    failureType: asString(options.failureType) || undefined,
    taskId: asString(options.taskId) || undefined,
    phase: options.phase,
    updatedAt,
  };
}

function normalizeLlmStatus(raw: SessionLlmStatus, fallbackUpdatedAt: string): SessionLlmStatus {
  const state = normalizeLlmSessionState(raw.state);
  const updatedAt = asString(raw.updatedAt) || fallbackUpdatedAt;
  const phase = raw.phase === 'planning' || raw.phase === 'implementation' ? raw.phase : undefined;

  return {
    state,
    label: llmStatusLabel(state),
    detail: asString(raw.detail) || undefined,
    failureType: asString(raw.failureType) || undefined,
    taskId: asString(raw.taskId) || undefined,
    phase,
    updatedAt,
  };
}

function deriveLlmStatusFromWorkState(status: WorkState, updatedAt: string, error?: string): SessionLlmStatus {
  if (status === 'completed') {
    return createLlmStatus('completed', updatedAt, { detail: 'Run completed successfully.' });
  }

  if (status === 'failed') {
    return createLlmStatus('failed', updatedAt, { detail: asString(error) || 'Execution failed.' });
  }

  if (status === 'cancelled') {
    return createLlmStatus('cancelled', updatedAt, { detail: 'Cancelled by user.' });
  }

  return createLlmStatus('queued', updatedAt, { detail: 'Queued for orchestration.' });
}

function toUiEvent(runId: string, event: DagEvent): UiDagEvent | undefined {
    const base = {
    time: now(),
    runId,
    type: event.type,
    taskId: 'taskId' in event ? event.taskId : undefined,
    failureType: event.type === 'task:failed' ? event.failureType : undefined,
    attempt: event.type === 'task:failed' ? event.attempt : undefined,
    maxRetries: event.type === 'task:failed' ? event.maxRetries : undefined,
    totalDurationMs: event.type === 'task:failed' ? event.totalDurationMs : undefined,
    toolName: event.type === 'task:tool-call' ? event.toolName : undefined,
    toolStatus: event.type === 'task:tool-call' ? event.status : undefined,
    toolCallId: event.type === 'task:tool-call' ? event.toolCallId : undefined,
    toolInput: event.type === 'task:tool-call' ? event.input : undefined,
    toolOutput: event.type === 'task:tool-call' ? event.output : undefined,
    toolIsError: event.type === 'task:tool-call' ? event.isError : undefined,
    toolDetails: event.type === 'task:tool-call' ? event.details : undefined,
  };


  const tagged = (message: string): string => `[run:${runId}] ${message}`;

  switch (event.type) {
    case 'task:planning':
      return { ...base, message: tagged(`${event.taskId}: planning`) };
    case 'task:plan-persisted':
      return { ...base, message: tagged(`${event.taskId}: plan persisted at ${event.path}`) };
    case 'task:approval-requested':
      return { ...base, message: tagged(`${event.taskId}: approval requested`) };
    case 'task:approved':
      return { ...base, message: tagged(`${event.taskId}: approved`) };
    case 'task:implementation-attempt':
      return { ...base, message: tagged(`${event.taskId}: implementation attempt ${event.attempt}/${event.maxAttempts}`) };
    case 'task:tool-call': {
      if (event.status === 'started') {
        return {
          ...base,
          message: tagged(
            `${event.taskId}: tool ${event.toolName} input ${previewToolLog(event.input, resolveToolPreviewLimit(event.toolName, 'input'))}`,
          ),
        };
      }

      const errorSuffix = event.isError ? ' [error]' : '';
      return {
        ...base,
        message: tagged(
          `${event.taskId}: tool ${event.toolName} output${errorSuffix} ${previewToolLog(event.output, resolveToolPreviewLimit(event.toolName, 'output'))}`,
        ),
      };
    }
    case 'task:verification-failed':
      return { ...base, message: tagged(`${event.taskId}: verification failed`) };
    case 'task:ready':
      return { ...base, message: tagged(`${event.taskId}: ready`) };
    case 'task:started':
      return { ...base, message: tagged(`${event.taskId}: started`) };
    case 'task:validating':
      return { ...base, message: tagged(`${event.taskId}: validating`) };
    case 'task:completed':
      return { ...base, message: tagged(`${event.taskId}: completed`) };
    case 'task:failed':
      return {
        ...base,
        message: tagged(
          `${event.taskId}: failed${event.failureType ? ` [${event.failureType}]` : ''} (${event.error}) attempt ${event.attempt}/${event.maxRetries + 1}, elapsed ${event.totalDurationMs}ms`,
        ),
      };
    case 'graph:completed':
      return { ...base, message: tagged(`graph completed (${event.outputs.size} outputs)`) };
    case 'graph:failed':
      return { ...base, message: tagged(`graph failed (${event.error})`) };
    case 'task:retrying':
      return { ...base, message: tagged(`${event.taskId}: retrying ${event.attempt}/${event.maxRetries}`) };
    default:
      return undefined;
  }
}

function previewToolLog(value: string | undefined, maxChars = TOOL_EVENT_PREVIEW_MAX_CHARS): string {
  return sanitizeToolPayload(value, { maxLength: maxChars });
}

function stringifyTracePayload(value: string): string {
  return JSON.stringify(value);
}

function resolveToolPreviewLimit(toolName: string, direction: 'input' | 'output'): number {
  if (toolName === 'subagent_spawn_batch') {
    return direction === 'input' ? Math.max(12_000, TOOL_EVENT_PREVIEW_MAX_CHARS) : Math.max(20_000, TOOL_EVENT_PREVIEW_MAX_CHARS);
  }

  if (toolName === 'subagent_worker') {
    return direction === 'input' ? Math.max(8_000, TOOL_EVENT_PREVIEW_MAX_CHARS) : Math.max(16_000, TOOL_EVENT_PREVIEW_MAX_CHARS);
  }

  if (toolName === 'subagent_spawn') {
    return direction === 'input' ? Math.max(4_000, TOOL_EVENT_PREVIEW_MAX_CHARS) : Math.max(12_000, TOOL_EVENT_PREVIEW_MAX_CHARS);
  }

  return TOOL_EVENT_PREVIEW_MAX_CHARS;
}

function emitSubAgentWorkerEvent(params: {
  session: WorkSession;
  uiStatePersistence: { schedule: () => void; flush: () => Promise<void> };
  persistEvent?: (sessionId: string, event: SessionEventInput) => void;
  taskId: string;
  phase: 'planning' | 'implementation';
  toolCallId: string;
  status: 'started' | 'completed' | 'failed';
  provider: string;
  model: string;
  nodeId?: string;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
  prompt: string;
  outputText?: string;
  usage?: { input: number; output: number; cost: number };
  error?: string;
}): void {
  const inputPayload = {
    nodeId: params.nodeId,
    provider: params.provider,
    model: params.model,
    reasoning: params.reasoning,
    promptChars: params.prompt.length,
    promptPreview: compactSubAgentWorkerText(params.prompt, SUBAGENT_WORKER_PROMPT_PREVIEW_MAX_CHARS),
  };

  const event: Extract<DagEvent, { type: 'task:tool-call' }> = {
    type: 'task:tool-call',
    taskId: params.taskId,
    phase: params.phase,
    attempt: 1,
    toolCallId: params.toolCallId,
    toolName: 'subagent_worker',
    status: params.status === 'started' ? 'started' : 'result',
    input: params.status === 'started' ? JSON.stringify(inputPayload) : undefined,
    output: params.status === 'started'
      ? undefined
      : JSON.stringify({
        status: params.status,
        nodeId: params.nodeId,
        provider: params.provider,
        model: params.model,
        promptChars: params.prompt.length,
        usage: params.usage ?? { input: 0, output: 0, cost: 0 },
        usageReported: Boolean(params.usage),
        outputPreview: params.outputText
          ? compactSubAgentWorkerText(params.outputText, SUBAGENT_WORKER_OUTPUT_PREVIEW_MAX_CHARS)
          : undefined,
        error: params.error,
      }),
    isError: params.status === 'failed',
  };

  const uiEvent = toUiEvent(params.session.id, event);
  if (uiEvent) {
    params.session.events.push(uiEvent);
    if (params.session.events.length > SESSION_EVENT_HISTORY_LIMIT) {
      params.session.events.shift();
    }
  }

  // Dual-write: persist sub-agent worker events to event store for auditability
  if (uiEvent && params.persistEvent) {
    params.persistEvent(params.session.id, {
      time: uiEvent.time,
      type: 'session:dag-event',
      payload: { event: uiEvent },
    });
  }

  params.session.updatedAt = now();
  if (params.status === 'started') {
    params.session.llmStatus = createLlmStatus('using-tools', params.session.updatedAt, {
      detail: params.nodeId ? `Running sub-agent ${params.nodeId}.` : 'Running sub-agent.',
      taskId: params.taskId,
      phase: params.phase,
    });
  } else {
    const detail = params.status === 'failed'
      ? (params.nodeId ? `Sub-agent ${params.nodeId} failed.` : 'Sub-agent failed.')
      : (params.nodeId ? `Sub-agent ${params.nodeId} completed.` : 'Sub-agent completed.');
    params.session.llmStatus = createLlmStatus('using-tools', params.session.updatedAt, {
      detail,
      taskId: params.taskId,
      phase: params.phase,
    });
  }
  params.uiStatePersistence.schedule();

  // Update agent graph node status directly (bypasses truncated DagEvent output)
  if (params.nodeId && params.session.agentGraph.length > 0) {
    const graphStatus: 'running' | 'completed' | 'failed' | undefined =
      params.status === 'started' ? 'running' :
        params.status === 'completed' ? 'completed' :
          params.status === 'failed' ? 'failed' : undefined;
    if (graphStatus) {
      setAgentGraphNodeStatus(params.session, [params.nodeId], graphStatus);
      // Dual-write: persist graph node status changes
      if (params.persistEvent) {
        params.persistEvent(params.session.id, {
          time: now(),
          type: 'session:agent-graph-set',
          payload: { graph: params.session.agentGraph },
        });
      }
    }
  }

  // Dual-write: persist llm-status changes during sub-agent execution
  if (params.persistEvent) {
    params.persistEvent(params.session.id, {
      time: params.session.updatedAt,
      type: 'session:llm-status-change',
      payload: { llmStatus: params.session.llmStatus },
    });
  }
}

function compactSubAgentWorkerText(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '(empty)';
  }

  if (compact.length <= maxChars) {
    return compact;
  }

  return `${compact.slice(0, maxChars - 3)}...`;
}

function handleChatToolCallEvent(
  session: WorkSession,
  toolEvent: LlmToolCallEvent,
  sessionTodos: Map<string, AgentTodoItem[]>,
  pendingSubagentNodeIdsBySession: Map<string, Map<string, string[]>>,
  workStreamClients: Map<string, Set<ServerResponse>>,
  uiStatePersistence: { schedule: () => void; flush: () => Promise<void> },
  persistEvent: (sessionId: string, event: SessionEventInput) => void,
): void {
  const event = toChatToolDagEvent(toolEvent);
  const direction = event.status === 'started' ? 'input' : 'output';
  const payload = event.status === 'started' ? event.input : event.output;
  const errorSuffix = event.isError ? ' [error]' : '';
  console.info(
    `[trace:${session.id}] tool task=${event.taskId} name=${event.toolName} direction=${direction}${errorSuffix} payload=${stringifyTracePayload(payload ?? '')}`,
  );

  const uiEvent = toUiEvent(session.id, event);
  if (uiEvent) {
    session.events.push(uiEvent);
    if (session.events.length > SESSION_EVENT_HISTORY_LIMIT) {
      session.events.shift();
    }
  }

  // Dual-write: persist chat tool calls to event store for auditability
  if (uiEvent) {
    persistEvent(session.id, {
      time: uiEvent.time,
      type: 'session:dag-event',
      payload: { event: uiEvent },
    });
  }

  let checklistChanged = false;
  let graphChanged = false;
  if (event.status === 'started') {
    checklistChanged = applyChecklistFromToolEvent(session.id, event, sessionTodos);
    if (checklistChanged) {
      broadcastTodoUpdate(workStreamClients, session.id, sessionTodos.get(session.id) ?? []);
      // Dual-write: persist todo state for chat tool calls
      persistEvent(session.id, {
        time: now(),
        type: 'session:todos-set',
        payload: { items: sessionTodos.get(session.id) ?? [] },
      });
    }

    graphChanged = applyAgentGraphFromToolEvent(session, event) || graphChanged;
  }

  const graphProgressChanged = applyAgentGraphProgressFromToolEvent(
    session,
    event,
    pendingSubagentNodeIdsBySession,
  );

  if (graphChanged || graphProgressChanged) {
    // Dual-write: persist agent graph state for chat tool calls
    persistEvent(session.id, {
      time: now(),
      type: 'session:agent-graph-set',
      payload: { graph: session.agentGraph },
    });
  }

  if (uiEvent || checklistChanged || graphChanged) {
    session.updatedAt = now();
    uiStatePersistence.schedule();
  }

  if (graphProgressChanged) {
    session.updatedAt = now();
    uiStatePersistence.schedule();
  }
}

function toChatToolDagEvent(toolEvent: LlmToolCallEvent): Extract<DagEvent, { type: 'task:tool-call' }> {
  return {
    type: 'task:tool-call',
    taskId: 'chat',
    phase: 'implementation',
    attempt: 1,
    toolCallId: toolEvent.toolCallId,
    toolName: toolEvent.toolName,
    status: toolEvent.type,
    input: toolEvent.arguments,
    output: toolEvent.result,
    isError: toolEvent.isError,
  };
}

function applyChecklistFromToolEvent(
  sessionId: string,
  event: Extract<DagEvent, { type: 'task:tool-call' }>,
  sessionTodos: Map<string, AgentTodoItem[]>,
): boolean {
  if (event.status !== 'started' || !event.input) {
    return false;
  }

  const toolName = event.toolName;
  if (toolName !== 'todo_set' && toolName !== 'todo_add' && toolName !== 'todo_update') {
    return false;
  }

  const args = parseTodoToolArgs(toolName, event.input);
  if (!args) {
    return false;
  }

  return applyChecklistFromTodoArgs(sessionId, toolName, args, sessionTodos);
}

function applyChecklistFromTodoArgs(
  sessionId: string,
  toolName: 'todo_set' | 'todo_add' | 'todo_update',
  args: Record<string, unknown>,
  sessionTodos: Map<string, AgentTodoItem[]>,
): boolean {

  const existing = sessionTodos.get(sessionId) ?? [];
  const nowTime = now();

  if (toolName === 'todo_set') {
    const rawItems = Array.isArray(args.items) ? args.items : [];
    const nextItems: AgentTodoItem[] = rawItems
      .filter((item) => item && typeof item === 'object')
      .map((item) => item as Record<string, unknown>)
      .map((item) => {
        const id = asString(item.id) || randomUUID();
        const title = asString(item.title) || `Todo ${id}`;
        const status = normalizeChecklistTodoStatus(item.status) ?? 'todo';
        const weight = normalizeProgressWeight(item.weight);
        const previous = existing.find((entry) => entry.id === id);
        return {
          id,
          text: compactTodoText(title, item.details),
          done: status === 'done',
          status,
          weight,
          createdAt: previous?.createdAt ?? nowTime,
          updatedAt: nowTime,
        };
      });

    sessionTodos.set(sessionId, nextItems);
    return true;
  }

  if (toolName === 'todo_add') {
    const id = asString(args.id) || randomUUID();
    const title = asString(args.title) || `Todo ${id}`;
    const status = normalizeChecklistTodoStatus(args.status) ?? 'todo';
    const weight = normalizeProgressWeight(args.weight);
    const next = existing.filter((item) => item.id !== id);
    next.push({
      id,
      text: compactTodoText(title, args.details),
      done: status === 'done',
      status,
      weight,
      createdAt: nowTime,
      updatedAt: nowTime,
    });
    sessionTodos.set(sessionId, next);
    return true;
  }

  const id = asString(args.id);
  if (!id) {
    return false;
  }

  const index = existing.findIndex((item) => item.id === id);
  const status = normalizeChecklistTodoStatus(args.status);
  const nextWeight = args.weight === undefined ? undefined : normalizeProgressWeight(args.weight);
  const title = asString(args.title);
  const details = asString(args.details);
  const appendDetails = asString(args.appendDetails);

  if (index < 0) {
    const fallbackText = compactTodoText(title || `Todo ${id}`, details || appendDetails);
    const created: AgentTodoItem = {
      id,
      text: fallbackText,
      done: status === 'done',
      status: status ?? 'todo',
      weight: nextWeight,
      createdAt: nowTime,
      updatedAt: nowTime,
    };
    sessionTodos.set(sessionId, [...existing, created]);
    return true;
  }

  const item = existing[index];
  const nextText = compactTodoText(
    title || item.text || `Todo ${id}`,
    details || appendDetails,
  );

  const updated: AgentTodoItem = {
    ...item,
    text: nextText,
    done: status ? status === 'done' : item.done,
    status: status ?? item.status,
    weight: nextWeight === undefined ? item.weight : nextWeight,
    updatedAt: nowTime,
  };

  const next = [...existing];
  next[index] = updated;
  sessionTodos.set(sessionId, next);
  return true;
}

function normalizeChecklistTodoStatus(value: unknown): 'todo' | 'in_progress' | 'done' | undefined {
  const raw = asString(value);
  if (!raw) {
    return undefined;
  }

  const normalized = raw.toLowerCase().replace(/[-\s]+/g, '_');
  if (normalized === 'todo' || normalized === 'pending' || normalized === 'backlog' || normalized === 'open') {
    return 'todo';
  }

  if (
    normalized === 'in_progress'
    || normalized === 'inprogress'
    || normalized === 'doing'
    || normalized === 'active'
    || normalized === 'wip'
  ) {
    return 'in_progress';
  }

  if (
    normalized === 'done'
    || normalized === 'completed'
    || normalized === 'complete'
    || normalized === 'finished'
    || normalized === 'closed'
    || normalized === 'resolved'
  ) {
    return 'done';
  }

  return undefined;
}

function parseTodoToolArgs(
  toolName: 'todo_set' | 'todo_add' | 'todo_update',
  input: string,
): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to best-effort parsing for truncated previews.
  }

  const id = extractQuotedField(input, 'id');
  const status = extractQuotedField(input, 'status');
  const title = extractQuotedField(input, 'title');
  const details = extractQuotedField(input, 'details');
  const appendDetails = extractQuotedField(input, 'appendDetails');
  const weight = extractNumericField(input, 'weight');

  if (toolName === 'todo_update') {
    if (!id) {
      return undefined;
    }

    return {
      id,
      status,
      weight,
      title,
      details,
      appendDetails,
    };
  }

  if (toolName === 'todo_add') {
    if (!id) {
      return undefined;
    }

    return {
      id,
      title: title || `Todo ${id}`,
      status,
      weight,
      details,
    };
  }

  // todo_set generally requires full JSON; skip if it cannot be parsed.
  return undefined;
}

function extractQuotedField(input: string, key: string): string | undefined {
  const pattern = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`);
  const match = input.match(pattern);
  return match?.[1];
}

function extractNumericField(input: string, key: string): number | undefined {
  const pattern = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`);
  const match = input.match(pattern);
  if (!match) {
    return undefined;
  }

  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function backfillChecklistFromUiEvents(
  sessionId: string,
  events: UiDagEvent[],
  sessionTodos: Map<string, AgentTodoItem[]>,
): boolean {
  let changed = false;

  for (const entry of events) {
    const match = entry.message.match(/tool\s+(todo_set|todo_add|todo_update)\s+input\s+(.+)$/);
    if (!match) {
      continue;
    }

    const toolName = match[1] as 'todo_set' | 'todo_add' | 'todo_update';
    const args = parseTodoToolArgs(toolName, match[2]);
    if (!args) {
      continue;
    }

    const applied = applyChecklistFromTodoArgs(sessionId, toolName, args, sessionTodos);
    changed = changed || applied;
  }

  return changed;
}

function compactTodoText(title: string, details: unknown): string {
  const base = asString(title) || 'Todo';
  const suffixRaw = asString(details);
  const suffix = suffixRaw
    ? suffixRaw.replace(/\s+/g, ' ').trim()
    : '';

  const combined = suffix ? `${base} - ${suffix}` : base;
  return combined.length > 180 ? `${combined.slice(0, 177)}...` : combined;
}

function applyAgentGraphFromToolEvent(
  session: WorkSession,
  event: Extract<DagEvent, { type: 'task:tool-call' }>,
): boolean {
  if (event.status !== 'started' || !event.input || event.toolName !== 'agent_graph_set') {
    return false;
  }

  const args = parseAgentGraphToolArgs(event.input);
  if (!args) {
    return false;
  }

  const nodes = normalizeSessionAgentGraphNodes(args.nodes);
  if (nodes.length === 0) {
    return false;
  }

  const previous = JSON.stringify(session.agentGraph);
  const next = JSON.stringify(nodes);
  if (previous === next) {
    return false;
  }

  session.agentGraph = nodes.map((node) => ({ ...node, status: 'pending' }));
  return true;
}

function applyAgentGraphProgressFromToolEvent(
  session: WorkSession,
  event: Extract<DagEvent, { type: 'task:tool-call' }>,
  pendingSubagentNodeIdsBySession: Map<string, Map<string, string[]>>,
): boolean {
  if (event.toolName !== 'subagent_spawn' && event.toolName !== 'subagent_spawn_batch') {
    return false;
  }

  if (session.agentGraph.length === 0) {
    return false;
  }

  const pendingNodeIds = getPendingSubagentNodeIds(pendingSubagentNodeIdsBySession, session.id);

  if (event.status === 'started') {
    const input = parseToolInputObject(event.input);
    if (!input) {
      return false;
    }

    const nodeIds = resolveSubAgentNodeIds(session.agentGraph, event.toolName, input);
    if (nodeIds.length === 0) {
      return false;
    }

    pendingNodeIds.set(event.toolCallId, nodeIds);
    return setAgentGraphNodeStatus(session, nodeIds, 'running');
  }

  if (event.status !== 'result') {
    return false;
  }

  const nodeIds = pendingNodeIds.get(event.toolCallId) ?? [];

  if (event.toolName === 'subagent_spawn') {
    pendingNodeIds.delete(event.toolCallId);
    if (nodeIds.length === 0) {
      return false;
    }

    const terminalStatus: 'completed' | 'failed' = event.isError ? 'failed' : 'completed';
    return setAgentGraphNodeStatus(session, nodeIds, terminalStatus);
  }

  if (event.toolName === 'subagent_spawn_batch') {
    pendingNodeIds.delete(event.toolCallId);
    const statusByNode = parseBatchNodeStatuses(event.output);
    if (statusByNode.size > 0) {
      let changed = false;
      for (const [nodeId, status] of statusByNode.entries()) {
        changed = setAgentGraphNodeStatus(session, [nodeId], status) || changed;
      }
      return changed;
    }

    if (nodeIds.length > 0) {
      const terminalStatus: 'completed' | 'failed' = event.isError ? 'failed' : 'completed';
      return setAgentGraphNodeStatus(session, nodeIds, terminalStatus);
    }
  }

  return false;
}

function getPendingSubagentNodeIds(
  pendingSubagentNodeIdsBySession: Map<string, Map<string, string[]>>,
  sessionId: string,
): Map<string, string[]> {
  const existing = pendingSubagentNodeIdsBySession.get(sessionId);
  if (existing) {
    return existing;
  }

  const created = new Map<string, string[]>();
  pendingSubagentNodeIdsBySession.set(sessionId, created);
  return created;
}

function parseToolInputObject(input: string | undefined): Record<string, unknown> | undefined {
  if (!input) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function resolveSubAgentNodeIds(
  nodes: SessionAgentGraphNode[],
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  if (toolName === 'subagent_spawn') {
    const single = resolveNodeIdFromSubAgentArgs(nodes, input);
    return single ? [single] : [];
  }

  const rawAgents = Array.isArray(input.agents) ? input.agents : [];
  const resolved = rawAgents
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => resolveNodeIdFromSubAgentArgs(nodes, entry as Record<string, unknown>))
    .filter((entry): entry is string => Boolean(entry));

  return [...new Set(resolved)];
}

function resolveNodeIdFromSubAgentArgs(
  nodes: SessionAgentGraphNode[],
  args: Record<string, unknown>,
): string | undefined {
  const nodeId = asString(args.nodeId);
  if (nodeId && nodes.some((node) => node.id === nodeId)) {
    return nodeId;
  }

  const prompt = asString(args.prompt);
  if (!prompt) {
    return undefined;
  }

  const exactMatch = nodes.find((node) => node.prompt.trim() === prompt.trim());
  if (exactMatch) {
    return exactMatch.id;
  }

  const overlapMatch = nodes.find((node) => prompt.includes(node.prompt) || node.prompt.includes(prompt));
  return overlapMatch?.id;
}

function setAgentGraphNodeStatus(
  session: WorkSession,
  nodeIds: string[],
  status: 'running' | 'completed' | 'failed',
): boolean {
  let changed = false;
  const targets = new Set(nodeIds);
  session.agentGraph = session.agentGraph.map((node) => {
    if (!targets.has(node.id)) {
      return node;
    }

    if (node.status === status) {
      return node;
    }

    changed = true;
    return {
      ...node,
      status,
    };
  });

  return changed;
}

function parseBatchNodeStatuses(output: string | undefined): Map<string, 'completed' | 'failed'> {
  const statusByNode = new Map<string, 'completed' | 'failed'>();
  if (!output) {
    return statusByNode;
  }

  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const runs = Array.isArray(parsed.runs) ? parsed.runs : [];
    for (const rawRun of runs) {
      if (!rawRun || typeof rawRun !== 'object') {
        continue;
      }

      const run = rawRun as Record<string, unknown>;
      const nodeId = asString(run.nodeId);
      const status = asString(run.status);
      if (!nodeId || (status !== 'completed' && status !== 'failed')) {
        continue;
      }

      statusByNode.set(nodeId, status);
    }
  } catch {
    return statusByNode;
  }

  return statusByNode;
}

function parseAgentGraphToolArgs(input: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function normalizeSessionAgentGraphNodes(rawNodes: unknown): SessionAgentGraphNode[] {
  if (!Array.isArray(rawNodes)) {
    return [];
  }

  const nodes: SessionAgentGraphNode[] = [];
  const seen = new Set<string>();
  for (const raw of rawNodes) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }

    const node = raw as Record<string, unknown>;
    const id = asString(node.id);
    const prompt = asString(node.prompt);
    if (!id || !prompt || seen.has(id)) {
      continue;
    }

    const dependencies = Array.isArray(node.dependencies)
      ? node.dependencies.map((entry) => asString(entry)).filter((entry) => entry.length > 0 && entry !== id)
      : [];

    const reasoningRaw = asString(node.reasoning);
    const reasoning = reasoningRaw === 'minimal'
      || reasoningRaw === 'low'
      || reasoningRaw === 'medium'
      || reasoningRaw === 'high'
      ? reasoningRaw
      : undefined;

    nodes.push({
      id,
      name: asString(node.name) || undefined,
      prompt,
      weight: normalizeProgressWeight(node.weight),
      dependencies,
      status: normalizeGraphNodeStatus(node.status),
      provider: asString(node.provider) || undefined,
      model: asString(node.model) || undefined,
      reasoning,
    });

    seen.add(id);
  }

  return nodes;
}

function backfillAgentGraphFromUiEvents(session: WorkSession): boolean {
  let latestNodes: SessionAgentGraphNode[] | undefined;

  for (const entry of session.events) {
    const match = entry.message.match(/tool\s+agent_graph_set\s+input\s+(.+)$/);
    if (!match) {
      continue;
    }

    const args = parseAgentGraphToolArgs(match[1]);
    if (!args) {
      continue;
    }

    const nodes = normalizeSessionAgentGraphNodes(args.nodes);
    if (nodes.length === 0) {
      continue;
    }

    latestNodes = nodes;
  }

  if (!latestNodes || latestNodes.length === 0) {
    return false;
  }

  session.agentGraph = latestNodes;
  return true;
}

function normalizeGraphNodeStatus(value: unknown): SessionAgentGraphNode['status'] {
  const status = asString(value);
  if (status === 'pending' || status === 'running' || status === 'completed' || status === 'failed') {
    return status;
  }

  return 'pending';
}

type SessionProgressSource = 'graph+todos' | 'graph' | 'todos' | 'llm';
type SessionProgressConfidence = 'high' | 'medium' | 'low';

function normalizeProgressWeight(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.round(value * 100) / 100;
}

function clampUnit(value: number): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

function llmStateProgressFraction(state: LlmSessionState): number {
  switch (state) {
    case 'queued':
      return 0.02;
    case 'analyzing':
      return 0.12;
    case 'thinking':
      return 0.2;
    case 'planning':
      return 0.32;
    case 'awaiting-approval':
      return 0.4;
    case 'implementing':
      return 0.62;
    case 'using-tools':
      return 0.75;
    case 'validating':
      return 0.9;
    case 'retrying':
      return 0.72;
    case 'completed':
      return 1;
    case 'failed':
    case 'cancelled':
    default:
      return 0;
  }
}

function computeGraphProgressFraction(session: WorkSession): {
  fraction: number;
  total: number;
  completed: number;
  completedWeight: number;
  totalWeight: number;
  running: number;
  failed: number;
} | undefined {
  const nodes = serializeAgentGraphWithProgressInvariant(session);
  if (nodes.length === 0) {
    return undefined;
  }

  const hasExplicitWeights = nodes.every((node) => normalizeProgressWeight(node.weight) !== undefined);
  const runningScore = clampUnit(Math.max(0.25, Math.min(0.9, llmStateProgressFraction(session.llmStatus.state))));
  let score = 0;
  let completed = 0;
  let completedWeight = 0;
  let totalWeight = 0;
  let running = 0;
  let failed = 0;

  for (const node of nodes) {
    const weight = hasExplicitWeights ? (normalizeProgressWeight(node.weight) ?? 0) : 1;
    totalWeight += weight;

    const status = node.status ?? 'pending';
    if (status === 'completed') {
      score += weight;
      completed += 1;
      completedWeight += weight;
      continue;
    }

    if (status === 'running') {
      score += weight * runningScore;
      running += 1;
      continue;
    }

    if (status === 'failed') {
      failed += 1;
    }
  }

  return {
    fraction: clampUnit(score / Math.max(1, totalWeight)),
    total: nodes.length,
    completed,
    completedWeight,
    totalWeight,
    running,
    failed,
  };
}

function computeTodoProgressFraction(todos: AgentTodoItem[]): {
  fraction: number;
  total: number;
  done: number;
  inProgress: number;
  doneWeight: number;
  totalWeight: number;
} | undefined {
  if (todos.length === 0) {
    return undefined;
  }

  const hasExplicitWeights = todos.every((item) => normalizeProgressWeight(item.weight) !== undefined);
  let score = 0;
  let done = 0;
  let inProgress = 0;
  let doneWeight = 0;
  let totalWeight = 0;

  for (const item of todos) {
    const status = item.status ?? (item.done ? 'done' : 'todo');
    const weight = hasExplicitWeights ? (normalizeProgressWeight(item.weight) ?? 0) : 1;
    totalWeight += weight;

    if (status === 'done' || item.done) {
      score += weight;
      done += 1;
      doneWeight += weight;
      continue;
    }

    if (status === 'in_progress') {
      score += weight * 0.5;
      inProgress += 1;
    }
  }

  return {
    fraction: clampUnit(score / Math.max(1, totalWeight)),
    total: todos.length,
    done,
    inProgress,
    doneWeight,
    totalWeight,
  };
}

function computeSessionProgress(session: WorkSession, todos: AgentTodoItem[]): {
  percent: number;
  planningPercent: number;
  implementationPercent: number;
  weightedOverallPercent: number;
  source: SessionProgressSource;
  confidence: SessionProgressConfidence;
  weights: {
    planning: number;
    implementation: number;
    source: 'configured' | 'planning-only' | 'implementation-only' | 'fallback';
  };
  graphPercent?: number;
  todoPercent?: number;
  llmPercent?: number;
  totals: {
    todos: number;
    todosDone: number;
    todosInProgress: number;
    todoWeightTotal: number;
    todoWeightDone: number;
    nodes: number;
    nodesCompleted: number;
    nodesRunning: number;
    nodesFailed: number;
    nodeWeightTotal: number;
    nodeWeightCompleted: number;
  };
} {
  const graph = computeGraphProgressFraction(session);
  const checklist = computeTodoProgressFraction(todos);
  const llm = clampUnit(llmStateProgressFraction(session.llmStatus.state));
  const mode = resolveSessionToolMode(session);
  const isPlanningMode = mode === 'planning';
  const planningFraction = isPlanningMode ? (checklist?.fraction ?? llm) : 1;
  const implementationFraction = isPlanningMode ? 0 : (graph?.fraction ?? llm);

  let source: SessionProgressSource;
  let confidence: SessionProgressConfidence;
  let overallFraction: number;
  let planningWeight = 50;
  let implementationWeight = 50;
  let weightSource: 'configured' | 'planning-only' | 'implementation-only' | 'fallback' = 'fallback';

  if (isPlanningMode) {
    source = checklist ? 'todos' : 'llm';
    confidence = checklist ? 'medium' : 'low';
    planningWeight = 100;
    implementationWeight = 0;
    weightSource = 'planning-only';
    overallFraction = planningFraction;
  } else if (graph && checklist) {
    source = 'graph+todos';
    confidence = 'high';
    planningWeight = PHASE_PROGRESS_PLAN_WEIGHT_DEFAULT;
    implementationWeight = PHASE_PROGRESS_IMPLEMENTATION_WEIGHT_DEFAULT;
    weightSource = 'configured';
    const total = planningWeight + implementationWeight;
    overallFraction = total > 0
      ? ((planningFraction * planningWeight) + (implementationFraction * implementationWeight)) / total
      : Math.min(implementationFraction, planningFraction);
  } else if (graph) {
    source = 'graph';
    confidence = 'medium';
    planningWeight = 0;
    implementationWeight = 100;
    weightSource = 'implementation-only';
    overallFraction = implementationFraction;
  } else if (checklist) {
    source = 'llm';
    confidence = 'low';
    planningWeight = PHASE_PROGRESS_PLAN_WEIGHT_DEFAULT;
    implementationWeight = PHASE_PROGRESS_IMPLEMENTATION_WEIGHT_DEFAULT;
    weightSource = 'configured';
    overallFraction = ((planningFraction * planningWeight)
      + (implementationFraction * implementationWeight))
      / (planningWeight + implementationWeight);
  } else {
    source = 'llm';
    confidence = 'low';
    planningWeight = PHASE_PROGRESS_PLAN_WEIGHT_DEFAULT;
    implementationWeight = PHASE_PROGRESS_IMPLEMENTATION_WEIGHT_DEFAULT;
    weightSource = 'configured';
    overallFraction = ((planningFraction * planningWeight)
      + (implementationFraction * implementationWeight))
      / (planningWeight + implementationWeight);
  }

  const planningPercent = Math.floor(planningFraction * 100);
  const implementationPercent = Math.floor(implementationFraction * 100);

  if (session.status === 'completed') {
    overallFraction = 1;
  } else {
    overallFraction = Math.min(0.99, clampUnit(overallFraction));
  }

  const weightedOverallPercent = Math.floor(overallFraction * 100);

  return {
    percent: weightedOverallPercent,
    planningPercent,
    implementationPercent,
    weightedOverallPercent,
    source,
    confidence,
    weights: {
      planning: planningWeight,
      implementation: implementationWeight,
      source: weightSource,
    },
    graphPercent: graph ? Math.floor(graph.fraction * 100) : undefined,
    todoPercent: checklist ? Math.floor(checklist.fraction * 100) : undefined,
    llmPercent: source === 'llm' ? Math.floor(llm * 100) : undefined,
    totals: {
      todos: checklist?.total ?? 0,
      todosDone: checklist?.done ?? 0,
      todosInProgress: checklist?.inProgress ?? 0,
      todoWeightTotal: checklist?.totalWeight ?? 0,
      todoWeightDone: checklist?.doneWeight ?? 0,
      nodes: graph?.total ?? 0,
      nodesCompleted: graph?.completed ?? 0,
      nodesRunning: graph?.running ?? 0,
      nodesFailed: graph?.failed ?? 0,
      nodeWeightTotal: graph?.totalWeight ?? 0,
      nodeWeightCompleted: graph?.completedWeight ?? 0,
    },
  };
}

function serializeWorkSession(session: WorkSession, todos: AgentTodoItem[] = []): Record<string, unknown> {
  const serializedAgentGraph = serializeAgentGraphWithProgressInvariant(session);
  const progress = computeSessionProgress(session, todos);
  const resolvedAgentModels = resolveSessionAgentModels({
    provider: session.provider,
    model: session.model,
    planningProvider: session.planningProvider,
    planningModel: session.planningModel,
    implementationProvider: session.implementationProvider,
    implementationModel: session.implementationModel,
    agentModels: session.agentModels,
  });
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    workspaceName: session.workspaceName,
    workspacePath: session.workspacePath,
    prompt: session.prompt,
    promptParts: session.promptParts
      ? session.promptParts.map((part) => {
        if (part.type === 'text') {
          return { type: 'text', text: part.text };
        }

        return {
          type: 'image',
          data: part.data,
          mimeType: part.mimeType,
          name: part.name,
        };
      })
      : undefined,
    provider: resolvedAgentModels.implementationProvider,
    model: resolvedAgentModels.implementationModel,
    agentModels: resolvedAgentModels.agentModels,
    planningProvider: resolvedAgentModels.planningProvider,
    planningModel: resolvedAgentModels.planningModel,
    implementationProvider: resolvedAgentModels.implementationProvider,
    implementationModel: resolvedAgentModels.implementationModel,
    deliveryStrategy: session.deliveryStrategy,
    autoApprove: session.autoApprove,
    planningNoToolGuardMode: session.planningNoToolGuardMode,
    quickStartMode: session.quickStartMode,
    quickStartMaxPreDelegationToolCalls: session.quickStartMaxPreDelegationToolCalls,
    adaptiveConcurrency: session.adaptiveConcurrency,
    batchConcurrency: session.batchConcurrency,
    batchMinConcurrency: session.batchMinConcurrency,
    enableTrivialTaskGate: session.enableTrivialTaskGate,
    trivialTaskMaxPromptLength: session.trivialTaskMaxPromptLength,
    worktreePath: session.worktreePath,
    worktreeBranch: session.worktreeBranch,
    creationReason: session.creationReason,
    sourceSessionId: session.sourceSessionId,
    source: session.source,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status,
    mode: resolveSessionToolMode(session),
    llmStatus: session.llmStatus,
    taskStatus: session.taskStatus,
    events: session.events,
    agentGraph: serializedAgentGraph,
    progress,
    error: session.error,
    output: session.output,
    lastCheckpoint: session.lastCheckpoint,
    lastRecovery: session.lastRecovery,
  };
}

function serializeAgentGraphWithProgressInvariant(session: WorkSession): SessionAgentGraphNode[] {
  const nodes = session.agentGraph.map((node) => ({
    ...node,
    dependencies: [...node.dependencies],
  }));

  if (session.status !== 'running' || nodes.length === 0) {
    return nodes;
  }

  if (nodes.some((node) => node.status === 'running')) {
    return nodes;
  }

  const statusById = new Map(nodes.map((node) => [node.id, node.status ?? 'pending']));
  const readyPending = nodes.find((node) => {
    const status = statusById.get(node.id) ?? 'pending';
    if (status === 'completed' || status === 'failed') {
      return false;
    }

    return (node.dependencies ?? []).every((dep) => (statusById.get(dep) ?? 'pending') === 'completed');
  });

  const nonTerminal = nodes.find((node) => {
    const status = statusById.get(node.id) ?? 'pending';
    return status !== 'completed' && status !== 'failed';
  });

  const targetId = (readyPending ?? nonTerminal ?? nodes[0]).id;
  return nodes.map((node) => (node.id === targetId ? { ...node, status: 'running' } : node));
}

function serializeAuthSession(session: AuthSession): Record<string, unknown> {
  return {
    id: session.id,
    providerId: session.providerId,
    state: session.state,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    authUrl: session.authUrl,
    authInstructions: session.authInstructions,
    promptMessage: session.promptMessage,
    promptPlaceholder: session.promptPlaceholder,
    error: session.error,
  };
}

function sendHtml(res: ServerResponse, html: string): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const text = Buffer.concat(chunks).toString('utf-8');
  if (!text.trim()) {
    return {};
  }

  const parsed = JSON.parse(text);
  if (parsed && typeof parsed === 'object') {
    return parsed as Record<string, unknown>;
  }

  return {};
}

function renderDashboardHtml(hmrEnabled: boolean): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Orchestrace Dashboard</title>
</head>
<body>
  <div id="root"></div>
  <script type="module">
    import RefreshRuntime from 'http://localhost:3000/@react-refresh'
    RefreshRuntime.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => {}
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_react_preamble_installed__ = true
  </script>
  <script type="module" src="http://localhost:3000/@vite/client"></script>
  <script type="module" src="http://localhost:3000/src/main.tsx"></script>
</body>
</html>`;
}


function resolveUiWatchPath(workspaceRoot: string): string | undefined {
  const srcPath = join(workspaceRoot, 'packages', 'cli', 'src');
  if (existsSync(srcPath)) {
    return srcPath;
  }

  return undefined;
}

async function gitExec(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoRoot,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

type SessionIdWorkspacePathRelation = {
  relation: 'match' | 'mismatch' | 'none';
  pathSessionId?: string;
};

type SessionPlanningGuardState = {
  consecutiveNonWriteToolCalls: number;
  forcedImplementation: boolean;
};

export function classifyWorkspacePathSessionIdRelation(sessionId: string, workspacePath: string): SessionIdWorkspacePathRelation {
  const normalizedPath = workspacePath.replace(/\\/g, '/');
  const match = normalizedPath.match(/(?:^|\/)session-([0-9a-fA-F-]{8,})(?:\/|$)/);
  const pathSessionId = match?.[1]?.toLowerCase();
  const normalizedSessionId = sessionId.trim().toLowerCase();
  if (!pathSessionId) {
    return { relation: 'none' };
  }
  return {
    relation: pathSessionId === normalizedSessionId ? 'match' : 'mismatch',
    pathSessionId,
  };
}

export async function resolveDefaultBranch(repoRoot: string): Promise<string> {
  const tryCommands: Array<string[]> = [
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    ['rev-parse', '--abbrev-ref', 'origin/HEAD'],
  ];

  for (const args of tryCommands) {
    try {
      const raw = (await gitExec(repoRoot, args)).trim();
      const normalized = raw.replace(/^origin\//, '').trim();
      if (normalized) {
        return normalized;
      }
    } catch {
      // Try next strategy.
    }
  }

  return 'main';
}

export async function cleanupReusedWorktree(repoRoot: string, workspacePath: string): Promise<{ defaultBranch: string }> {
  const defaultBranch = await resolveDefaultBranch(repoRoot);
  const cleanupTargetRef = await resolveCleanupTargetRef(workspacePath, defaultBranch);
  // Use detached checkout so cleanup does not try to attach the default branch,
  // which can already be checked out in another linked worktree.
  await gitExec(workspacePath, ['checkout', '--detach', '-f', cleanupTargetRef]);
  await gitExec(workspacePath, ['reset', '--hard', cleanupTargetRef]);
  await gitExec(workspacePath, ['clean', '-fdx']);
  return { defaultBranch };
}

async function resolveCleanupTargetRef(workspacePath: string, defaultBranch: string): Promise<string> {
  const candidates = [`origin/${defaultBranch}`, defaultBranch, 'HEAD'];
  for (const candidate of candidates) {
    try {
      await gitExec(workspacePath, ['rev-parse', '--verify', candidate]);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }
  return 'HEAD';
}

export async function assertWorkspaceIsClean(
  workspacePath: string,
  summarizeDirty: (workspacePath: string) => Promise<{
    hasUncommittedChanges: boolean;
    hasStagedChanges: boolean;
    hasUntrackedChanges: boolean;
    dirtySummary: string[];
  }>,
): Promise<void> {
  const dirty = await summarizeDirty(workspacePath);
  if (!dirty.hasUncommittedChanges && !dirty.hasStagedChanges && !dirty.hasUntrackedChanges) {
    return;
  }
  const details = dirty.dirtySummary.slice(0, 20).join('\n');
  throw new Error(
    [
      `Workspace is not clean at session start: ${workspacePath}`,
      'Worktree/session assignment requires a clean state before runner launch.',
      details ? `Detected changes:\n${details}` : undefined,
    ].filter(Boolean).join('\n'),
  );
}

export function getSessionPlanningGuardState(): SessionPlanningGuardState {
  return {
    consecutiveNonWriteToolCalls: 0,
    forcedImplementation: false,
  };
}

export function isSimpleSessionTaskPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return normalized.includes('single-file')
    || normalized.includes('single file')
    || normalized.includes('small')
    || normalized.includes('one file');
}

export function validateAndNormalizeSessionPromptInput(params: {
  prompt: unknown;
  promptParts?: SessionChatContentPart[];
}):
  | { ok: true; normalizedPrompt: string }
  | { ok: false; error: string; code: TaskPromptValidationErrorCode; details?: Record<string, unknown> } {
  const promptParts = cloneChatContentParts(params.promptParts ?? []);
  const promptValidation = validateTaskPromptInput({
    prompt: params.prompt,
    fallbackPrompt: summarizeChatContentParts(promptParts),
  });

  if (!promptValidation.ok) {
    return {
      ok: false,
      error: promptValidation.error,
      code: promptValidation.code,
      details: promptValidation.details,
    };
  }

  return {
    ok: true,
    normalizedPrompt: promptParts.length > 0
      ? compactInlineImageMarkdown(promptValidation.sanitizedPrompt)
      : promptValidation.sanitizedPrompt,
  };
}

function isWriteToolCallEvent(toolEvent: LlmToolCallEvent): boolean {
  if (toolEvent.type !== 'started') {
    return false;
  }

  const writeToolNames = new Set([
    'create_file',
    'edit_file',
    'apply_patch',
    'run_in_terminal',
  ]);
  return writeToolNames.has((toolEvent.toolName ?? '').toLowerCase());
}

function resolvePlanningGuardThreshold(): number {
  return parsePositiveSetting(process.env.ORCHESTRACE_MAX_TOOL_CALLS_WITHOUT_WRITE) ?? 10;
}

function resolvePlanningBudgetPercent(): number {
  const parsed = parsePositiveSetting(process.env.ORCHESTRACE_PLANNING_BUDGET_PERCENT) ?? 25;
  return Math.min(100, Math.max(1, parsed));
}

export function enforcePlanningToolCallGuard(params: {
  session: WorkSession;
  continuationPhase: SessionPromptPhase;
  toolEvent: LlmToolCallEvent;
  sessionPlanningGuards: Map<string, SessionPlanningGuardState>;
  persistEvent: (sessionId: string, event: SessionEventInput) => void | Promise<void>;
  uiStatePersistence: { schedule: () => void; flush: () => Promise<void> };
}): SessionPlanningGuardState {
  const existing = params.sessionPlanningGuards.get(params.session.id) ?? getSessionPlanningGuardState();
  params.sessionPlanningGuards.set(params.session.id, existing);

  if (params.continuationPhase !== 'planning') {
    return existing;
  }

  if (isWriteToolCallEvent(params.toolEvent)) {
    existing.consecutiveNonWriteToolCalls = 0;
    return existing;
  }

  if (params.toolEvent.type === 'started') {
    existing.consecutiveNonWriteToolCalls += 1;
  }

  const threshold = resolvePlanningGuardThreshold();
  if (existing.forcedImplementation || existing.consecutiveNonWriteToolCalls <= threshold) {
    return existing;
  }

  existing.forcedImplementation = true;
  params.session.llmStatus = {
    ...params.session.llmStatus,
    state: 'implementing',
    label: 'Implementing',
    detail: `Planning guard triggered after ${existing.consecutiveNonWriteToolCalls} non-write tool calls; switching to implementation.`,
    phase: 'implementation',
    updatedAt: now(),
  };

  void params.persistEvent(params.session.id, {
    time: now(),
    type: 'session:llm-status-change',
    payload: { llmStatus: params.session.llmStatus },
  });
  params.uiStatePersistence.schedule();

  return existing;
}

async function inspectGitRecoveryState(workspacePath: string): Promise<SessionRecoveryInfo['git']> {
  const fallback: SessionRecoveryInfo['git'] = {
    cwd: workspacePath,
    dirty: false,
  };

  try {
    const statusRaw = await gitExec(workspacePath, ['status', '--porcelain', '--branch']);
    const lines = statusRaw.split('\n').map((line) => line.trimEnd()).filter(Boolean);
    const branchLine = lines.find((line) => line.startsWith('## '));
    const changeLines = lines.filter((line) => !line.startsWith('## '));
    const changedFiles = changeLines
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .slice(0, 200);

    const branchInfo = parseGitBranchLine(branchLine);
    let diffSummary: string | undefined;
    if (changeLines.length > 0) {
      try {
        diffSummary = (await gitExec(workspacePath, ['diff', '--stat'])).trim() || undefined;
      } catch {
        diffSummary = undefined;
      }
    }

    return {
      cwd: workspacePath,
      branch: branchInfo.branch,
      head: branchInfo.head,
      detached: branchInfo.detached,
      dirty: changeLines.length > 0,
      changedFiles: changedFiles.length > 0 ? changedFiles : undefined,
      diffSummary,
    };
  } catch {
    return fallback;
  }
}

function parseGitBranchLine(line: string | undefined): { branch?: string; head?: string; detached?: boolean } {
  if (!line) return {};
  const payload = line.replace(/^##\s*/, '').trim();
  if (!payload) return {};
  if (payload.startsWith('HEAD ')) {
    return { detached: true, head: payload.slice('HEAD '.length).trim() || undefined };
  }

  const dotIdx = payload.indexOf('...');
  const branch = (dotIdx >= 0 ? payload.slice(0, dotIdx) : payload).trim();
  return { branch: branch || undefined, detached: false };
}

async function resolveSessionWorkDiff(session: WorkSession): Promise<{
  baseBranch: string;
  comparedPath: string;
  hasChanges: boolean;
  files: Array<{ path: string; status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unmerged' | 'unknown'; previousPath?: string }>;
  stats: { files: number; additions: number; deletions: number };
  diff: string;
  generatedAt: string;
  truncated: boolean;
}> {
  const comparedPath = session.worktreePath ?? session.workspacePath;
  const baseBranch = 'main';
  const baseRef = await resolveMainComparisonRef(comparedPath);
  const nameStatusRaw = await gitExec(comparedPath, ['diff', '--name-status', '--find-renames=60%', baseRef]);
  const numStatRaw = await gitExec(comparedPath, ['diff', '--numstat', '--find-renames=60%', baseRef]);
  const diffRaw = await gitExec(comparedPath, ['diff', '--no-color', '--find-renames=60%', '--unified=3', baseRef]);

  const files = parseDiffNameStatus(nameStatusRaw);
  const stats = parseDiffNumStat(numStatRaw);
  const trimmedDiff = diffRaw.trimEnd();
  const truncated = trimmedDiff.length > WORK_DIFF_MAX_CHARS;
  const diff = truncated
    ? `${trimmedDiff.slice(0, WORK_DIFF_MAX_CHARS)}\n\n# Diff output truncated at ${WORK_DIFF_MAX_CHARS.toLocaleString()} characters.`
    : trimmedDiff;

  return {
    baseBranch,
    comparedPath,
    hasChanges: files.length > 0,
    files,
    stats,
    diff,
    generatedAt: now(),
    truncated,
  };
}

async function resolveMainComparisonRef(repoRoot: string): Promise<'main' | 'origin/main'> {
  for (const candidate of ['main', 'origin/main'] as const) {
    try {
      await gitExec(repoRoot, ['rev-parse', '--verify', candidate]);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  throw new Error('Unable to resolve main branch reference (expected main or origin/main).');
}

function parseDiffNameStatus(raw: string): Array<{
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unmerged' | 'unknown';
  previousPath?: string;
}> {
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  const files: Array<{
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unmerged' | 'unknown';
    previousPath?: string;
  }> = [];

  for (const line of lines) {
    const fields = line.split('\t').filter(Boolean);
    if (fields.length < 2) {
      continue;
    }

    const code = fields[0].trim().toUpperCase();
    const primaryCode = code[0] ?? '';

    if (primaryCode === 'R' || primaryCode === 'C') {
      if (fields.length < 3) {
        continue;
      }

      files.push({
        path: fields[2],
        previousPath: fields[1],
        status: primaryCode === 'R' ? 'renamed' : 'copied',
      });
      continue;
    }

    files.push({
      path: fields[1],
      status: mapDiffStatus(primaryCode),
    });
  }

  return files;
}

function mapDiffStatus(code: string): 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unmerged' | 'unknown' {
  if (code === 'A') return 'added';
  if (code === 'M') return 'modified';
  if (code === 'D') return 'deleted';
  if (code === 'R') return 'renamed';
  if (code === 'C') return 'copied';
  if (code === 'U') return 'unmerged';
  return 'unknown';
}

function parseDiffNumStat(raw: string): { files: number; additions: number; deletions: number } {
  let files = 0;
  let additions = 0;
  let deletions = 0;

  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const fields = line.split('\t');
    if (fields.length < 3) {
      continue;
    }

    files += 1;
    const addRaw = fields[0];
    const delRaw = fields[1];
    const add = addRaw === '-' ? 0 : Number.parseInt(addRaw, 10);
    const del = delRaw === '-' ? 0 : Number.parseInt(delRaw, 10);

    if (Number.isFinite(add)) {
      additions += add;
    }
    if (Number.isFinite(del)) {
      deletions += del;
    }
  }

  return { files, additions, deletions };
}

async function ensureSessionWorkspaceReady(
  session: WorkSession,
  workspaceManager: WorkspaceManager,
  uiStatePersistence: { schedule: () => void; flush: () => Promise<void> },
): Promise<void> {
  if (existsSync(session.workspacePath)) {
        const runtimeCheck = await validateWorkspaceRuntime(session.workspacePath);
    assertWorkspaceRuntimeIsComplete(runtimeCheck);
    session.workspacePath = runtimeCheck.normalizedPath;
    session.worktreePath = runtimeCheck.normalizedPath;
    const warning = formatMissingSourceDirsWarning(runtimeCheck.normalizedPath, runtimeCheck.missingExpectedDirs);
    if (warning) {
      console.warn(`[ui-server] ${warning}`);
    }
    return;
  }

  const workspace = await workspaceManager.selectWorkspace(session.workspaceId);
  const managedWorktree = await ensureSessionWorktree({
    repoRoot: workspace.path,
    sessionId: session.id,
    worktreePath: session.worktreePath,
    branchName: session.worktreeBranch,
  });

    const runtimeCheck = await validateWorkspaceRuntime(managedWorktree.worktreePath);
  assertWorkspaceRuntimeIsComplete(runtimeCheck);
  const runtimePath = runtimeCheck.normalizedPath;
  session.workspacePath = runtimePath;
  session.workspaceName = workspace.name;
  session.worktreePath = runtimePath;
  session.worktreeBranch = managedWorktree.branchName;
  session.cleanupWorktree = async () => {
    await cleanupSessionWorktree({
      repoRoot: workspace.path,
      sessionId: session.id,
      worktreePath: runtimePath,
      branchName: managedWorktree.branchName,
    });
  };
  const warning = formatMissingSourceDirsWarning(runtimeCheck.normalizedPath, runtimeCheck.missingExpectedDirs);
  if (warning) {
    console.warn(`[ui-server] ${warning}`);
  }
  session.updatedAt = now();
  uiStatePersistence.schedule();
}

function isRetryableSubAgentError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes('aborted')
    || message.includes('timeout')
    || message.includes('timed out')
    || message.includes('rate limit')
    || message.includes('429')
    || message.includes('temporar')
    || message.includes('econnreset')
    || message.includes('etimedout')
    || message.includes('network');
}

function resolveSubAgentSystemPrompt(request: SubAgentRequest): string {
  if (request.systemPrompt) {
    return request.systemPrompt;
  }

  if (request.contextPacket) {
    return [
      'You are a focused sub-agent. Use only delegated context and avoid unrelated history.',
      'Respect boundaries in the provided SubAgentContextPacket.',
      'Respond concisely with machine-readable structure when possible.',
      'Preferred output contract: JSON object with keys summary, actions[], evidence[{type,ref,note?}], risks[], openQuestions[], patchIntent[].',
    ].join('\n');
  }

  return 'You are a focused sub-agent. Use only the provided task-relevant context, avoid unrelated history, and return concise actionable output.';
}

function buildStructuredSubAgentResult(result: {
  text: string;
  usage?: { input: number; output: number; cost: number };
}): SubAgentResult {
  const parsed = parseSubAgentResultJson(result.text);
  const summary = normalizeSubAgentSummary(parsed?.summary, result.text);

  return {
    text: result.text,
    usage: result.usage,
    summary,
    actions: normalizeStringList(parsed?.actions),
    evidence: normalizeSubAgentEvidence(parsed?.evidence),
    risks: normalizeStringList(parsed?.risks),
    openQuestions: normalizeStringList(parsed?.openQuestions),
    patchIntent: normalizeStringList(parsed?.patchIntent),
  };
}

function parseSubAgentResultJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [trimmed, fenced].filter((entry): entry is string => Boolean(entry));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try next candidate.
    }
  }

  return undefined;
}

function normalizeSubAgentSummary(summary: unknown, fallbackText: string): string {
  if (typeof summary === 'string' && summary.trim()) {
    return summary.trim().slice(0, 900);
  }

  const compact = fallbackText.replace(/\s+/g, ' ').trim();
  return compact.length > 900 ? `${compact.slice(0, 900)}...` : compact;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
    .slice(0, 12);
}

function normalizeSubAgentEvidence(value: unknown): NonNullable<SubAgentResult['evidence']> {
  if (!Array.isArray(value)) {
    return [];
  }

  const entries: NonNullable<SubAgentResult['evidence']> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const record = item as Record<string, unknown>;
    const type = record.type;
    if (
      type !== 'file'
      && type !== 'command'
      && type !== 'test'
      && type !== 'log'
      && type !== 'url'
      && type !== 'other'
    ) {
      continue;
    }

    const ref = typeof record.ref === 'string' ? record.ref.trim() : '';
    if (!ref) {
      continue;
    }

    const note = typeof record.note === 'string' && record.note.trim() ? record.note.trim() : undefined;
    entries.push({ type, ref, note });
  }

  return entries.slice(0, 16);
}

async function completeSubAgentWithRetry(
  subAgent: {
    complete: (
      prompt: string,
      signal?: AbortSignal,
    ) => Promise<{ text: string; usage?: { input: number; output: number; cost: number } }>;
  },
  prompt: string,
  signal?: AbortSignal,
): Promise<{ text: string; usage?: { input: number; output: number; cost: number } }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SUBAGENT_RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await subAgent.complete(prompt, signal);
    } catch (error) {
      lastError = error;
      if (attempt >= SUBAGENT_RETRY_MAX_ATTEMPTS || !isRetryableSubAgentError(error)) {
        throw error;
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, SUBAGENT_RETRY_BASE_DELAY_MS * attempt);
      });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(toErrorMessage(lastError));
}

type SessionPromptPhase = 'chat' | 'planning' | 'implementation';

type FollowUpSuggestionPhase = 'chat' | 'planning' | 'implementation';

function mergeRetryPromptWithFollowUp(params: {
  prompt: string;
  retryContext?: string;
  followUpText: string;
  followUpParts: SessionChatContentPart[];
}): string {
  const { prompt, retryContext, followUpText, followUpParts } = params;
  const followUp = buildRetryFollowUpSummary({ followUpText, followUpParts });
  const mergedSections: string[] = [];
  const base = prompt.trim();
  if (base) {
    mergedSections.push(base);
  }

  const continuation = retryContext?.trim();
  if (continuation) {
    mergedSections.push(continuation);
  }

  if (followUp) {
    mergedSections.push(followUp);
  }

  return mergedSections.join('\n\n');
}

function stripRetryContinuationFromPrompt(prompt: string): string {
  const source = asString(prompt);
  if (!source) {
    return source;
  }

  const marker = 'Retry continuation context from previous attempt:';
  const followUpMarker = 'Follow-up request:';
  let result = source;

  while (true) {
    const markerIndex = result.indexOf(marker);
    if (markerIndex < 0) {
      break;
    }

    const followUpIndex = result.indexOf(followUpMarker, markerIndex + marker.length);
    if (followUpIndex < 0) {
      result = result.slice(0, markerIndex).trimEnd();
      break;
    }

    const prefix = result.slice(0, markerIndex).trimEnd();
    const suffix = result.slice(followUpIndex).trimStart();
    result = [prefix, suffix].filter((section) => section.length > 0).join('\n\n');
  }

  return result.trim();
}

function buildRetryContinuationSummary(params: {
  session: WorkSession;
  todos: AgentTodoItem[];
}): string {
  const { session, todos } = params;
  const lines: string[] = [
    'Retry continuation context from previous attempt:',
    'Continue from this state instead of restarting from scratch.',
    `- Previous status: ${session.status}`,
  ];

  if (session.error) {
    lines.push(`- Previous error: ${session.error}`);
  }

  const taskStatuses = Object.entries(session.taskStatus);
  if (taskStatuses.length > 0) {
    lines.push('', 'Task status snapshot:');
    for (const [taskId, status] of taskStatuses.slice(0, 20)) {
      lines.push(`- ${taskId}: ${status}`);
    }
    if (taskStatuses.length > 20) {
      lines.push(`- ... (${taskStatuses.length - 20} more task status entries)`);
    }
  }

  if (todos.length > 0) {
    lines.push('', 'Todo snapshot:');
    for (const todo of todos.slice(0, 30)) {
      const status = todo.status ?? (todo.done ? 'done' : 'todo');
      lines.push(`- [${status}] ${todo.id}: ${todo.text}`);
    }
    if (todos.length > 30) {
      lines.push(`- ... (${todos.length - 30} more todo items)`);
    }
  }

  if (session.agentGraph.length > 0) {
    lines.push('', 'Agent graph snapshot:');
    for (const node of session.agentGraph.slice(0, 20)) {
      const deps = node.dependencies.length > 0 ? ` deps=${node.dependencies.join(',')}` : '';
      lines.push(`- [${node.status ?? 'pending'}] ${node.id}${deps}`);
    }
    if (session.agentGraph.length > 20) {
      lines.push(`- ... (${session.agentGraph.length - 20} more graph nodes)`);
    }
  }

  if (session.output?.planPath) {
    lines.push('', `Plan path from previous attempt: ${session.output.planPath}`);
  }

  if (session.output?.text) {
    lines.push('', 'Previous output excerpt:');
    lines.push(truncateRetryContinuation(session.output.text, RETRY_OUTPUT_EXCERPT_MAX_CHARS));
  }

  return truncateRetryContinuation(lines.join('\n'), RETRY_CONTINUATION_MAX_CHARS);
}

function truncateRetryContinuation(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n... [retry context truncated]`;
}

function mergeRetryPromptPartsWithFollowUp(params: {
  promptParts?: SessionChatContentPart[];
  followUpText: string;
  followUpParts: SessionChatContentPart[];
}): SessionChatContentPart[] | undefined {
  const baseParts = cloneChatContentParts(params.promptParts ?? []);
  const followUpParts = buildRetryFollowUpParts({
    followUpText: params.followUpText,
    followUpParts: params.followUpParts,
  });

  if (followUpParts.length === 0) {
    return baseParts.length > 0 ? baseParts : undefined;
  }

  if (baseParts.length === 0) {
    return followUpParts;
  }

  return [
    ...baseParts,
    { type: 'text', text: 'Follow-up request:' },
    ...followUpParts,
  ];
}

function buildRetryFollowUpSummary(params: {
  followUpText: string;
  followUpParts: SessionChatContentPart[];
}): string {
  const followUpParts = buildRetryFollowUpParts(params);
  if (followUpParts.length === 0) {
    return '';
  }

  const summary = summarizeChatContentParts(followUpParts).trim();
  return summary ? `Follow-up request:\n${summary}` : '';
}

function buildRetryFollowUpParts(params: {
  followUpText: string;
  followUpParts: SessionChatContentPart[];
}): SessionChatContentPart[] {
  const merged: SessionChatContentPart[] = [];
  const text = params.followUpText.trim();
  if (text) {
    merged.push({ type: 'text', text });
  }

  return [...merged, ...cloneChatContentParts(params.followUpParts)];
}

function trimCompactionSummary(text: string, maxTokens: number): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }

  const maxChars = Math.max(1_200, Math.floor(maxTokens * 4));
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxChars)}\n... [summary truncated for budget]`;
}

function buildCompactionFallbackSummary(text: string, maxTokens: number): string {
  const excerpt = trimCompactionSummary(text, maxTokens);
  if (!excerpt) {
    return '';
  }

  return [
    '## Decisions',
    '- Compaction fallback used due summarization-model unavailability.',
    '',
    '## Errors & Blockers',
    '- Verify provider auth/model availability for compaction path if this repeats.',
    '',
    '## Progress',
    '- Preserved a bounded raw excerpt from prior context.',
    '',
    '## Key Technical Details',
    `- Excerpt:\n${excerpt}`,
  ].join('\n');
}

async function buildManagedChatContinuationInput(params: {
  session: WorkSession;
  thread: SessionChatThread;
  systemPrompt: string;
  todos: AgentTodoItem[];
  contextEngine: ContextEngine;
  contextState: SessionContextState;
  sharedContextStore: InMemorySharedContextStore;
}): Promise<{ prompt: LlmPromptInput; nextState: SessionContextState }> {
  try {
    const relevantMessages = params.thread.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant');

    let latestMultimodalUser: SessionChatMessage | undefined;
    for (let index = relevantMessages.length - 1; index >= 0; index -= 1) {
      const candidate = relevantMessages[index];
      if (candidate.role === 'user' && candidate.contentParts?.some((part) => part.type === 'image')) {
        latestMultimodalUser = candidate;
        break;
      }
    }

    const historyMessages = latestMultimodalUser
      ? relevantMessages.filter((message) => message !== latestMultimodalUser)
      : relevantMessages;

    const turns: ConversationTurn[] = historyMessages.map((message, index) => {
      const content = message.contentParts?.length
        ? summarizeChatContentParts(message.contentParts)
        : message.content;
      return {
        role: message.role === 'user' ? 'user' : 'assistant',
        content,
        turnIndex: index,
        tokens: countTokens(content),
      };
    });

    const contextResult = await params.contextEngine.buildContext({
      systemPrompt: params.systemPrompt,
      turns,
      executionState: buildContextExecutionStateSummary(params.session, params.todos),
      sharedFacts: params.sharedContextStore.list(params.session.id),
      turnsSinceLastCompaction: params.contextState.turnsSinceLastCompaction,
      previousCompressedHistory: params.contextState.previousCompressedHistory,
    });

    const nextState: SessionContextState = {
      turnsSinceLastCompaction: contextResult.compactionPerformed
        ? 0
        : params.contextState.turnsSinceLastCompaction + 1,
      previousCompressedHistory: contextResult.compactionPerformed
        ? contextResult.envelope.compressedHistory.content
        : params.contextState.previousCompressedHistory,
    };

    if (!latestMultimodalUser) {
      return {
        prompt: contextResult.userPrompt,
        nextState,
      };
    }

    const multimodalParts = (latestMultimodalUser.contentParts ?? [{ type: 'text', text: latestMultimodalUser.content }]).map((part) => {
      if (part.type === 'text') {
        return { type: 'text' as const, text: part.text };
      }
      return { type: 'image' as const, data: part.data, mimeType: part.mimeType };
    });

    const basePromptText = typeof contextResult.userPrompt === 'string'
      ? contextResult.userPrompt
      : 'Continue from the conversation context and respond to the latest multimodal user message.';

    return {
      prompt: [
        {
          type: 'text',
          text: [
            basePromptText,
            '',
            'The latest user message follows as multimodal content (text + image attachments).',
            'Reply as ASSISTANT and continue from that latest user message.',
          ].join('\n'),
        },
        ...multimodalParts,
      ],
      nextState,
    };
  } catch {
    return {
      prompt: buildChatContinuationInput(params.thread),
      nextState: {
        turnsSinceLastCompaction: params.contextState.turnsSinceLastCompaction + 1,
        previousCompressedHistory: params.contextState.previousCompressedHistory,
      },
    };
  }
}

function buildContextExecutionStateSummary(session: WorkSession, todos: AgentTodoItem[]): string {
  const doneCount = todos.filter((todo) => todo.done || todo.status === 'done').length;
  const pendingTodos = todos
    .filter((todo) => !(todo.done || todo.status === 'done'))
    .slice(0, 12)
    .map((todo) => {
      const status = todo.status ?? (todo.done ? 'done' : 'todo');
      const weight = Number.isFinite(todo.weight) ? ` (${todo.weight}%)` : '';
      return `- ${todo.id}: ${todo.text} [${status}]${weight}`;
    });

  const lines = [
    `Session status: ${session.status}`,
    `LLM status: ${session.llmStatus.state}${session.llmStatus.phase ? ` (${session.llmStatus.phase})` : ''}`,
    session.llmStatus.detail ? `LLM detail: ${session.llmStatus.detail}` : '',
    `Todo progress: ${doneCount}/${todos.length} completed`,
  ].filter(Boolean);

  if (pendingTodos.length > 0) {
    lines.push('Pending todo items:');
    lines.push(...pendingTodos);
  }

  return lines.join('\n');
}

export function resolveRunnerTaskRouteEnvValue(
  routeOverrideRaw: string | undefined,
): 'shell_command' | 'investigation' | 'code_change' | 'refactor' {
  return parseTaskRouteOverride(routeOverrideRaw) ?? 'code_change';
}

export function buildSessionSystemPrompt(session: WorkSession, phase: SessionPromptPhase): string {

  const quickStartMode = session.quickStartMode
    ?? (parseBooleanSetting(process.env.ORCHESTRACE_QUICK_START_MODE) ?? false);
  const quickStartMaxPreDelegationToolCalls = normalizePositiveSetting(
    session.quickStartMaxPreDelegationToolCalls,
    parsePositiveSetting(process.env.ORCHESTRACE_QUICK_START_MAX_PRE_DELEGATION_TOOL_CALLS) ?? 3,
  );
  const planningBudgetPercent = resolvePlanningBudgetPercent();

  const phaseRules =
    phase === 'chat'
      ? [
          'Keep continuity with prior messages and avoid repeating completed work.',
          'Use chat responses to clarify intent, summarize progress, and gather missing context.',
          'When direct implementation is requested, proceed with concrete action-oriented steps.',
          'When the user asks for planning, switch to planning mode and perform todo_set + agent_graph_set before presenting the plan.',
          'In planning mode, todo_set items must include numeric weight values that sum to 100 for planning-progress tracking.',
          'In planning mode, agent_graph_set nodes must include numeric weight values that sum to 100 for implementation-progress tracking.',
          'When planning, require atomic task granularity: one action per task with explicit done criteria and verification commands.',
          'Reject broad bundled tasks; split work into smaller units before finalizing the plan.',
          'When publishing agent_graph_set, use descriptive node ids/names instead of generic n1/n2 labels.',
          'Planning requests must also use subagent_spawn or subagent_spawn_batch with focused, task-relevant context per sub-agent.',
          'Pass nodeId on each sub-agent request so graph progress stays visible and current.',
          'When asked to inspect or change todos/agent graph, call the corresponding tools instead of simulating success.',
          'For reading multiple files, prefer read_files with concurrency over repeated one-by-one read_file calls.',
          'When calling todo tools, use canonical statuses only: todo, in_progress, done.',
          'Always run `git fetch origin` before checking remote branch state, merge status, or pushing. Never trust local tracking refs without fetching first.',
          'Do not ask the user to continue after partial progress; continue autonomously until completion or a concrete blocker is reached.',
          'For transient tool or sub-agent failures (timeouts, aborts, rate limits), retry automatically before surfacing a blocker.',
          'If no tool was executed, explicitly state that no tool output is available.',
        ]
      : phase === 'planning'
        ? [
            'Produce a concrete implementation plan with explicit staged execution and validation steps.',
            'Do not perform direct code edits in planning mode.',
          'For simple single-file tasks, skip sub-agent delegation and proceed with direct plan publication.',
          `Planning is budgeted: keep planning activity under ${planningBudgetPercent}% of total effort.`,
          'If session guard thresholds are exceeded, force implementation and continue execution.',
            'Planning output must be highly granular and atomic: each task should represent one action and one completion outcome.',
            'Split broad, multi-area, or multi-step tasks into smaller independent tasks before finalizing.',
            'Each planned task must include explicit dependencies, concrete done criteria, and at least one verification command.',
            'Planning must produce and maintain todo_set and agent_graph_set state.',
            'todo_set items must include numeric weight values and the total todo weight must sum to 100.',
            'agent_graph_set nodes must include numeric weight values and the total node weight must sum to 100.',
            'Planning must use subagent_spawn or subagent_spawn_batch for focused parallel research and delegate only relevant context.',
            'Quick-start mode for well-scoped tasks: keep parent pre-delegation orientation to at most 3-4 calls and delegate within the first 2-3 calls whenever possible.',
            'Keep parent orientation lightweight and push detailed file reading/search into sub-agent scopes.',
            'For independent nodes, use subagent_spawn_batch so work runs in parallel.',
            'For multi-file inspection, use read_files with concurrency to reduce latency; avoid repeated single-file reads when possible.',
            'Pass nodeId for each sub-agent request so graph status stays current.',
            'Keep todo and dependency graph state synchronized.',
            'Do not ask the user to continue after partial progress; continue autonomously until completion or a concrete blocker is reached.',
            'For transient tool or sub-agent failures (timeouts, aborts, rate limits), retry automatically before surfacing a blocker.',
            ...(quickStartMode
              ? [
                `Quick-start mode is enabled: delegate focused discovery to sub-agents within the first 2-3 tool calls and no later than ${quickStartMaxPreDelegationToolCalls} successful pre-delegation tool call(s).`,
                'Limit parent orientation to 3-4 initial tool calls (e.g., root listing, manifest read, git status) before delegating.',
                'Push detailed file reads/searches into sub-agent scopes unless a direct blocker requires immediate local inspection.',
              ]
              : []),
          ]
        : [
            'Execute approved work with minimal, scoped edits and verify outcomes.',
            'Read before editing, and use tool output to adapt after failures.',
            'Read todo_get and agent_graph_get before coding, then keep todo_update current while implementing.',
            'Use subagent_spawn or subagent_spawn_batch to execute parallelizable slices with minimal relevant context per agent.',
            'For independent nodes, use subagent_spawn_batch so work runs in parallel.',
            'For multi-file inspection, use read_files with concurrency to reduce latency; avoid repeated single-file reads when possible.',
            'Pass nodeId for each sub-agent request so graph status stays current.',
            'Use github_api for GitHub REST/GraphQL operations; do not use gh CLI.',
            'Iterate until validation passes or a true blocker is reached.',
            'After each push or PR update, query remote CI/check status with github_api and keep fixing/re-pushing until checks pass or a true blocker is reached.',
            'Do not stop at green checks alone: verify PR mergeability, required checks, and review state via github_api, then keep iterating until the PR is merge-ready or a true blocker is reached.',
            'Always run `git fetch origin` before checking remote branch state, merge status, or pushing. Never trust local tracking refs without fetching first.',
            'Do not ask the user to continue after partial progress; continue autonomously until completion or a concrete blocker is reached.',
            'For transient tool or sub-agent failures (timeouts, aborts, rate limits), retry automatically before surfacing a blocker.',
          ];

  const sections: PromptSection[] = [
    {
      name: PromptSectionName.Identity,
      lines: [
        `You are continuing an existing Orchestrace ${phase} session.`,
        'Operate as an autonomous engineering agent with reliable, verifiable execution.',
      ],
    },
    {
      name: PromptSectionName.AutonomyContract,
      lines: [
        'Never claim actions completed unless confirmed by tool output.',
        'If context is missing, gather it with available tools before deciding.',
        'Prefer deterministic steps and explicit validation over speculation.',
      ],
    },
    {
      name: PromptSectionName.PhaseRules,
      lines: phaseRules,
    },
    {
      name: PromptSectionName.SessionContext,
      lines: [
        `Workspace: ${session.workspacePath}`,
        `Provider/Model: ${session.provider}/${session.model}`,
        `Original task prompt: ${session.prompt}`,
      ],
    },
  ];

  return renderPromptSections(sections);
}

function buildPlanningSystemPrompt(session: WorkSession): string {
  return buildSessionSystemPrompt(session, 'planning');
}

function buildImplementationSystemPrompt(session: WorkSession): string {
  return buildSessionSystemPrompt(session, 'implementation');
}

function buildChatSystemPrompt(session: WorkSession): string {
  return buildSessionSystemPrompt(session, 'chat');
}

function ensureFollowUpSuggestions(text: string, phase: FollowUpSuggestionPhase): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return phase === 'chat' ? buildFollowUpSuggestionsBlock(phase) : 'No response generated.';
  }

  if (phase !== 'chat') {
    return trimmed;
  }

  if (hasFollowUpSuggestions(trimmed)) {
    return trimmed;
  }

  return `${trimmed}\n\n${buildFollowUpSuggestionsBlock(phase)}`;
}

function hasFollowUpSuggestions(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes('next follow-up suggestions')
    || normalized.includes('next followup suggestions')
    || normalized.includes('next steps');
}

function buildFollowUpSuggestionsBlock(phase: FollowUpSuggestionPhase): string {
  const suggestions = phase === 'planning'
    ? [
      'Review and approve the plan todo list and dependency graph before implementation.',
      'Execute the first stage tasks and keep todo_update synchronized with real progress.',
      'Run the planned verification commands after each stage to catch regressions early.',
    ]
    : phase === 'implementation'
      ? [
        'Run typecheck and tests for the touched packages to verify the change set.',
        'Review the diff for scope control and update todos for completed and pending work.',
        'Address the highest-risk follow-up item from validation output or reviewer feedback.',
      ]
      : [
        'Clarify any missing constraints before the next major edit or planning step.',
        'Switch to planning mode and publish todo_set plus agent_graph_set for the next objective.',
        'Start implementation on the highest-priority todo item and keep progress synchronized.',
      ];

  return [
    'Next Follow-up Suggestions:',
    ...suggestions.map((item, index) => `${index + 1}. ${item}`),
  ].join('\n');
}
