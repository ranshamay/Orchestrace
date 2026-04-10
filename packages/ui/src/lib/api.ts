export const API_BASE = '/api';

const AUTH_TOKEN_STORAGE_KEY = 'orchestrace.appAuthToken';

function getStoredAuthToken(): string | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const token = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  return token?.trim() || undefined;
}

export function setStoredAuthToken(token: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  const value = token.trim();
  if (!value) {
    window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, value);
}

export function clearStoredAuthToken(): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
}

function withAuthHeaders(init?: RequestInit): RequestInit {
  const token = getStoredAuthToken();
  if (!token) {
    return init ?? {};
  }

  const headers = new Headers(init?.headers ?? undefined);
  headers.set('Authorization', `Bearer ${token}`);
  return {
    ...(init ?? {}),
    headers,
  };
}

function withAuthApiPath(path: string): string {
  const token = getStoredAuthToken();
  if (!token) {
    return path;
  }

  if (!path.startsWith(API_BASE)) {
    return path;
  }

  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}token=${encodeURIComponent(token)}`;
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, withAuthHeaders(init));
}

export interface AppAuthConfigResponse {
  authEnabled: boolean;
  provider: 'google' | null;
  googleClientId: string | null;
}

export interface AppAuthStatusResponse {
  authenticated: boolean;
  authEnabled: boolean;
  user?: {
    email: string;
    name?: string;
    picture?: string;
  };
  expiresAt?: number;
}

export interface AppGoogleAuthResponse {
  token: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: {
    email: string;
    name?: string;
    picture?: string;
  };
}

export async function fetchAppAuthConfig(): Promise<AppAuthConfigResponse> {
  return readJson(await fetch(`${API_BASE}/app-auth/config`));
}

export async function fetchAppAuthStatus(): Promise<AppAuthStatusResponse> {
  return readJson(await authedFetch(`${API_BASE}/app-auth/status`));
}

export async function loginWithGoogleIdToken(idToken: string): Promise<AppGoogleAuthResponse> {
  const res = await fetch(`${API_BASE}/app-auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  return readJson(res);
}

export function buildAuthedSseUrl(path: string): string {
  return withAuthApiPath(path);
}

export interface ProviderInfo {
  id: string;
  authType: string;
  name?: string;
}

export interface ProvidersResponse {
  providers: ProviderInfo[];
  statuses: Array<{ provider: string; source: string }>;
  defaults: { provider: string; model: string };
}

export type ProviderAuthSessionState = 'running' | 'awaiting-auth' | 'awaiting-input' | 'completed' | 'failed';

export interface ProviderAuthSession {
  id: string;
  providerId: string;
  state: ProviderAuthSessionState;
  createdAt: string;
  updatedAt: string;
  authUrl?: string;
  authInstructions?: string;
  promptMessage?: string;
  promptPlaceholder?: string;
  error?: string;
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
}

export type SessionDeliveryStrategy = 'pr-only' | 'merge-after-ci';
export type ReasoningLevel = 'minimal' | 'low' | 'medium' | 'high';
export type AgentRole = 'router' | 'planner' | 'implementer' | 'reviewer' | 'investigator';

export interface AgentModelConfig {
  provider?: string;
  model?: string;
  reasoning?: ReasoningLevel;
}

export interface AgentModels {
  router?: AgentModelConfig;
  planner?: AgentModelConfig;
  implementer?: AgentModelConfig;
  reviewer?: AgentModelConfig;
  investigator?: AgentModelConfig;
}

export interface UiPreferences {
  activeTab: 'graph' | 'settings' | 'logs';
  observerShowFindings: boolean;
  defaultProvider: string;
  defaultModel: string;
  defaultAgentModels: AgentModels;
  defaultPlanningProvider: string;
  defaultPlanningModel: string;
  defaultImplementationProvider: string;
  defaultImplementationModel: string;
  defaultDeliveryStrategy: SessionDeliveryStrategy;
  planningNoToolGuardMode: 'enforce' | 'warn';
  adaptiveConcurrency: boolean;
  batchConcurrency: number;
  batchMinConcurrency: number;
}

export interface WorkspacesResponse {
  activeWorkspaceId?: string;
  workspaces: Workspace[];
}

export interface WorkSessionProgress {
  percent: number;
  planningPercent: number;
  implementationPercent: number;
  weightedOverallPercent: number;
  source: 'graph+todos' | 'graph' | 'todos' | 'llm';
  confidence: 'high' | 'medium' | 'low';
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
}

export type SessionCreationReason = 'start' | 'retry';

