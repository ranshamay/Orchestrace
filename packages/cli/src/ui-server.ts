import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { orchestrate } from '@orchestrace/core';
import type { DagEvent, PlanApprovalRequest, TaskGraph } from '@orchestrace/core';
import { getModels } from '@mariozechner/pi-ai';
import { PiAiAdapter, ProviderAuthManager, type LlmPromptInput, type LlmPromptPart } from '@orchestrace/provider';
import { createAgentToolset } from '@orchestrace/tools';
import { WorkspaceManager } from './workspace-manager.js';

export interface UiServerOptions {
  port?: number;
  workspace?: string;
  hmr?: boolean;
}

type WorkState = 'running' | 'completed' | 'failed' | 'cancelled';

interface WorkSession {
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
  status: WorkState;
  taskStatus: Record<string, string>;
  events: UiDagEvent[];
  agentGraph: SessionAgentGraphNode[];
  error?: string;
  output?: { text?: string; planPath?: string };
  controller: AbortController;
}

interface SessionAgentGraphNode {
  id: string;
  prompt: string;
  dependencies: string[];
  provider?: string;
  model?: string;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
}

interface UiDagEvent {
  time: string;
  type: DagEvent['type'];
  taskId?: string;
  message: string;
}

type AuthSessionState = 'running' | 'awaiting-auth' | 'awaiting-input' | 'completed' | 'failed';

interface AuthSession {
  id: string;
  providerId: string;
  state: AuthSessionState;
  createdAt: string;
  updatedAt: string;
  authUrl?: string;
  authInstructions?: string;
  promptMessage?: string;
  promptPlaceholder?: string;
  error?: string;
  resolveInput?: (value: string) => void;
}

type ChatRole = 'user' | 'assistant' | 'system';

type SessionChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; name?: string };

interface SessionChatMessage {
  role: ChatRole;
  content: string;
  contentParts?: SessionChatContentPart[];
  time: string;
  usage?: { input: number; output: number; cost: number };
}

interface SessionChatThread {
  sessionId: string;
  provider: string;
  model: string;
  workspacePath: string;
  taskPrompt: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionChatMessage[];
}

