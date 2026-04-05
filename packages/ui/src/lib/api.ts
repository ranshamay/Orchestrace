export const API_BASE = '/api';

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

export interface UiPreferences {
  useWorktree: boolean;
  adaptiveConcurrency: boolean;
  batchConcurrency: number;
  batchMinConcurrency: number;
}

export interface WorkspacesResponse {
  activeWorkspaceId?: string;
  workspaces: Workspace[];
}

export interface WorkSession {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  prompt: string;
  provider: string;
  model: string;
  autoApprove: boolean;
  useWorktree?: boolean;
  adaptiveConcurrency?: boolean;
  batchConcurrency?: number;
  batchMinConcurrency?: number;
  worktreePath?: string;
  worktreeBranch?: string;
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
  events: Array<{ time: string; type: string; runId?: string; taskId?: string; failureType?: string; message: string }>;
  agentGraph?: Array<{
    id: string;
    name?: string;
    prompt: string;
    dependencies: string[];
    status?: 'pending' | 'running' | 'completed' | 'failed';
  }>;
  output?: { text?: string; planPath?: string; failureType?: string };
  error?: string;
}

export interface WorkSessionsResponse {
  sessions: WorkSession[];
}

export interface AgentTodo {
  id: string;
  text: string;
  done: boolean;
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
  return readJson(await fetch(`${API_BASE}/providers`));
}

export async function startProviderAuth(providerId: string): Promise<{ sessionId: string }> {
  const res = await fetch(`${API_BASE}/auth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId }),
  });
  return readJson(res);
}

export async function fetchProviderAuthSession(id: string): Promise<{ session: ProviderAuthSession }> {
  return readJson(await fetch(`${API_BASE}/auth/session?id=${encodeURIComponent(id)}`));
}

export async function respondProviderAuthSession(sessionId: string, value: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/auth/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, value }),
  });
  return readJson(res);
}

export async function fetchGithubAuthStatus(): Promise<GithubAuthStatusResponse> {
  return readJson(await fetch(`${API_BASE}/github/auth/status`));
}

export async function startGithubDeviceAuth(payload?: {
  clientId?: string;
  scopes?: string[];
}): Promise<{ sessionId: string; session: GithubDeviceAuthSession }> {
  const res = await fetch(`${API_BASE}/github/auth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  return readJson(res);
}

export async function fetchGithubDeviceAuthSession(id: string): Promise<{ session: GithubDeviceAuthSession }> {
  return readJson(await fetch(`${API_BASE}/github/auth/session?id=${encodeURIComponent(id)}`));
}

export async function fetchModels(provider: string): Promise<{ provider: string; models: string[] }> {
  return readJson(await fetch(`${API_BASE}/models?provider=${encodeURIComponent(provider)}`));
}

export async function fetchWorkspaces(): Promise<WorkspacesResponse> {
  return readJson(await fetch(`${API_BASE}/workspaces`));
}

export async function fetchUiPreferences(): Promise<{ preferences: UiPreferences }> {
  return readJson(await fetch(`${API_BASE}/ui/preferences`));
}

export async function updateUiPreferences(patch: Partial<UiPreferences>): Promise<{ preferences: UiPreferences }> {
  const res = await fetch(`${API_BASE}/ui/preferences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return readJson(res);
}

export async function fetchSessions(): Promise<WorkSessionsResponse> {
  return readJson(await fetch(`${API_BASE}/work`));
}

export async function fetchWorkAgent(id: string): Promise<WorkAgentResponse> {
  return readJson(await fetch(`${API_BASE}/work/agent?id=${encodeURIComponent(id)}`));
}

export async function fetchWorkTools(
  id: string,
  mode?: 'chat' | 'planning' | 'implementation',
): Promise<WorkToolsResponse> {
  const params = new URLSearchParams({ id });
  if (mode) {
    params.set('mode', mode);
  }
  return readJson(await fetch(`${API_BASE}/work/tools?${params.toString()}`));
}

export async function startWork(payload: {
  workspaceId: string;
  prompt: string;
  provider: string;
  model?: string;
  autoApprove: boolean;
  useWorktree?: boolean;
  adaptiveConcurrency?: boolean;
  batchConcurrency?: number;
  batchMinConcurrency?: number;
  promptParts?: ChatContentPart[];
}): Promise<{ id: string }> {
  const res = await fetch(`${API_BASE}/work/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return readJson(res);
}

export async function deleteWork(id: string): Promise<{ ok: boolean; id: string }> {
  const res = await fetch(`${API_BASE}/work/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return readJson(res);
}

export async function cancelWork(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/work/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return readJson(res);
}

export async function retryWork(
  id: string,
  payload?: { followUp?: string; followUpParts?: ChatContentPart[] },
): Promise<{ id: string; sourceId: string }> {
  const res = await fetch(`${API_BASE}/work/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      followUp: payload?.followUp,
      followUpParts: payload?.followUpParts,
    }),
  });
  return readJson(res);
}

export async function sendChatMessage(
  id: string,
  payload: { message: string; messageParts?: ChatContentPart[] },
): Promise<{ ok: boolean; messages: ChatMessage[] }> {
  const res = await fetch(`${API_BASE}/work/chat/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, message: payload.message, messageParts: payload.messageParts }),
  });
  return readJson(res);
}

export async function addTodo(id: string, text: string): Promise<{ ok: boolean; todos: AgentTodo[] }> {
  const res = await fetch(`${API_BASE}/work/todos/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, text }),
  });
  return readJson(res);
}

export async function toggleTodo(id: string, todoId: string, done: boolean): Promise<{ ok: boolean; todos: AgentTodo[] }> {
  const res = await fetch(`${API_BASE}/work/todos/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, todoId, done }),
  });
  return readJson(res);
}