export interface WorkSession {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  prompt: string;
  provider: string;
  model: string;
  agentModels?: AgentModels;
  planningProvider?: string;
  planningModel?: string;
  implementationProvider?: string;
  implementationModel?: string;
  deliveryStrategy?: SessionDeliveryStrategy;
  autoApprove: boolean;
  planningNoToolGuardMode?: 'enforce' | 'warn';
  adaptiveConcurrency?: boolean;
  batchConcurrency?: number;
  batchMinConcurrency?: number;
  worktreePath?: string;
  worktreeBranch?: string;
  creationReason?: SessionCreationReason;
  sourceSessionId?: string;
  source?: 'user' | 'observer';
  createdAt: string;
  updatedAt: string;
  status: string;
  mode?: 'chat' | 'planning' | 'implementation';
  llmStatus?: {
    state: string;
    label: string;
    detail?: string;
    failureType?: string;
    taskId?: string;
    phase?: 'planning' | 'implementation';
    updatedAt: string;
  };
  taskStatus: Record<string, string>;
    events: Array<{
    time: string;
    type: string;
    runId?: string;
    taskId?: string;
    failureType?: string;
    attempt?: number;
    maxRetries?: number;
    totalDurationMs?: number;
    toolName?: string;
    toolStatus?: 'started' | 'result';
    toolCallId?: string;
    toolInput?: string;
    toolOutput?: string;
    toolIsError?: boolean;
    toolDetails?: unknown;
    message: string;
  }>;

  agentGraph?: Array<{
    id: string;
    name?: string;
    prompt: string;
    weight?: number;
    dependencies: string[];
    status?: 'pending' | 'running' | 'completed' | 'failed';
  }>;
  progress?: WorkSessionProgress;
  output?: { text?: string; planPath?: string; failureType?: string };
  error?: string;
}

export interface WorkSessionsResponse {
  sessions: WorkSession[];
}

export type WorkSessionDiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unmerged' | 'unknown';

export interface WorkSessionDiffFile {
  path: string;
  status: WorkSessionDiffFileStatus;
  previousPath?: string;
}

export interface WorkSessionDiffResponse {
  id: string;
  baseBranch: string;
  comparedPath: string;
  hasChanges: boolean;
  files: WorkSessionDiffFile[];
  stats: {
    files: number;
    additions: number;
    deletions: number;
  };
  diff: string;
  generatedAt: string;
  truncated: boolean;
}

export interface AgentTodo {
  id: string;
  text: string;
  status?: 'todo' | 'in_progress' | 'done';
  done: boolean;
  weight?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  contentParts?: ChatContentPart[];
  time: string;
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; name?: string };

export interface WorkAgentResponse {
  session: WorkSession;
  messages: ChatMessage[];
  todos: AgentTodo[];
}

export interface WorkToolsResponse {
  id: string;
  mode: 'chat' | 'planning' | 'implementation';
  tools: Array<{ name: string; description: string }>;
}

export interface GithubAuthStatus {
  connected: boolean;
  source: string;
  storedApiKeyConfigured: boolean;
  login?: string;
  name?: string;
  scopes: string[];
  error?: string;
}

export interface GithubAuthStatusResponse {
  status: GithubAuthStatus;
}

export interface GithubDeviceAuthSession {
  id: string;
  state: 'awaiting-user' | 'polling' | 'completed' | 'failed';
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  scopes: string[];
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `Request failed (${res.status})`);
  }
  return res.json();
}

export async function fetchProviders(): Promise<ProvidersResponse> {
  return readJson(await authedFetch(`${API_BASE}/providers`));
}

export async function startProviderAuth(providerId: string): Promise<{ sessionId: string }> {
  const res = await authedFetch(`${API_BASE}/auth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId }),
  });
  return readJson(res);
}

export async function fetchProviderAuthSession(id: string): Promise<{ session: ProviderAuthSession }> {
  return readJson(await authedFetch(`${API_BASE}/auth/session?id=${encodeURIComponent(id)}`));
}

export async function respondProviderAuthSession(sessionId: string, value: string): Promise<{ ok: boolean }> {
  const res = await authedFetch(`${API_BASE}/auth/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, value }),
  });
  return readJson(res);
}

export async function fetchGithubAuthStatus(): Promise<GithubAuthStatusResponse> {
  return readJson(await authedFetch(`${API_BASE}/github/auth/status`));
}