interface AgentTodoItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ChatTokenStream {
  id: string;
  sessionId: string;
  status: 'running' | 'completed' | 'failed';
  replyText: string;
  usage?: { input: number; output: number; cost: number };
  usageEstimated?: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface PersistedWorkSession {
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
  status: WorkState;
  taskStatus: Record<string, string>;
  events: UiDagEvent[];
  agentGraph?: SessionAgentGraphNode[];
  error?: string;
  output?: { text?: string; planPath?: string };
}

interface PersistedUiState {
  version: 1;
  updatedAt: string;
  sessions: PersistedWorkSession[];
  chats: SessionChatThread[];
  todos: Array<{ sessionId: string; items: AgentTodoItem[] }>;
}

export async function startUiServer(options: UiServerOptions = {}): Promise<void> {
  const port = options.port ?? 4310;
  const hmrEnabled = options.hmr ?? process.env.ORCHESTRACE_UI_HMR !== 'false';
  const workspaceManager = new WorkspaceManager(process.cwd());
  if (options.workspace) {
    await workspaceManager.selectWorkspace(options.workspace);
  }

  const authManager = new ProviderAuthManager();
  const llm = new PiAiAdapter();

  const workSessions = new Map<string, WorkSession>();
  const authSessions = new Map<string, AuthSession>();
  const sessionChats = new Map<string, SessionChatThread>();
  const sessionTodos = new Map<string, AgentTodoItem[]>();
  const chatStreams = new Map<string, ChatTokenStream>();
  const hmrClients = new Set<ServerResponse>();
  const workStreamClients = new Map<string, Set<ServerResponse>>();
  const chatStreamClients = new Map<string, Set<ServerResponse>>();
  const uiStatePath = join(workspaceManager.getRootDir(), '.orchestrace', 'ui-state.json');

  await restoreUiState(uiStatePath, workSessions, sessionChats, sessionTodos);

  const uiStatePersistence = createUiStatePersistence(uiStatePath, workSessions, sessionChats, sessionTodos);

  function deleteWorkSession(id: string): boolean {
    const session = workSessions.get(id);
    if (!session) {
      return false;
    }

    if (session.status === 'running') {
      session.controller.abort();
      session.status = 'cancelled';
      session.updatedAt = now();
    }

    closeWorkStream(workStreamClients, id);
    workSessions.delete(id);
    sessionChats.delete(id);
    sessionTodos.delete(id);

    for (const [streamId, streamState] of [...chatStreams.entries()]) {
      if (streamState.sessionId !== id) {
        continue;
      }

      closeWorkStream(chatStreamClients, streamId);
      chatStreams.delete(streamId);
    }

    uiStatePersistence.schedule();
    return true;
  }

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

      if (req.method === 'GET' && pathname === '/') {
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

        sendSse(res, 'ready', {
          id,
          status: session.status,
          todos: (sessionTodos.get(id) ?? []).map((item) => ({ ...item })),
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

      if (req.method === 'GET' && pathname === '/api/models') {
        const provider = asString(url.searchParams.get('provider'));
        if (!provider) {
          sendJson(res, 400, { error: 'Missing provider query parameter' });
          return;
        }

        const providerStatuses = await authManager.getAllStatus();
        const providerStatus = providerStatuses.find((item) => item.provider === provider);
        if (!providerStatus || providerStatus.source === 'none') {
          sendJson(res, 403, { error: `Provider ${provider} is not connected. Connect it in Settings first.` });
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

      if (req.method === 'POST' && pathname === '/api/work/start') {
        const body = await readJsonBody(req);
        const workspaceId = asString(body.workspaceId);
        const prompt = asString(body.prompt);
        const promptParts = parseChatContentParts(body.promptParts);
        const provider = asString(body.provider) || process.env.ORCHESTRACE_DEFAULT_PROVIDER || 'anthropic';
        const model = asString(body.model) || process.env.ORCHESTRACE_DEFAULT_MODEL || 'claude-sonnet-4-20250514';
        const autoApprove = Boolean(body.autoApprove);

        const providerStatuses = await authManager.getAllStatus();
        const providerStatus = providerStatuses.find((item) => item.provider === provider);
        if (!providerStatus || providerStatus.source === 'none') {
          sendJson(res, 400, { error: `Provider ${provider} is not connected. Connect it in Settings first.` });
          return;
        }

        const workspace = workspaceId
          ? await workspaceManager.selectWorkspace(workspaceId)
          : await workspaceManager.getActiveWorkspace();

        if (!prompt && promptParts.length === 0) {
          sendJson(res, 400, { error: 'Missing prompt' });
          return;
        }

        const normalizedPrompt = prompt || summarizeChatContentParts(promptParts);

        const id = randomUUID();
        const controller = new AbortController();
        const session: WorkSession = {
          id,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspacePath: workspace.path,
          prompt: normalizedPrompt,
          provider,
          model,
          autoApprove,
          createdAt: now(),
          updatedAt: now(),
          status: 'running',
          taskStatus: {},
          events: [],
          agentGraph: [],
          controller,
        };

        workSessions.set(id, session);
  sessionChats.set(id, createSessionChatThread(session, promptParts));
        sessionTodos.set(id, []);
        uiStatePersistence.schedule();
        broadcastTodoUpdate(workStreamClients, id, sessionTodos.get(id) ?? []);

  const graph = buildSingleTaskGraph(id, normalizedPrompt);

        void orchestrate(graph, {
          llm,
          cwd: workspace.path,
          planOutputDir: join(workspace.path, '.orchestrace', 'plans'),
          defaultModel: { provider, model },
          maxParallel: 1,
          requirePlanApproval: !autoApprove,
          onPlanApproval: async (_request: PlanApprovalRequest) => autoApprove,
          signal: controller.signal,
          resolveApiKey: async (providerId) => authManager.resolveApiKey(providerId),
          createToolset: ({ phase, task, graphId, provider: activeProvider, model: activeModel, reasoning }) => createAgentToolset({
            cwd: workspace.path,
            phase,
            taskType: task.type,
            graphId,
            taskId: task.id,
            provider: activeProvider,
            model: activeModel,
            reasoning,
            runSubAgent: async (request, signal) => {
              const subProvider = request.provider ?? activeProvider;
              const subModel = request.model ?? activeModel;
              const subAgent = await llm.spawnAgent({
                provider: subProvider,
                model: subModel,
                reasoning: request.reasoning ?? reasoning,
                systemPrompt: request.systemPrompt
                  ?? 'You are a focused sub-agent. Solve the given sub-task and return concise actionable output.',
                signal,
                apiKey: await authManager.resolveApiKey(subProvider),
              });

              const result = await subAgent.complete(request.prompt, signal);
              return {
                text: result.text,
                usage: result.usage,
              };
            },
          }),
          onEvent: (event) => {
            session.updatedAt = now();
            if (event.type === 'task:stream-delta') {
              broadcastWorkStream(workStreamClients, session.id, 'token', {
                id: session.id,
                taskId: event.taskId,
                phase: event.phase,
                attempt: event.attempt,
                delta: event.delta,
                time: now(),
              });
            }

            const uiEvent = toUiEvent(event);
            if (uiEvent) {
              session.events.push(uiEvent);
              if (session.events.length > 200) {
                session.events.shift();
              }
            }

            if (event.type === 'task:tool-call' && event.status === 'started') {
              const changed = applyChecklistFromToolEvent(session.id, event, sessionTodos);
              if (changed) {
                broadcastTodoUpdate(workStreamClients, session.id, sessionTodos.get(session.id) ?? []);
                uiStatePersistence.schedule();
              }

              const graphChanged = applyAgentGraphFromToolEvent(session, event);
              if (graphChanged) {
                uiStatePersistence.schedule();
              }
            }

            if (
              'taskId' in event
              && event.type !== 'task:stream-delta'
              && event.type !== 'task:tool-call'
            ) {
              session.taskStatus[event.taskId] = event.type;
            }

            if (event.type !== 'task:stream-delta') {
              uiStatePersistence.schedule();
            }
          },
        }).then((outputs) => {
          if (session.status === 'cancelled') {
            return;
          }

          const firstOutput = outputs.values().next().value as { status?: string; response?: string; planPath?: string; error?: string } | undefined;
          const failed = [...outputs.values()].some((output) => output.status === 'failed');

          session.status = failed ? 'failed' : 'completed';
          session.output = {
            text: firstOutput?.response,
            planPath: firstOutput?.planPath,
          };
          session.error = failed ? firstOutput?.error ?? 'Execution failed' : undefined;
          session.updatedAt = now();

          broadcastWorkStream(workStreamClients, session.id, 'end', {
            id: session.id,
            status: session.status,
            time: now(),
          });

          const thread = sessionChats.get(session.id);
          if (thread && firstOutput?.response) {
            thread.messages.push({
              role: 'assistant',
              content: firstOutput.response,
              time: now(),
            });
            trimThreadMessages(thread);
            thread.updatedAt = now();
          }

          uiStatePersistence.schedule();
        }).catch((error) => {
          if (session.status !== 'cancelled') {
            session.status = 'failed';
            session.error = toErrorMessage(error);
            session.updatedAt = now();

            broadcastWorkStream(workStreamClients, session.id, 'error', {
              id: session.id,
              error: session.error,
              time: now(),
            });
            uiStatePersistence.schedule();
          }
        });

        sendJson(res, 200, { id });
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
          session.controller.abort();
          session.status = 'cancelled';
          session.updatedAt = now();

          broadcastWorkStream(workStreamClients, session.id, 'end', {
            id: session.id,
            status: session.status,
            time: now(),
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
        const sessions = [...workSessions.values()]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(serializeWorkSession);
        sendJson(res, 200, { sessions });
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
          session: serializeWorkSession(session),
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
          done: false,
          createdAt: now(),
          updatedAt: now(),
        };

        items.push(todo);
        sessionTodos.set(id, items);
        session.updatedAt = now();
        uiStatePersistence.schedule();
        broadcastTodoUpdate(workStreamClients, id, items);

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
        target.updatedAt = now();
        session.updatedAt = now();
        uiStatePersistence.schedule();
        broadcastTodoUpdate(workStreamClients, id, items);

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

        const providerStatuses = await authManager.getAllStatus();
        const providerStatus = providerStatuses.find((item) => item.provider === session.provider);
        if (!providerStatus || providerStatus.source === 'none') {
          sendJson(res, 400, { error: `Provider ${session.provider} is not connected. Connect it in Settings first.` });
          return;
        }

        const thread = sessionChats.get(id) ?? createSessionChatThread(session);
        sessionChats.set(id, thread);

        const userMessage = createSessionChatMessage('user', message, messageParts);
        thread.messages.push(userMessage);
        trimThreadMessages(thread);
        thread.updatedAt = now();
        uiStatePersistence.schedule();

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
            const chatAgent = await llm.spawnAgent({
              provider: session.provider,
              model: session.model,
              systemPrompt: buildChatSystemPrompt(session),
              toolset: createAgentToolset({ cwd: session.workspacePath, phase: 'chat' }),
              apiKey: await authManager.resolveApiKey(session.provider),
            });

            const chatPrompt = buildChatContinuationInput(thread);
            const response = await chatAgent.complete(chatPrompt, undefined, {
              onTextDelta: (delta) => {
                if (!delta) {
                  return;
                }

                streamState.replyText += delta;
                streamState.updatedAt = now();

                const estimatedOutput = estimateTokensFromText(streamState.replyText);
                streamState.usage = {
                  input: streamState.usage?.input ?? 0,
                  output: estimatedOutput,
                  cost: streamState.usage?.cost ?? 0,
                };
                streamState.usageEstimated = true;

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
            });

            const assistantMessage: SessionChatMessage = {
              role: 'assistant',
              content: response.text,
              time: now(),
              usage: response.usage,
            };

            thread.messages.push(assistantMessage);
            trimThreadMessages(thread);
            thread.updatedAt = now();
            session.updatedAt = now();
            uiStatePersistence.schedule();

            streamState.status = 'completed';
            streamState.replyText = response.text;
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
            uiStatePersistence.schedule();

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

        const providerStatuses = await authManager.getAllStatus();
        const providerStatus = providerStatuses.find((item) => item.provider === session.provider);
        if (!providerStatus || providerStatus.source === 'none') {
          sendJson(res, 400, { error: `Provider ${session.provider} is not connected. Connect it in Settings first.` });
          return;
        }

        const thread = sessionChats.get(id) ?? createSessionChatThread(session);
        sessionChats.set(id, thread);
        uiStatePersistence.schedule();

        const userMessage = createSessionChatMessage('user', message, messageParts);
        thread.messages.push(userMessage);
        trimThreadMessages(thread);
        thread.updatedAt = now();
        uiStatePersistence.schedule();

        const chatAgent = await llm.spawnAgent({
          provider: session.provider,
          model: session.model,
          systemPrompt: buildChatSystemPrompt(session),
          toolset: createAgentToolset({ cwd: session.workspacePath, phase: 'chat' }),
          apiKey: await authManager.resolveApiKey(session.provider),
        });

        const chatPrompt = buildChatContinuationInput(thread);
        const response = await chatAgent.complete(chatPrompt);
        const text = response.text;

        const assistantMessage: SessionChatMessage = {
          role: 'assistant',
          content: text,
          time: now(),
          usage: response.usage,
        };

        thread.messages.push(assistantMessage);
        trimThreadMessages(thread);
        thread.updatedAt = now();
        session.updatedAt = now();
        uiStatePersistence.schedule();

        sendJson(res, 200, {
          ok: true,
          reply: assistantMessage,
          messages: thread.messages.filter((entry) => entry.role !== 'system'),
        });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(res, 500, { error: toErrorMessage(error) });
    }
  });

  await new Promise<void>((resolvePromise) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`UI server listening on http://127.0.0.1:${port}`);
      if (hmrEnabled) {
        console.log('UI HMR enabled (live reload).');
      }
      resolvePromise();
    });
  });

  server.on('close', () => {
    void uiStatePersistence.flush();
    hmrWatcher?.close();
    hmrClients.clear();
    for (const [id] of workStreamClients) {
      closeWorkStream(workStreamClients, id);
    }
    for (const [id] of chatStreamClients) {
      closeWorkStream(chatStreamClients, id);
    }
  });
}

function sendSse(res: ServerResponse, event: string, payload: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function broadcastWorkStream(
  streams: Map<string, Set<ServerResponse>>,
  id: string,
  event: string,
  payload: unknown,
): void {
  const clients = streams.get(id);
  if (!clients || clients.size === 0) {
    return;
  }

  for (const client of [...clients]) {
    try {
      sendSse(client, event, payload);
    } catch {
      clients.delete(client);
    }
  }

  if (clients.size === 0) {
    streams.delete(id);
  }
}

function closeWorkStream(streams: Map<string, Set<ServerResponse>>, id: string): void {
  const clients = streams.get(id);
  if (!clients) {
    return;
  }

  for (const client of clients) {
    try {
      client.end();
    } catch {
      // ignore close errors
    }
  }
  streams.delete(id);
}

function broadcastTodoUpdate(
  streams: Map<string, Set<ServerResponse>>,
  id: string,
  todos: AgentTodoItem[],
): void {
  broadcastWorkStream(streams, id, 'todo-update', {
    id,
    todos: todos.map((item) => ({ ...item })),
    time: now(),
  });
}

function estimateTokensFromText(text: string): number {
  // Rough heuristic for real-time UI counters until provider returns final usage.
  if (!text) {
    return 0;
  }

  return Math.max(1, Math.ceil(text.length / 4));
}

function scheduleChatStreamCleanup(streams: Map<string, ChatTokenStream>, streamId: string, ttlMs = 60_000): void {
  setTimeout(() => {
    streams.delete(streamId);
  }, ttlMs);
}

function createUiStatePersistence(
  path: string,
  workSessions: Map<string, WorkSession>,
  sessionChats: Map<string, SessionChatThread>,
  sessionTodos: Map<string, AgentTodoItem[]>,
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
        await persistUiState(path, workSessions, sessionChats, sessionTodos);
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
): Promise<void> {
  const payload = await readPersistedUiState(path);
  if (!payload) {
    return;
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
          done: Boolean(item.done),
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
}

async function persistUiState(
  path: string,
  workSessions: Map<string, WorkSession>,
  sessionChats: Map<string, SessionChatThread>,
  sessionTodos: Map<string, AgentTodoItem[]>,
): Promise<void> {
  const payload: PersistedUiState = {
    version: 1,
    updatedAt: now(),
    sessions: [...workSessions.values()]
      .map(toPersistedSession)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    chats: [...sessionChats.values()]
      .map((thread) => ({
        ...thread,
        messages: [...thread.messages],
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    todos: [...sessionTodos.entries()]
      .map(([sessionId, items]) => ({
        sessionId,
        items: items.map((item) => ({ ...item })),
      }))
      .sort((a, b) => b.sessionId.localeCompare(a.sessionId)),
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf-8');
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
    };
  } catch {
    return undefined;
  }
}

function toPersistedSession(session: WorkSession): PersistedWorkSession {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    workspaceName: session.workspaceName,
    workspacePath: session.workspacePath,
    prompt: session.prompt,
    provider: session.provider,
    model: session.model,
    autoApprove: session.autoApprove,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status,
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

  return {
    ...session,
    agentGraph: normalizeSessionAgentGraphNodes(session.agentGraph),
    status: resumedStatus,
    error: resumedError,
    controller: new AbortController(),
  };
}

function now(): string {
  return new Date().toISOString();
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

function buildSingleTaskGraph(id: string, prompt: string): TaskGraph {
  const verifyCommands = parseVerifyCommands();

  return {
    id: `ui-${id}`,
    name: 'UI Work Session',
    nodes: [
      {
        id: 'task',
        name: 'Execute UI prompt',
        type: 'code',
        prompt,
        dependencies: [],
        validation: {
          commands: verifyCommands,
          maxRetries: 2,
          retryDelayMs: 0,
        },
      },
    ],
  };
}

function parseVerifyCommands(): string[] {
  const raw = process.env.ORCHESTRACE_VERIFY_COMMANDS;
  if (!raw) {
    return ['pnpm typecheck', 'pnpm test'];
  }

  return raw
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function toUiEvent(event: DagEvent): UiDagEvent | undefined {
  const base = { time: now(), type: event.type, taskId: 'taskId' in event ? event.taskId : undefined };

  switch (event.type) {
    case 'task:planning':
      return { ...base, message: `${event.taskId}: planning` };
    case 'task:plan-persisted':
      return { ...base, message: `${event.taskId}: plan persisted at ${event.path}` };
    case 'task:approval-requested':
      return { ...base, message: `${event.taskId}: approval requested` };
    case 'task:approved':
      return { ...base, message: `${event.taskId}: approved` };
    case 'task:implementation-attempt':
      return { ...base, message: `${event.taskId}: implementation attempt ${event.attempt}/${event.maxAttempts}` };
    case 'task:tool-call': {
      if (event.status === 'started') {
        return {
          ...base,
          message: `${event.taskId}: tool ${event.toolName} input ${previewToolLog(event.input)}`,
        };
      }

      const errorSuffix = event.isError ? ' [error]' : '';
      return {
        ...base,
        message: `${event.taskId}: tool ${event.toolName} output${errorSuffix} ${previewToolLog(event.output)}`,
      };
    }
    case 'task:verification-failed':
      return { ...base, message: `${event.taskId}: verification failed` };
    case 'task:ready':
      return { ...base, message: `${event.taskId}: ready` };
    case 'task:started':
      return { ...base, message: `${event.taskId}: started` };
    case 'task:validating':
      return { ...base, message: `${event.taskId}: validating` };
    case 'task:completed':
      return { ...base, message: `${event.taskId}: completed` };
    case 'task:failed':
      return { ...base, message: `${event.taskId}: failed (${event.error})` };
    case 'graph:completed':
      return { ...base, message: `graph completed (${event.outputs.size} outputs)` };
    case 'graph:failed':
      return { ...base, message: `graph failed (${event.error})` };
    case 'task:retrying':
      return { ...base, message: `${event.taskId}: retrying ${event.attempt}/${event.maxRetries}` };
    default:
      return undefined;
  }
}

function previewToolLog(value: string | undefined): string {
  if (!value) {
    return '(empty)';
  }

  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '(blank)';
  }

  return compact.length > 600 ? `${compact.slice(0, 597)}...` : compact;
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
        const status = asString(item.status);
        const previous = existing.find((entry) => entry.id === id);
        return {
          id,
          text: compactTodoText(title, item.details),
          done: status === 'done',
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
    const status = asString(args.status);
    const next = existing.filter((item) => item.id !== id);
    next.push({
      id,
      text: compactTodoText(title, args.details),
      done: status === 'done',
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
  const status = asString(args.status);
  const title = asString(args.title);
  const details = asString(args.details);
  const appendDetails = asString(args.appendDetails);

  if (index < 0) {
    const fallbackText = compactTodoText(title || `Todo ${id}`, details || appendDetails);
    const created: AgentTodoItem = {
      id,
      text: fallbackText,
      done: status === 'done',
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
    updatedAt: nowTime,
  };

  const next = [...existing];
  next[index] = updated;
  sessionTodos.set(sessionId, next);
  return true;
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

  if (toolName === 'todo_update') {
    if (!id) {
      return undefined;
    }

    return {
      id,
      status,
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

  session.agentGraph = nodes;
  return true;
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
      prompt,
      dependencies,
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

function serializeWorkSession(session: WorkSession): Record<string, unknown> {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    workspaceName: session.workspaceName,
    workspacePath: session.workspacePath,
    prompt: session.prompt,
    provider: session.provider,
    model: session.model,
    autoApprove: session.autoApprove,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status,
    taskStatus: session.taskStatus,
    events: session.events,
    agentGraph: session.agentGraph.map((node) => ({
      ...node,
      dependencies: [...node.dependencies],
    })),
    error: session.error,
    output: session.output,
  };
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

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function createSessionChatThread(session: WorkSession): SessionChatThread {
  const created = now();
  return {
    sessionId: session.id,
    provider: session.provider,
    model: session.model,
    workspacePath: session.workspacePath,
    taskPrompt: session.prompt,
    createdAt: created,
    updatedAt: created,
    messages: [
      {
        role: 'user',
        content: `Initial task prompt:\n${session.prompt}`,
        time: created,
      },
    ],
  };
}

function buildChatSystemPrompt(session: WorkSession): string {
  return [
    'You are continuing an existing Orchestrace agent session.',
    'Keep continuity with prior messages and avoid repeating completed work.',
    `Workspace: ${session.workspacePath}`,
    `Provider/Model: ${session.provider}/${session.model}`,
    `Original task prompt: ${session.prompt}`,
  ].join('\n');
}

function buildChatContinuationPrompt(thread: SessionChatThread): string {
  const turns = thread.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join('\n\n');

  return [
    'Continue this conversation with full continuity.',
    'Conversation so far:',
    turns || '(no previous turns)',
    '',
    'Reply as ASSISTANT and continue from the latest user message.',
  ].join('\n');
}

function trimThreadMessages(thread: SessionChatThread, maxMessages = 80): void {
  if (thread.messages.length <= maxMessages) {
    return;
  }

  thread.messages.splice(0, thread.messages.length - maxMessages);
}
