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

export interface Workspace {
  id: string;
  name: string;
  path: string;
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
  createdAt: string;
  updatedAt: string;
  status: string;
  taskStatus: Record<string, string>;
  events: Array<{ time: string; type: string; taskId?: string; message: string }>;
  agentGraph?: Array<{ id: string; prompt: string; dependencies: string[] }>;
  output?: { text?: string; planPath?: string };
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

export async function fetchModels(provider: string): Promise<{ provider: string; models: string[] }> {
  return readJson(await fetch(`${API_BASE}/models?provider=${encodeURIComponent(provider)}`));
}

export async function fetchWorkspaces(): Promise<WorkspacesResponse> {
  return readJson(await fetch(`${API_BASE}/workspaces`));
}

export async function fetchSessions(): Promise<WorkSessionsResponse> {
  return readJson(await fetch(`${API_BASE}/work`));
}

export async function fetchWorkAgent(id: string): Promise<WorkAgentResponse> {
  return readJson(await fetch(`${API_BASE}/work/agent?id=${encodeURIComponent(id)}`));
}

export async function startWork(payload: {
  workspaceId: string;
  prompt: string;
  provider: string;
  model: string;
  autoApprove: boolean;
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