export async function startGithubDeviceAuth(payload?: {
  clientId?: string;
  scopes?: string[];
}): Promise<{ sessionId: string; session: GithubDeviceAuthSession }> {
  const res = await authedFetch(`${API_BASE}/github/auth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  return readJson(res);
}

export async function fetchGithubDeviceAuthSession(id: string): Promise<{ session: GithubDeviceAuthSession }> {
  return readJson(await authedFetch(`${API_BASE}/github/auth/session?id=${encodeURIComponent(id)}`));
}

export async function fetchModels(provider: string): Promise<{ provider: string; models: string[] }> {
  return readJson(await authedFetch(`${API_BASE}/models?provider=${encodeURIComponent(provider)}`));
}

export async function fetchWorkspaces(): Promise<WorkspacesResponse> {
  return readJson(await authedFetch(`${API_BASE}/workspaces`));
}

export async function fetchUiPreferences(): Promise<{ preferences: UiPreferences }> {
  return readJson(await authedFetch(`${API_BASE}/ui/preferences`));
}

export async function updateUiPreferences(patch: Partial<UiPreferences>): Promise<{ preferences: UiPreferences }> {
  const res = await authedFetch(`${API_BASE}/ui/preferences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return readJson(res);
}

export async function fetchSessions(): Promise<WorkSessionsResponse> {
  return readJson(await authedFetch(`${API_BASE}/work`));
}

export async function fetchWorkAgent(id: string): Promise<WorkAgentResponse> {
  return readJson(await authedFetch(`${API_BASE}/work/agent?id=${encodeURIComponent(id)}`));
}

export async function fetchWorkTools(
  id: string,
  mode?: 'chat' | 'planning' | 'implementation',
): Promise<WorkToolsResponse> {
  const params = new URLSearchParams({ id });
  if (mode) {
    params.set('mode', mode);
  }
  return readJson(await authedFetch(`${API_BASE}/work/tools?${params.toString()}`));
}

export async function fetchWorkDiff(id: string): Promise<WorkSessionDiffResponse> {
  return readJson(await authedFetch(`${API_BASE}/work/diff?id=${encodeURIComponent(id)}`));
}

export async function startWork(payload: {
  workspaceId: string;
  prompt: string;
  provider: string;
  model: string;
  agentModels?: AgentModels;
  planningProvider?: string;
  planningModel?: string;
  implementationProvider?: string;
  implementationModel?: string;
  deliveryStrategy?: SessionDeliveryStrategy;
  autoApprove: boolean;
  planningNoToolGuardMode?: 'enforce' | 'warn';
  adaptiveConcurrency?: boolean;
  batchConcurrency?: number;
  batchMinConcurrency?: number;
  promptParts?: ChatContentPart[];
}): Promise<{ id: string }> {
  const res = await authedFetch(`${API_BASE}/work/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return readJson(res);
}

export async function deleteWork(id: string): Promise<{ ok: boolean; id: string }> {
  const res = await authedFetch(`${API_BASE}/work/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return readJson(res);
}

export async function cancelWork(id: string): Promise<{ ok: boolean }> {
  const res = await authedFetch(`${API_BASE}/work/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return readJson(res);
}

export async function retryWork(id: string): Promise<{ id: string; sourceId: string }> {
  const res = await authedFetch(`${API_BASE}/work/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return readJson(res);
}

export async function sendChatMessage(
  id: string,
  payload: { message: string; messageParts?: ChatContentPart[] },
): Promise<{ ok: boolean; messages: ChatMessage[] }> {
  const res = await authedFetch(`${API_BASE}/work/chat/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, message: payload.message, messageParts: payload.messageParts }),
  });
  return readJson(res);
}

export async function addTodo(id: string, text: string): Promise<{ ok: boolean; todos: AgentTodo[] }> {
  const res = await authedFetch(`${API_BASE}/work/todos/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, text }),
  });
  return readJson(res);
}

export async function toggleTodo(id: string, todoId: string, done: boolean): Promise<{ ok: boolean; todos: AgentTodo[] }> {
  const res = await authedFetch(`${API_BASE}/work/todos/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, todoId, done }),
  });
  return readJson(res);
}

// -- Observer API --

export interface ObserverFinding {
  fingerprint: string;
  schemaVersion: '1' | '2';
  category: string;
  severity: string;
  title: string;
  description: string;
  evidence?: Array<{ text: string }>;
  suggestedFix?: string;
  relevantFiles?: string[];
  observedInSessions: string[];
  detectedAt: string;
  fixSessionId: string | null;
  fixStatus: 'pending' | 'spawned' | 'completed' | 'failed';
  additionalSessions: string[];
}


export interface ObserverStatusResponse {
  config: {
    enabled: boolean;
    provider: string;
    model: string;
    logWatcherProvider: string;
    logWatcherModel: string;
    fixProvider: string;
    fixModel: string;
    analysisCooldownMs: number;
    maxAnalysisPromptChars: number;
    maxSessionsPerAnalysisBatch: number;
    rateLimitCooldownMs: number;
    maxRateLimitBackoffMs: number;
    assessmentCategories: Array<
      'code-quality' | 'performance' | 'agent-efficiency' | 'architecture' | 'test-coverage'
    >;
  };
  state: {
    running: boolean;
    lastAnalysisAt: string | null;
    rateLimitedUntil: string | null;
    analyzedCount: number;
    pendingFindings: number;
    totalFindings: number;
  };
}

export interface ObserverFailedSessionMonitor {
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  prompt: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  observer: {
    analyzed: boolean;
    findings: number;
    latestFindingAt: string | null;
    fixStatusCounts: {
      pending: number;
      spawned: number;
      completed: number;
      failed: number;
    };
  };
}

export async function fetchObserverStatus(): Promise<ObserverStatusResponse> {
  const res = await authedFetch(`${API_BASE}/observer/status`);
  return readJson(res);
}

export async function fetchObserverFindings(): Promise<{ findings: ObserverFinding[] }> {
  const res = await authedFetch(`${API_BASE}/observer/findings`);
  return readJson(res);
}

export async function fetchObserverFailedSessions(): Promise<{ sessions: ObserverFailedSessionMonitor[] }> {
  const res = await authedFetch(`${API_BASE}/observer/failed-sessions`);
  return readJson(res);
}

export async function enableObserver(): Promise<{ enabled: boolean }> {
  const res = await authedFetch(`${API_BASE}/observer/enable`, { method: 'POST' });
  return readJson(res);
}

export async function disableObserver(): Promise<{ enabled: boolean }> {
  const res = await authedFetch(`${API_BASE}/observer/disable`, { method: 'POST' });
  return readJson(res);
}

export async function updateObserverConfig(config: Record<string, unknown>): Promise<{ config: ObserverStatusResponse['config'] }> {
  const res = await authedFetch(`${API_BASE}/observer/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return readJson(res);
}

export async function triggerObserverAnalysis(): Promise<{ analyzed: number; findings: number; spawned: number }> {
  const res = await authedFetch(`${API_BASE}/observer/trigger`, { method: 'POST' });
  return readJson(res);
}

// -- Per-Session Observer API --

export type SessionObserverStatus = 'idle' | 'watching' | 'analyzing' | 'done';

export interface SessionObserverFinding {
  id: string;
  schemaVersion: '2';
  category: string;
  severity: string;
  title: string;
  description: string;
  evidence: Array<{ text: string }>;
  relevantFiles?: string[];
  phase: string;
  detectedAt: string;
}


export interface SessionObserverState {
  status: SessionObserverStatus;
  findings: SessionObserverFinding[];
  analyzedSteps: number;
  lastAnalyzedAt: string | null;
}

export interface SessionObserverResponse {
  active: boolean;
  state: SessionObserverState | null;
}

export async function fetchSessionObserver(sessionId: string): Promise<SessionObserverResponse> {
  const res = await authedFetch(`${API_BASE}/observer/session?id=${encodeURIComponent(sessionId)}`);
  return readJson(res);
}

// -- Log Watcher Types -------------------------------------------------------

export type LogWatcherStatus = 'idle' | 'watching' | 'analyzing' | 'stopped';

export type LogFindingCategory =
  | 'error-pattern'
  | 'performance'
  | 'configuration'
  | 'reliability'
  | 'security';

export interface LogFinding {
  id: string;
  category: LogFindingCategory;
  severity: string;
  title: string;
  description: string;
  suggestedFix?: string;
  evidence?: Array<{ text: string }>;
  relevantFiles?: string[];
  logSnippet: string;
  detectedAt: string;
}


export interface LogWatcherState {
  status: LogWatcherStatus;
  findings: LogFinding[];
  analyzedBatches: number;
  lastAnalyzedAt: string | null;
  linesProcessed: number;
}

export interface LogStreamErrorEvent {
  errorId: string;
  source: 'log-watcher' | 'observer-ingestion' | 'session-observer-ingestion' | 'log-stream';
  operation: string;
  message: string;
  timestamp: string;
  severity?: 'info' | 'warning' | 'error';
  context?: Record<string, unknown>;
}


export async function fetchLogWatcherStatus(): Promise<{ state: LogWatcherState }> {
  const res = await authedFetch(`${API_BASE}/logs/status`);
  return readJson(res);
}

export async function fetchLogWatcherFindings(): Promise<{ findings: LogFinding[] }> {
  const res = await authedFetch(`${API_BASE}/logs/findings`);
  return readJson(res);
}
