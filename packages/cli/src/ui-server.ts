import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { orchestrate } from '@orchestrace/core';
import type { DagEvent, PlanApprovalRequest, TaskGraph } from '@orchestrace/core';
import { getModels } from '@mariozechner/pi-ai';
import { PiAiAdapter, ProviderAuthManager } from '@orchestrace/provider';
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

interface SessionChatMessage {
  role: ChatRole;
  content: string;
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

        if (!prompt) {
          sendJson(res, 400, { error: 'Missing prompt' });
          return;
        }

        const id = randomUUID();
        const controller = new AbortController();
        const session: WorkSession = {
          id,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspacePath: workspace.path,
          prompt,
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
        sessionChats.set(id, createSessionChatThread(session));
        sessionTodos.set(id, []);
        uiStatePersistence.schedule();
        broadcastTodoUpdate(workStreamClients, id, sessionTodos.get(id) ?? []);

        const graph = buildSingleTaskGraph(id, prompt);

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

        if (!id) {
          sendJson(res, 400, { error: 'Missing id' });
          return;
        }

        if (!message) {
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

        const userMessage: SessionChatMessage = {
          role: 'user',
          content: message,
          time: now(),
        };
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

            const chatPrompt = buildChatContinuationPrompt(thread);
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

        if (!id) {
          sendJson(res, 400, { error: 'Missing id' });
          return;
        }

        if (!message) {
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

        const userMessage: SessionChatMessage = {
          role: 'user',
          content: message,
          time: now(),
        };
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

        const chatPrompt = buildChatContinuationPrompt(thread);
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
  <title>Orchestrace Graph Console</title>
  <style>
    :root {
      --font-ui: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
      --font-mono: "JetBrains Mono", "SF Mono", Menlo, monospace;
      --bg: #f2f4f7;
      --bg-2: #e9eef5;
      --card: rgba(255, 255, 255, 0.82);
      --ink: #0f1728;
      --muted: #5d6b86;
      --border: rgba(93, 107, 134, 0.22);
      --accent: #0e7490;
      --accent-2: #155eef;
      --danger: #d92d20;
      --ok: #099250;
      --warn: #b54708;
      --shadow: 0 10px 30px rgba(14, 18, 33, 0.12);
      --graph-grid: rgba(14, 116, 144, 0.12);
      --running-glow: rgba(21, 94, 239, 0.4);
    }

    body[data-theme="dark"] {
      --bg: #0a101b;
      --bg-2: #131d30;
      --card: rgba(12, 18, 30, 0.78);
      --ink: #edf2ff;
      --muted: #8f9fbd;
      --border: rgba(143, 159, 189, 0.24);
      --accent: #36bffa;
      --accent-2: #7aa2ff;
      --danger: #f97066;
      --ok: #32d583;
      --warn: #fdb022;
      --shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
      --graph-grid: rgba(54, 191, 250, 0.14);
      --running-glow: rgba(54, 191, 250, 0.5);
    }

    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }

    body {
      font-family: var(--font-ui);
      color: var(--ink);
      background:
        radial-gradient(1200px 500px at 15% -20%, rgba(21, 94, 239, 0.2), transparent),
        radial-gradient(900px 600px at 90% -30%, rgba(14, 116, 144, 0.24), transparent),
        linear-gradient(160deg, var(--bg), var(--bg-2));
      transition: background 240ms ease, color 240ms ease;
    }

    .shell {
      max-width: 1280px;
      margin: 20px auto;
      padding: 0 16px 18px;
      display: grid;
      grid-template-columns: minmax(320px, 420px) 1fr;
      gap: 14px;
    }

    @media (max-width: 1040px) {
      .shell {
        grid-template-columns: 1fr;
      }

      .screen {
        grid-template-columns: 1fr;
      }
    }

    .panel {
      border: 1px solid var(--border);
      border-radius: 18px;
      backdrop-filter: blur(14px);
      background: var(--card);
      box-shadow: var(--shadow);
      padding: 14px;
      transition: transform 220ms ease, border-color 220ms ease, box-shadow 220ms ease;
    }

    .panel:hover {
      transform: translateY(-1px);
      border-color: rgba(21, 94, 239, 0.36);
    }

    .screen-nav {
      grid-column: 1 / -1;
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .screen-nav button.active {
      background: linear-gradient(130deg, var(--accent), var(--accent-2));
      color: #fff;
      border-color: transparent;
    }

    .screen {
      grid-column: 1 / -1;
      display: none;
      grid-template-columns: minmax(320px, 420px) 1fr;
      gap: 14px;
    }

    .screen.active {
      display: grid;
    }

    .full-span {
      grid-column: 1 / -1;
    }

    .hero {
      grid-column: 1 / -1;
      display: flex;
      gap: 12px;
      justify-content: space-between;
      align-items: center;
      padding: 14px 16px;
    }

    .title-wrap h1 {
      margin: 0;
      font-size: 22px;
      letter-spacing: 0.2px;
    }

    .title-wrap p {
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 13px;
    }

    .theme-switch {
      display: inline-flex;
      border: 1px solid var(--border);
      border-radius: 999px;
      overflow: hidden;
      background: rgba(255, 255, 255, 0.35);
    }

    .theme-switch button {
      border: none;
      background: transparent;
      color: var(--muted);
      font-size: 12px;
      padding: 7px 12px;
      cursor: pointer;
      transition: color 180ms ease, background 180ms ease;
    }

    .theme-switch button.active {
      background: var(--accent-2);
      color: white;
    }

    .section-title {
      margin: 0 0 10px;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.2px;
    }

    .muted {
      color: var(--muted);
      font-size: 12px;
    }

    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .grid .full {
      grid-column: 1 / -1;
    }

    input, select, textarea {
      width: 100%;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.72);
      color: var(--ink);
      font-family: var(--font-ui);
      font-size: 13px;
      padding: 10px 11px;
      transition: border-color 180ms ease, box-shadow 180ms ease, transform 180ms ease;
    }

    body[data-theme="dark"] input,
    body[data-theme="dark"] select,
    body[data-theme="dark"] textarea {
      background: rgba(13, 20, 34, 0.78);
    }

    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: var(--accent-2);
      box-shadow: 0 0 0 3px rgba(21, 94, 239, 0.18);
    }

    textarea {
      min-height: 90px;
      resize: vertical;
    }

    label {
      display: block;
      margin: 2px 0 5px;
      font-size: 12px;
      color: var(--muted);
      letter-spacing: 0.14px;
    }

    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    button {
      border: 1px solid transparent;
      border-radius: 12px;
      font-family: var(--font-ui);
      font-weight: 700;
      font-size: 12px;
      letter-spacing: 0.18px;
      padding: 10px 12px;
      cursor: pointer;
      transition: transform 160ms ease, box-shadow 180ms ease, background 180ms ease, border-color 180ms ease;
    }

    button:hover {
      transform: translateY(-1px);
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }

    button.primary {
      background: linear-gradient(130deg, var(--accent), var(--accent-2));
      color: #fff;
      box-shadow: 0 10px 20px rgba(14, 116, 144, 0.26);
    }

    button.secondary {
      background: transparent;
      border-color: var(--border);
      color: var(--ink);
    }

    button.danger {
      background: transparent;
      border-color: rgba(217, 45, 32, 0.45);
      color: var(--danger);
    }

    .status-note {
      margin-top: 8px;
      min-height: 18px;
      font-size: 12px;
      color: var(--muted);
    }

    .auth-console,
    .events {
      margin-top: 10px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.56);
      padding: 10px;
      max-height: 180px;
      overflow: auto;
      font-family: var(--font-mono);
      font-size: 11px;
      white-space: pre-wrap;
      line-height: 1.48;
    }

    body[data-theme="dark"] .auth-console,
    body[data-theme="dark"] .events {
      background: rgba(8, 12, 21, 0.72);
    }

    .readiness-list {
      margin-top: 10px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.56);
      padding: 10px;
      max-height: 200px;
      overflow: auto;
      font-size: 12px;
      line-height: 1.45;
    }

    body[data-theme="dark"] .readiness-list {
      background: rgba(8, 12, 21, 0.72);
    }

    .readiness-item {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 8px;
      margin-bottom: 8px;
    }

    .readiness-item:last-child {
      margin-bottom: 0;
    }

    .readiness-item.active {
      border-color: rgba(21, 94, 239, 0.42);
    }

    .graph-panel {
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 10px;
      min-height: 580px;
    }

    .graph-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 10px;
    }

    .graph-tools {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 11px;
      color: var(--muted);
    }

    .legend span::before {
      content: "";
      display: inline-block;
      width: 9px;
      height: 9px;
      border-radius: 999px;
      margin-right: 5px;
      vertical-align: middle;
    }

    .legend .running::before { background: var(--accent-2); }
    .legend .completed::before { background: var(--ok); }
    .legend .failed::before { background: var(--danger); }
    .legend .cancelled::before { background: var(--warn); }
    .legend .planned::before { background: var(--accent); }
    .legend .subagent::before { background: var(--accent); }

    .graph-wrap {
      border: 1px solid var(--border);
      border-radius: 16px;
      background:
        linear-gradient(90deg, var(--graph-grid) 1px, transparent 1px) 0 0/26px 26px,
        linear-gradient(var(--graph-grid) 1px, transparent 1px) 0 0/26px 26px,
        rgba(255, 255, 255, 0.36);
      overflow: auto;
      min-height: 260px;
      padding: 12px;
    }

    body[data-theme="dark"] .graph-wrap {
      background:
        linear-gradient(90deg, var(--graph-grid) 1px, transparent 1px) 0 0/26px 26px,
        linear-gradient(var(--graph-grid) 1px, transparent 1px) 0 0/26px 26px,
        rgba(7, 11, 20, 0.66);
    }

    svg {
      width: 100%;
      min-width: 620px;
      height: 280px;
    }

    .graph-edge {
      fill: none;
      stroke: var(--border);
      stroke-width: 2;
      opacity: 0.8;
      transition: stroke 220ms ease;
    }

    .graph-node {
      cursor: pointer;
    }

    .graph-node:hover .node-halo {
      stroke: var(--accent-2);
      opacity: 0.3;
    }

    .node-halo {
      fill: transparent;
      stroke: transparent;
      stroke-width: 8;
      transition: stroke 180ms ease;
    }

    .graph-node.selected .node-halo {
      stroke: var(--accent-2);
      opacity: 0.46;
    }

    .node-core {
      stroke: rgba(255, 255, 255, 0.5);
      stroke-width: 2;
      transition: fill 180ms ease;
    }

    .graph-node.status-running .node-core {
      fill: var(--accent-2);
      filter: drop-shadow(0 0 12px var(--running-glow));
      animation: pulse 1.5s ease-in-out infinite;
    }

    .graph-node.status-completed .node-core { fill: var(--ok); }
    .graph-node.status-failed .node-core { fill: var(--danger); }
    .graph-node.status-cancelled .node-core { fill: var(--warn); }
    .graph-node.status-planned .node-core { fill: var(--accent); }

    .node-label,
    .node-sub {
      fill: var(--ink);
      text-anchor: middle;
      pointer-events: none;
      font-family: var(--font-ui);
    }

    .node-label { font-size: 11px; font-weight: 700; }
    .node-sub { font-size: 10px; opacity: 0.72; }

    .session-list {
      display: grid;
      gap: 8px;
      max-height: 220px;
      overflow: auto;
      padding-right: 2px;
    }

    .session-item {
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px;
      background: rgba(255, 255, 255, 0.6);
      transition: transform 160ms ease, border-color 160ms ease, background 180ms ease;
    }

    body[data-theme="dark"] .session-item {
      background: rgba(8, 12, 21, 0.62);
    }

    .session-item.active {
      border-color: var(--accent-2);
      background: rgba(21, 94, 239, 0.08);
    }

    .session-item-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      margin-bottom: 6px;
    }

    .badge {
      border-radius: 999px;
      border: 1px solid var(--border);
      padding: 2px 8px;
      font-size: 10px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.16px;
    }

    .badge.running { color: var(--accent-2); border-color: rgba(21, 94, 239, 0.42); }
    .badge.completed { color: var(--ok); border-color: rgba(9, 146, 80, 0.42); }
    .badge.failed { color: var(--danger); border-color: rgba(217, 45, 32, 0.42); }
    .badge.cancelled { color: var(--warn); border-color: rgba(181, 71, 8, 0.42); }

    .session-item .meta {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 6px;
    }

    .session-item .prompt {
      font-size: 12px;
      color: var(--ink);
      margin-bottom: 8px;
    }

    .session-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .session-actions button {
      padding: 7px 9px;
      font-size: 11px;
    }

    .empty {
      border: 1px dashed var(--border);
      border-radius: 12px;
      padding: 22px;
      text-align: center;
      color: var(--muted);
      font-size: 12px;
    }

    .chat-thread {
      margin-top: 10px;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.52);
      min-height: 260px;
      max-height: 560px;
      overflow: auto;
      padding: 10px;
      display: grid;
      gap: 10px;
      align-content: start;
    }

    body[data-theme="dark"] .chat-thread {
      background: rgba(8, 12, 21, 0.72);
    }

    .chat-context {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: rgba(21, 94, 239, 0.08);
      padding: 10px 11px;
      display: grid;
      gap: 6px;
    }

    .chat-context .row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
      font-size: 11px;
      color: var(--muted);
    }

    .chat-context .prompt {
      font-size: 12px;
      line-height: 1.5;
      color: var(--ink);
      margin: 0;
    }

    .chat-events {
      border-top: 1px dashed var(--border);
      padding-top: 7px;
      display: grid;
      gap: 4px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--muted);
    }

    .chat-events div {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .chat-message {
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 10px 12px;
      background: rgba(255, 255, 255, 0.75);
      display: grid;
      gap: 8px;
      animation: chat-enter 180ms ease;
    }

    body[data-theme="dark"] .chat-message {
      background: rgba(10, 16, 29, 0.8);
    }

    .chat-message.role-user {
      border-color: rgba(14, 116, 144, 0.42);
      background: rgba(14, 116, 144, 0.09);
    }

    .chat-message.role-assistant {
      border-color: rgba(21, 94, 239, 0.3);
    }

    .chat-message.live {
      box-shadow: 0 0 0 1px rgba(21, 94, 239, 0.32), 0 8px 24px rgba(21, 94, 239, 0.16);
    }

    .chat-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      font-size: 11px;
      color: var(--muted);
    }

    .chat-role {
      color: var(--ink);
      font-weight: 700;
      letter-spacing: 0.14px;
    }

    .chat-time {
      font-family: var(--font-mono);
    }

    .chat-body {
      font-size: 13px;
      line-height: 1.56;
      color: var(--ink);
    }

    .chat-body h2,
    .chat-body h3,
    .chat-body h4 {
      margin: 4px 0 6px;
      line-height: 1.35;
    }

    .chat-body h2 { font-size: 15px; }
    .chat-body h3 { font-size: 14px; }
    .chat-body h4 { font-size: 13px; }

    .chat-body p {
      margin: 0;
    }

    .chat-body p + p {
      margin-top: 6px;
    }

    .chat-body ul,
    .chat-body ol {
      margin: 0;
      padding-left: 18px;
    }

    .chat-body blockquote {
      margin: 0;
      padding: 6px 10px;
      border-left: 3px solid var(--accent-2);
      color: var(--muted);
      background: rgba(21, 94, 239, 0.08);
      border-radius: 8px;
    }

    .chat-body pre {
      margin: 0;
      overflow: auto;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: rgba(7, 11, 20, 0.93);
      color: #e8edff;
      padding: 10px;
      font-family: var(--font-mono);
      font-size: 11.5px;
      line-height: 1.5;
      white-space: pre;
    }

    .chat-body .code-lang {
      color: #98a8c8;
      text-transform: lowercase;
      margin-bottom: 5px;
      font-size: 10px;
      letter-spacing: 0.22px;
    }

    .chat-inline-code {
      font-family: var(--font-mono);
      font-size: 11.5px;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 1px 4px;
      background: rgba(21, 94, 239, 0.08);
    }

    .chat-meta {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      align-items: center;
    }

    .chat-chip {
      font-size: 10px;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px 8px;
      color: var(--muted);
      background: rgba(255, 255, 255, 0.45);
    }

    body[data-theme="dark"] .chat-chip {
      background: rgba(10, 16, 29, 0.85);
    }

    .chat-chip.strong {
      color: var(--accent-2);
      border-color: rgba(21, 94, 239, 0.45);
    }

    .chat-chip.warn {
      color: var(--warn);
      border-color: rgba(181, 71, 8, 0.5);
    }

    .chat-chip.error {
      color: var(--danger);
      border-color: rgba(217, 45, 32, 0.52);
    }

    .todo-shell {
      margin-top: 10px;
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 10px;
      background: rgba(255, 255, 255, 0.56);
      display: grid;
      gap: 8px;
    }

    body[data-theme="dark"] .todo-shell {
      background: rgba(8, 12, 21, 0.72);
    }

    .todo-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }

    .todo-count {
      font-size: 11px;
      color: var(--muted);
      font-family: var(--font-mono);
    }

    .todo-input-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
    }

    .todo-list {
      max-height: 210px;
      overflow: auto;
      display: grid;
      gap: 6px;
      padding-right: 2px;
    }

    .todo-item {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 8px;
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 8px;
      background: rgba(255, 255, 255, 0.75);
    }

    body[data-theme="dark"] .todo-item {
      background: rgba(10, 16, 29, 0.84);
    }

    .todo-item.done {
      opacity: 0.72;
    }

    .todo-item .text {
      font-size: 12px;
      line-height: 1.45;
      word-break: break-word;
    }

    .todo-item.done .text {
      text-decoration: line-through;
      color: var(--muted);
    }

    .todo-remove {
      border: 1px solid rgba(217, 45, 32, 0.45);
      background: transparent;
      color: var(--danger);
      border-radius: 8px;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
    }

    @keyframes chat-enter {
      from {
        opacity: 0;
        transform: translateY(4px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @keyframes pulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.08); }
      100% { transform: scale(1); }
    }
  </style>
</head>
<body data-theme="light">
  <main class="shell">
    <section class="panel hero">
      <div class="title-wrap">
        <h1>Orchestrace Graph Console</h1>
        <p>Visual status per agent, auth, start, and cancellation controls in one place.</p>
      </div>
      <div class="theme-switch" aria-label="Theme">
        <button id="themeLight">Light</button>
        <button id="themeDark">Dark</button>
      </div>
    </section>

    <section class="panel screen-nav">
      <button class="secondary active" id="screenSettings">Settings</button>
      <button class="secondary" id="screenWorking">Working</button>
    </section>

    <section id="settingsScreen" class="screen active">
      <section class="panel">
        <h2 class="section-title">Settings: Auth</h2>
        <div class="grid">
          <div>
            <label>Provider</label>
            <select id="authProvider"></select>
          </div>
          <div class="full actions">
            <button class="primary" id="authStart">Connect Provider</button>
          </div>
        </div>
        <div id="authStatus" class="status-note"></div>
        <div id="authSession" class="auth-console">No auth session started.</div>
        <div id="authPromptRow" class="grid" style="display:none;margin-top:8px;">
          <div class="full">
            <label>OAuth prompt response</label>
            <input id="authPromptInput" placeholder="Paste device code or answer" />
          </div>
          <div class="full actions">
            <button class="secondary" id="authPromptSend">Send OAuth Input</button>
          </div>
        </div>
      </section>

      <section class="panel">
        <h2 class="section-title">Settings: Workspaces</h2>
        <div class="grid">
          <div class="full">
            <label>Registered workspaces</label>
            <select id="workspaceSelect"></select>
          </div>
          <div class="full actions">
            <button class="secondary" id="workspaceActivate">Set Active</button>
            <button class="danger" id="workspaceRemove">Remove</button>
          </div>
          <div class="full">
            <label>Add workspace path</label>
            <input id="workspacePath" placeholder="/absolute/path/to/repo" />
          </div>
          <div class="full">
            <label>Optional workspace name</label>
            <input id="workspaceName" placeholder="my-repo" />
          </div>
          <div class="full actions">
            <button class="primary" id="workspaceAdd">Add Workspace</button>
          </div>
        </div>
        <div id="workspaceStatus" class="status-note"></div>
        <div id="workspaceReadiness" class="readiness-list">Loading workspace readiness...</div>
      </section>
    </section>

    <section id="workingScreen" class="screen">
      <section class="panel">
        <h2 class="section-title">Working: Start Session</h2>
        <div class="grid">
          <div class="full">
            <label>Workspace</label>
            <select id="workWorkspace"></select>
          </div>
          <div>
            <label>Provider</label>
            <select id="workProvider"></select>
          </div>
          <div>
            <label>Model</label>
            <select id="workModel"></select>
          </div>
          <div class="full">
            <label>Prompt</label>
            <textarea id="workPrompt" placeholder="Describe the work to run"></textarea>
          </div>
          <div class="full">
            <label><input id="autoApprove" type="checkbox" checked /> Auto approve deep plan</label>
          </div>
          <div class="full actions">
            <button class="primary" id="workStart">Start Session</button>
          </div>
        </div>
        <div id="workStatus" class="status-note"></div>
      </section>

      <section class="panel graph-panel">
        <div class="graph-head">
          <h2 class="section-title" style="margin:0;">Agent Graph</h2>
          <div class="graph-tools">
            <button class="danger" id="graphDeleteSelected" disabled>Delete Selected</button>
            <div class="legend">
              <span class="running">running</span>
              <span class="completed">completed</span>
              <span class="failed">failed</span>
              <span class="cancelled">cancelled</span>
              <span class="planned">planned</span>
              <span class="subagent">sub-agent node</span>
            </div>
          </div>
        </div>
        <div class="graph-wrap">
          <svg id="sessionGraph" viewBox="0 0 620 280" role="img" aria-label="Agent session graph"></svg>
        </div>
        <div id="events" class="events">Select a node to inspect events.</div>
      </section>

      <section class="panel full-span">
        <h2 class="section-title">Working: Sessions</h2>
        <div id="workRows" class="session-list"></div>
      </section>

      <section class="panel full-span">
        <h2 class="section-title">Working: Agent Chat</h2>
        <div id="chatMessages" class="chat-thread"><div class="empty">Select an agent session to chat and continue with context.</div></div>
        <div class="todo-shell">
          <div class="todo-head">
            <strong>Agent Checklist</strong>
            <span id="todoCount" class="todo-count">0/0 done</span>
          </div>
          <div class="todo-input-row">
            <input id="todoInput" placeholder="Add a todo for this selected agent" />
            <button class="secondary" id="todoAdd">Add</button>
          </div>
          <div id="todoList" class="todo-list"><div class="empty">Select an agent session to manage checklist items.</div></div>
          <div id="todoStatus" class="status-note"></div>
        </div>
        <div class="grid" style="margin-top:8px;">
          <div class="full">
            <label>Message</label>
            <textarea id="chatInput" placeholder="Ask selected agent to continue from here"></textarea>
          </div>
          <div class="full actions">
            <button class="primary" id="chatSend">Send To Agent</button>
          </div>
        </div>
        <div id="chatStatus" class="status-note"></div>
      </section>
    </section>
  </main>

<script>
  const HMR_ENABLED = ${hmrEnabled ? 'true' : 'false'};
  let selectedWorkId = null;
  let authPollId = null;
  let authFlowVersion = 0;
  let readinessVersion = 0;
  let activeAuthSessionId = null;
  let providerCache = [];
  let statusCache = [];
  let workspaceCache = [];
  let activeWorkspaceId = null;
  let workSessionsCache = [];
  let chatBusy = false;
  let activeScreen = 'settings';
  let workStreamSource = null;
  let workStreamSessionId = null;
  let chatStreamSource = null;
  let chatStreamId = null;
  let chatMessagesCache = [];
  let selectedAgentTodos = [];
  const liveStreamState = Object.create(null);
  const liveChatState = {
    sessionId: null,
    text: '',
    error: '',
    status: '',
    usage: null,
    usageEstimated: false,
  };
  let defaults = { provider: 'anthropic', model: 'claude-sonnet-4-20250514' };

  async function api(path, method = 'GET', body) {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  function applyTheme(theme) {
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('orchestrace.theme', theme);
    document.getElementById('themeLight').classList.toggle('active', theme === 'light');
    document.getElementById('themeDark').classList.toggle('active', theme === 'dark');
  }

  function initTheme() {
    const saved = localStorage.getItem('orchestrace.theme');
    if (saved === 'light' || saved === 'dark') {
      applyTheme(saved);
      return;
    }
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(prefersDark ? 'dark' : 'light');
  }

  function applyScreen(screen) {
    activeScreen = screen === 'working' ? 'working' : 'settings';
    localStorage.setItem('orchestrace.screen', activeScreen);

    document.getElementById('settingsScreen').classList.toggle('active', activeScreen === 'settings');
    document.getElementById('workingScreen').classList.toggle('active', activeScreen === 'working');
    document.getElementById('screenSettings').classList.toggle('active', activeScreen === 'settings');
    document.getElementById('screenWorking').classList.toggle('active', activeScreen === 'working');
  }

  function initScreen() {
    const saved = localStorage.getItem('orchestrace.screen');
    if (saved === 'settings' || saved === 'working') {
      applyScreen(saved);
      return;
    }

    applyScreen('settings');
  }

  function initHmr() {
    if (!HMR_ENABLED || typeof EventSource === 'undefined') {
      return;
    }

    const stream = new EventSource('/__hmr');
    stream.addEventListener('reload', () => {
      window.location.reload();
    });
  }

  function closeWorkStreamSubscription() {
    if (workStreamSource) {
      workStreamSource.close();
      workStreamSource = null;
    }
    workStreamSessionId = null;
  }

  function ensureWorkStreamSubscription() {
    if (!selectedWorkId || typeof EventSource === 'undefined') {
      closeWorkStreamSubscription();
      return;
    }

    const selectedSession = workSessionsCache.find((item) => item.id === selectedWorkId);
    if (!selectedSession) {
      closeWorkStreamSubscription();
      return;
    }

    if (workStreamSource && workStreamSessionId === selectedWorkId) {
      return;
    }

    closeWorkStreamSubscription();
    workStreamSessionId = selectedWorkId;

    if (!liveStreamState[selectedWorkId]) {
      liveStreamState[selectedWorkId] = { phase: '', text: '' };
    }

    const source = new EventSource('/api/work/stream?id=' + encodeURIComponent(selectedWorkId));
    workStreamSource = source;

    source.addEventListener('token', (event) => {
      try {
        const payload = JSON.parse(event.data || '{}');
        const id = payload.id || workStreamSessionId;
        if (!id) {
          return;
        }

        if (!liveStreamState[id]) {
          liveStreamState[id] = { phase: '', text: '' };
        }

        const state = liveStreamState[id];
        const phase = typeof payload.phase === 'string' ? payload.phase : '';
        if (phase && phase !== state.phase) {
          state.phase = phase;
          state.text += '\\n\\n[' + phase + ']\\n';
        }

        const delta = typeof payload.delta === 'string' ? payload.delta : '';
        state.text += delta;
        if (state.text.length > 24000) {
          state.text = state.text.slice(-24000);
        }

        if (selectedWorkId === id) {
          renderSelectedEvents().catch(() => {});
        }
      } catch {
        // ignore malformed stream payloads
      }
    });

    source.addEventListener('ready', (event) => {
      try {
        const payload = JSON.parse(event.data || '{}');
        const id = payload.id || workStreamSessionId;
        if (!id || selectedWorkId !== id) {
          return;
        }

        if (Array.isArray(payload.todos)) {
          selectedAgentTodos = payload.todos;
          renderSelectedTodos();
        }
      } catch {
        // ignore malformed stream payloads
      }
    });

    source.addEventListener('todo-update', (event) => {
      try {
        const payload = JSON.parse(event.data || '{}');
        const id = payload.id || workStreamSessionId;
        if (!id || selectedWorkId !== id) {
          return;
        }

        if (Array.isArray(payload.todos)) {
          selectedAgentTodos = payload.todos;
          renderSelectedTodos();
        }
      } catch {
        // ignore malformed stream payloads
      }
    });

    source.addEventListener('end', (event) => {
      try {
        const payload = JSON.parse(event.data || '{}');
        if (payload && payload.id && selectedWorkId === payload.id) {
          renderSelectedEvents().catch(() => {});
        }
      } catch {
        // ignore malformed stream payloads
      }
    });

    source.addEventListener('error', () => {
      if (workStreamSource === source) {
        closeWorkStreamSubscription();
      }
    });
  }

  function closeChatStreamSubscription() {
    if (chatStreamSource) {
      chatStreamSource.close();
      chatStreamSource = null;
    }
    chatStreamId = null;
  }

  function summarizeText(value, maxLen = 240) {
    const lineBreak = String.fromCharCode(10);
    const carriage = String.fromCharCode(13);
    const tab = String.fromCharCode(9);
    let text = String(value || '')
      .split(carriage).join(' ')
      .split(lineBreak).join(' ')
      .split(tab).join(' ');

    while (text.includes('  ')) {
      text = text.split('  ').join(' ');
    }

    text = text.trim();
    if (!text) {
      return '(empty)';
    }

    if (text.length <= maxLen) {
      return text;
    }

    return text.slice(0, maxLen - 3) + '...';
  }

  function formatMessageTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value || '');
    }

    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatUsageLabel(usage, estimated = false) {
    if (!usage || typeof usage !== 'object') {
      return '';
    }

    const inTokens = Number(usage.input || 0);
    const outTokens = Number(usage.output || 0);
    const cost = Number(usage.cost || 0).toFixed(4);
    const prefix = estimated ? 'usage est' : 'usage';
    return prefix + ': in ' + inTokens + ' | out ' + outTokens + ' | $' + cost;
  }

  function createChatChip(text, variant = '') {
    const chip = document.createElement('span');
    chip.className = 'chat-chip' + (variant ? ' ' + variant : '');
    chip.textContent = text;
    return chip;
  }

  function applyBoldMarkup(text) {
    const segments = String(text || '').split('**');
    if (segments.length === 1) {
      return String(text || '');
    }

    let output = segments[0];
    let isOpening = true;
    for (let index = 1; index < segments.length; index += 1) {
      output += (isOpening ? '<strong>' : '</strong>') + segments[index];
      isOpening = !isOpening;
    }

    if (!isOpening) {
      output += '</strong>';
    }

    return output;
  }

  function parseOrderedListItem(line) {
    const markerIndex = line.indexOf('. ');
    if (markerIndex <= 0) {
      return '';
    }

    const maybeIndex = line.slice(0, markerIndex);
    for (const character of maybeIndex) {
      if (character < '0' || character > '9') {
        return '';
      }
    }

    return line.slice(markerIndex + 2);
  }

  function applyInlineMarkup(text) {
    let safe = escapeHtml(text);
    safe = applyBoldMarkup(safe);
    return safe;
  }

  function renderPlainMarkdownBlocks(text) {
    const lineBreak = String.fromCharCode(10);
    const lines = String(text || '').split(lineBreak);
    const blocks = [];
    let paragraph = [];
    let listType = '';
    let listItems = [];

    function flushParagraph() {
      if (!paragraph.length) {
        return;
      }

      blocks.push('<p>' + paragraph.join('<br />') + '</p>');
      paragraph = [];
    }

    function flushList() {
      if (!listType || !listItems.length) {
        listType = '';
        listItems = [];
        return;
      }

      blocks.push('<' + listType + '><li>' + listItems.join('</li><li>') + '</li></' + listType + '>');
      listType = '';
      listItems = [];
    }

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (!line) {
        flushParagraph();
        flushList();
        continue;
      }

      if (line.startsWith('### ')) {
        flushParagraph();
        flushList();
        blocks.push('<h4>' + applyInlineMarkup(line.slice(4)) + '</h4>');
        continue;
      }

      if (line.startsWith('## ')) {
        flushParagraph();
        flushList();
        blocks.push('<h3>' + applyInlineMarkup(line.slice(3)) + '</h3>');
        continue;
      }

      if (line.startsWith('# ')) {
        flushParagraph();
        flushList();
        blocks.push('<h2>' + applyInlineMarkup(line.slice(2)) + '</h2>');
        continue;
      }

      if (line.startsWith('> ')) {
        flushParagraph();
        flushList();
        blocks.push('<blockquote>' + applyInlineMarkup(line.slice(2)) + '</blockquote>');
        continue;
      }

      if ((line.startsWith('- ') || line.startsWith('* ')) && line.length > 2) {
        flushParagraph();
        if (listType && listType !== 'ul') {
          flushList();
        }
        listType = 'ul';
        listItems.push(applyInlineMarkup(line.slice(2)));
        continue;
      }

      const orderedItem = parseOrderedListItem(line);
      if (orderedItem) {
        flushParagraph();
        if (listType && listType !== 'ol') {
          flushList();
        }
        listType = 'ol';
        listItems.push(applyInlineMarkup(orderedItem));
        continue;
      }

      flushList();
      paragraph.push(applyInlineMarkup(line));
    }

    flushParagraph();
    flushList();

    return blocks.join('');
  }

  function renderRichTextSegment(segment) {
    const tick = String.fromCharCode(96);
    const split = String(segment || '').split(tick);
    if (split.length === 1) {
      return renderPlainMarkdownBlocks(split[0]);
    }

    const inlineCode = [];
    let stitched = '';

    for (let index = 0; index < split.length; index += 1) {
      if (index % 2 === 0) {
        stitched += split[index];
      } else {
        const token = '[[INLINE_CODE_' + inlineCode.length + ']]';
        inlineCode.push(escapeHtml(split[index]));
        stitched += token;
      }
    }

    let html = renderPlainMarkdownBlocks(stitched);
    inlineCode.forEach((code, index) => {
      const token = '[[INLINE_CODE_' + index + ']]';
      html = html.replaceAll(token, '<code class="chat-inline-code">' + code + '</code>');
    });

    return html;
  }

  function renderMarkdown(content) {
    const lineBreak = String.fromCharCode(10);
    const carriage = String.fromCharCode(13);
    const source = String(content || '')
      .split(carriage + lineBreak).join(lineBreak)
      .split(carriage).join(lineBreak);
    if (!source.trim()) {
      return '<p class="muted">(empty)</p>';
    }

    const tick = String.fromCharCode(96);
    const fence = tick + tick + tick;
    const parts = source.split(fence);
    const blocks = [];

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (index % 2 === 0) {
        const rendered = renderRichTextSegment(part);
        if (rendered) {
          blocks.push(rendered);
        }
        continue;
      }

      let cleaned = part;
      while (cleaned.startsWith(lineBreak)) {
        cleaned = cleaned.slice(1);
      }

      const newline = cleaned.indexOf(lineBreak);
      const language = newline >= 0 ? cleaned.slice(0, newline).trim() : '';
      const code = newline >= 0 ? cleaned.slice(newline + 1) : cleaned;
      blocks.push(
        '<pre><div class="code-lang">'
          + escapeHtml(language || 'code')
          + '</div><code>'
          + escapeHtml(code)
          + '</code></pre>',
      );
    }

    return blocks.join('');
  }

  function renderChatContextCard(session) {
    const wrapper = document.createElement('section');
    wrapper.className = 'chat-context';

    const top = document.createElement('div');
    top.className = 'row';
    top.appendChild(createChatChip('session ' + session.id.slice(0, 8), 'strong'));
    top.appendChild(createChatChip('status ' + (session.status || 'unknown')));
    top.appendChild(createChatChip((session.provider || 'provider?') + ' / ' + (session.model || 'model?')));
    wrapper.appendChild(top);

    const prompt = document.createElement('p');
    prompt.className = 'prompt';
    prompt.textContent = summarizeText(session.prompt || '', 420);
    wrapper.appendChild(prompt);

    const toolEvents = (session.events || [])
      .filter((entry) => entry.type === 'task:tool-call')
      .slice(-4);
    const recentEvents = (session.events || [])
      .filter((entry) => entry.type !== 'task:stream-delta')
      .slice(-6);

    const events = document.createElement('div');
    events.className = 'chat-events';
    const title = document.createElement('div');
    title.textContent = 'recent activity';
    events.appendChild(title);

    if (toolEvents.length === 0 && recentEvents.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = '(no activity yet)';
      events.appendChild(empty);
    } else {
      const display = toolEvents.length ? toolEvents : recentEvents;
      for (const event of display) {
        const row = document.createElement('div');
        row.textContent = '[' + formatMessageTime(event.time) + '] ' + summarizeText(event.message || '', 180);
        events.appendChild(row);
      }
    }

    wrapper.appendChild(events);
    return wrapper;
  }

  function appendChatMessageCard(root, message, options = {}) {
    const role = message && message.role === 'assistant' ? 'assistant' : 'user';
    const title = role === 'assistant' ? 'Agent' : 'You';
    const card = document.createElement('article');
    card.className = 'chat-message role-' + role + (options.live ? ' live' : '');

    const head = document.createElement('div');
    head.className = 'chat-head';

    const roleEl = document.createElement('span');
    roleEl.className = 'chat-role';
    roleEl.textContent = title;
    head.appendChild(roleEl);

    const timeEl = document.createElement('span');
    timeEl.className = 'chat-time';
    timeEl.textContent = formatMessageTime(message.time || now());
    head.appendChild(timeEl);
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'chat-body';
    body.innerHTML = renderMarkdown(String(message.content || ''));
    card.appendChild(body);

    const meta = document.createElement('div');
    meta.className = 'chat-meta';

    const usageLabel = formatUsageLabel(message.usage, Boolean(options.usageEstimated));
    if (usageLabel) {
      meta.appendChild(createChatChip(usageLabel, options.usageEstimated ? 'warn' : ''));
    }

    if (options.live) {
      meta.appendChild(createChatChip('streaming', 'strong'));
    }

    if (options.error) {
      meta.appendChild(createChatChip(options.error, 'error'));
    }

    if (meta.childNodes.length > 0) {
      card.appendChild(meta);
    }

    root.appendChild(card);
  }

  function renderChatMessages(messages) {
    const chatEl = document.getElementById('chatMessages');
    chatEl.innerHTML = '';

    if (!selectedWorkId) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Select an agent session to chat and continue with context.';
      chatEl.appendChild(empty);
      return;
    }

    const session = workSessionsCache.find((item) => item.id === selectedWorkId);
    if (session) {
      chatEl.appendChild(renderChatContextCard(session));
    }

    for (const message of messages || []) {
      appendChatMessageCard(chatEl, message);
    }

    if (liveChatState.sessionId === selectedWorkId) {
      if (liveChatState.text || liveChatState.error || liveChatState.status === 'streaming') {
        appendChatMessageCard(chatEl, {
          role: 'assistant',
          content: liveChatState.text || '(waiting for first tokens...)',
          time: now(),
          usage: liveChatState.usage,
        }, {
          live: liveChatState.status === 'streaming',
          usageEstimated: Boolean(liveChatState.usageEstimated),
          error: liveChatState.error || '',
        });
      }
    }

    if (!messages?.length && (!liveChatState.text || liveChatState.sessionId !== selectedWorkId)) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No chat turns yet. Send a follow-up to continue this agent session.';
      chatEl.appendChild(empty);
    }

    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function renderSelectedTodos() {
    const todoList = document.getElementById('todoList');
    const todoCount = document.getElementById('todoCount');

    todoList.innerHTML = '';

    if (!selectedWorkId) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Select an agent session to manage checklist items.';
      todoList.appendChild(empty);
      todoCount.textContent = '0/0 done';
      setText('todoStatus', '');
      return;
    }

    const doneCount = selectedAgentTodos.filter((item) => item.done).length;
    todoCount.textContent = doneCount + '/' + selectedAgentTodos.length + ' done';

    if (!selectedAgentTodos.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No checklist items yet for this agent.';
      todoList.appendChild(empty);
      return;
    }

    for (const item of selectedAgentTodos) {
      const row = document.createElement('article');
      row.className = 'todo-item' + (item.done ? ' done' : '');

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = Boolean(item.done);
      toggle.addEventListener('change', () => {
        toggleAgentTodo(item.id, toggle.checked).catch((error) => setText('todoStatus', String(error)));
      });
      row.appendChild(toggle);

      const text = document.createElement('div');
      text.className = 'text';
      text.textContent = item.text;
      row.appendChild(text);

      const remove = document.createElement('button');
      remove.className = 'todo-remove';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        removeAgentTodo(item.id).catch((error) => setText('todoStatus', String(error)));
      });
      row.appendChild(remove);

      todoList.appendChild(row);
    }
  }

  async function addAgentTodo() {
    if (!selectedWorkId) {
      setText('todoStatus', 'Select an agent session first.');
      return;
    }

    const input = document.getElementById('todoInput');
    const text = input.value.trim();
    if (!text) {
      setText('todoStatus', 'Todo text is required.');
      return;
    }

    const data = await api('/api/work/todos/add', 'POST', { id: selectedWorkId, text });
    selectedAgentTodos = data.todos || [];
    input.value = '';
    setText('todoStatus', 'Checklist item added for selected agent.');
    renderSelectedTodos();
  }

  async function toggleAgentTodo(todoId, done) {
    if (!selectedWorkId) {
      return;
    }

    const data = await api('/api/work/todos/toggle', 'POST', { id: selectedWorkId, todoId, done });
    selectedAgentTodos = data.todos || [];
    renderSelectedTodos();
  }

  async function removeAgentTodo(todoId) {
    if (!selectedWorkId) {
      return;
    }

    const data = await api('/api/work/todos/remove', 'POST', { id: selectedWorkId, todoId });
    selectedAgentTodos = data.todos || [];
    setText('todoStatus', 'Checklist item removed.');
    renderSelectedTodos();
  }

  async function streamChatMessage(sessionId, message) {
    const start = await api('/api/work/chat/send-stream', 'POST', { id: sessionId, message });
    const streamId = start.streamId;

    liveChatState.sessionId = sessionId;
    liveChatState.text = '';
    liveChatState.error = '';
    liveChatState.status = 'streaming';
    liveChatState.usage = null;
    liveChatState.usageEstimated = false;
    renderChatMessages(chatMessagesCache);

    return new Promise((resolve, reject) => {
      closeChatStreamSubscription();

      const source = new EventSource('/api/work/chat/stream?streamId=' + encodeURIComponent(streamId));
      chatStreamSource = source;
      chatStreamId = streamId;

      source.addEventListener('snapshot', (event) => {
        try {
          const payload = JSON.parse(event.data || '{}');
          if (typeof payload.text === 'string') {
            liveChatState.text = payload.text;
          }
          if (payload.usage && typeof payload.usage === 'object') {
            liveChatState.usage = payload.usage;
            liveChatState.usageEstimated = Boolean(payload.usageEstimated);
          }
          renderChatMessages(chatMessagesCache);
        } catch {
          // ignore malformed snapshot payloads
        }
      });

      source.addEventListener('token', (event) => {
        try {
          const payload = JSON.parse(event.data || '{}');
          const delta = typeof payload.delta === 'string' ? payload.delta : '';
          liveChatState.text += delta;
          if (liveChatState.text.length > 24000) {
            liveChatState.text = liveChatState.text.slice(-24000);
          }
          renderChatMessages(chatMessagesCache);
        } catch {
          // ignore malformed token payloads
        }
      });

      source.addEventListener('usage', (event) => {
        try {
          const payload = JSON.parse(event.data || '{}');
          if (payload.usage && typeof payload.usage === 'object') {
            liveChatState.usage = payload.usage;
            liveChatState.usageEstimated = Boolean(payload.estimated);
            renderChatMessages(chatMessagesCache);
          }
        } catch {
          // ignore malformed usage payloads
        }
      });

      source.addEventListener('chat-error', (event) => {
        try {
          const payload = JSON.parse(event.data || '{}');
          liveChatState.error = payload.error || 'Chat stream failed';
        } catch {
          liveChatState.error = 'Chat stream failed';
        }

        liveChatState.status = 'failed';
        renderChatMessages(chatMessagesCache);
        closeChatStreamSubscription();
        reject(new Error(liveChatState.error));
      });

      source.addEventListener('end', async () => {
        closeChatStreamSubscription();
        liveChatState.status = 'completed';
        liveChatState.usageEstimated = false;
        await refreshSelectedChat();
        liveChatState.sessionId = null;
        liveChatState.text = '';
        liveChatState.error = '';
        liveChatState.status = '';
        liveChatState.usage = null;
        liveChatState.usageEstimated = false;
        resolve(undefined);
      });

      source.onerror = () => {
        if (chatStreamSource !== source) {
          return;
        }

        closeChatStreamSubscription();
        if (liveChatState.status !== 'failed' && liveChatState.status !== 'completed') {
          liveChatState.status = 'failed';
          if (!liveChatState.error) {
            liveChatState.error = 'Chat stream connection closed.';
          }
          renderChatMessages(chatMessagesCache);
          reject(new Error(liveChatState.error));
        }
      };
    });
  }

  async function refreshWorkspaces() {
    const data = await api('/api/workspaces');
    workspaceCache = data.workspaces || [];
    activeWorkspaceId = data.activeWorkspaceId || null;

    const workspaceSelect = document.getElementById('workspaceSelect');
    const workWorkspace = document.getElementById('workWorkspace');
    const previousWorkspace = workspaceSelect.value;
    const previousWorkWorkspace = workWorkspace.value;
    workspaceSelect.innerHTML = '';
    workWorkspace.innerHTML = '';

    for (const workspace of workspaceCache) {
      const suffix = workspace.id === activeWorkspaceId ? ' [active]' : '';

      const opt = document.createElement('option');
      opt.value = workspace.id;
      opt.textContent = workspace.name + suffix + ' - ' + workspace.path;
      workspaceSelect.appendChild(opt);

      const workOpt = document.createElement('option');
      workOpt.value = workspace.id;
      workOpt.textContent = workspace.name;
      workWorkspace.appendChild(workOpt);
    }

    if (previousWorkspace && workspaceCache.find((item) => item.id === previousWorkspace)) {
      workspaceSelect.value = previousWorkspace;
    } else if (activeWorkspaceId) {
      workspaceSelect.value = activeWorkspaceId;
    }

    if (previousWorkWorkspace && workspaceCache.find((item) => item.id === previousWorkWorkspace)) {
      workWorkspace.value = previousWorkWorkspace;
    } else if (activeWorkspaceId) {
      workWorkspace.value = activeWorkspaceId;
    }

    const active = workspaceCache.find((item) => item.id === activeWorkspaceId);
    if (active) {
      setText('workspaceStatus', 'Active workspace: ' + active.name + ' (' + active.path + ')');
    } else {
      setText('workspaceStatus', 'No active workspace configured.');
    }

    await refreshWorkspaceReadiness();
  }

  async function refreshWorkspaceReadiness() {
    const requestVersion = ++readinessVersion;
    const authProvider = document.getElementById('authProvider');
    const workProvider = document.getElementById('workProvider');
    const provider = (authProvider && authProvider.value)
      || (workProvider && workProvider.value)
      || defaults.provider;
    const data = await api('/api/workspaces/readiness?provider=' + encodeURIComponent(provider));
    if (requestVersion !== readinessVersion) {
      return;
    }

    const root = document.getElementById('workspaceReadiness');
    const rows = data.workspaces || [];

    if (!rows.length) {
      root.textContent = 'No workspaces registered.';
      return;
    }

    const summary = '<div class="muted">Provider auth for ' + escapeHtml(data.provider || provider) + ': '
      + escapeHtml(data.authSource || 'none') + '</div>';

    const cards = rows.map((workspace) => {
      const checks = workspace.checks || {};
      const flags = [
        checks.pathExists ? 'path:ok' : 'path:missing',
        checks.hasGit ? 'git:ok' : 'git:missing',
        checks.hasNodeProject ? 'node:ok' : 'node:missing',
        checks.authReady ? 'auth:ok' : 'auth:missing',
      ].join(' | ');

      return '<div class="readiness-item' + (workspace.active ? ' active' : '') + '">'
        + '<div><strong>' + escapeHtml(workspace.name || workspace.id || 'workspace') + '</strong></div>'
        + '<div class="muted">' + escapeHtml(workspace.path || '') + '</div>'
        + '<div>' + escapeHtml(flags) + (workspace.ready ? ' | ready' : ' | not-ready') + '</div>'
        + '</div>';
    }).join('');

    root.innerHTML = summary + cards;
  }

  async function addWorkspace() {
    const path = document.getElementById('workspacePath').value.trim();
    const name = document.getElementById('workspaceName').value.trim();

    if (!path) {
      setText('workspaceStatus', 'Workspace path is required.');
      return;
    }

    await api('/api/workspaces/add', 'POST', { path, name });
    document.getElementById('workspacePath').value = '';
    document.getElementById('workspaceName').value = '';
    await refreshWorkspaces();
    setText('workspaceStatus', 'Workspace added and set active.');
  }

  async function activateWorkspace() {
    const workspace = document.getElementById('workspaceSelect').value;
    if (!workspace) {
      setText('workspaceStatus', 'Select a workspace first.');
      return;
    }

    await api('/api/workspaces/select', 'POST', { workspace });
    await refreshWorkspaces();
    setText('workspaceStatus', 'Active workspace updated.');
  }

  async function removeWorkspace() {
    const workspace = document.getElementById('workspaceSelect').value;
    if (!workspace) {
      setText('workspaceStatus', 'Select a workspace first.');
      return;
    }

    if (!window.confirm('Remove this workspace from Orchestrace?')) {
      return;
    }

    await api('/api/workspaces/remove', 'POST', { workspace });
    await refreshWorkspaces();
    setText('workspaceStatus', 'Workspace removed.');
  }

  async function refreshProviders() {
    const data = await api('/api/providers');
    providerCache = data.providers || [];
    statusCache = data.statuses || [];
    defaults = data.defaults || defaults;

    const select = document.getElementById('authProvider');
    const previous = select.value;
    select.innerHTML = '';

    const workProvider = document.getElementById('workProvider');
    const previousWorkProvider = workProvider.value;
    workProvider.innerHTML = '';

    const connectedProviders = [];

    for (const provider of providerCache) {
      const status = statusCache.find((item) => item.provider === provider.id);
      const opt = document.createElement('option');
      opt.value = provider.id;
      opt.textContent = provider.id + ' (' + (status && status.source !== 'none' ? 'connected' : 'not connected') + ')';
      select.appendChild(opt);

      if (status && status.source !== 'none') {
        connectedProviders.push(provider);
        const wopt = document.createElement('option');
        wopt.value = provider.id;
        wopt.textContent = provider.id;
        workProvider.appendChild(wopt);
      }
    }

    if (previous && providerCache.find((item) => item.id === previous)) {
      select.value = previous;
    }

    if (connectedProviders.length === 0) {
      workProvider.innerHTML = '<option value="">no connected providers</option>';
      document.getElementById('workModel').innerHTML = '<option value="">connect provider in Settings</option>';
      setText('workStatus', 'No connected providers. Connect one in Settings.');
      syncAuthUiForProvider();
      await refreshWorkspaceReadiness();
      return;
    }

    if (previousWorkProvider && connectedProviders.find((item) => item.id === previousWorkProvider)) {
      workProvider.value = previousWorkProvider;
    } else if (connectedProviders.find((item) => item.id === defaults.provider)) {
      workProvider.value = defaults.provider;
    } else if (connectedProviders[0]) {
      workProvider.value = connectedProviders[0].id;
    }

    await refreshWorkModels();
    syncAuthUiForProvider();
    await refreshWorkspaceReadiness();
  }

  async function refreshWorkModels() {
    const providerId = document.getElementById('workProvider').value;
    const modelSelect = document.getElementById('workModel');
    const previousModel = modelSelect.value;
    modelSelect.innerHTML = '';

    if (!providerId) {
      modelSelect.innerHTML = '<option value="">connect provider in Settings</option>';
      return;
    }

    const providerStatus = statusCache.find((item) => item.provider === providerId);
    if (!providerStatus || providerStatus.source === 'none') {
      modelSelect.innerHTML = '<option value="">provider not connected</option>';
      setText('workStatus', 'Provider is not connected. Connect it in Settings.');
      return;
    }

    try {
      const data = await api('/api/models?provider=' + encodeURIComponent(providerId));
      const models = data.models || [];

      for (const model of models.slice(0, 120)) {
        const opt = document.createElement('option');
        opt.value = model;
        opt.textContent = model;
        modelSelect.appendChild(opt);
      }

      if (previousModel && models.includes(previousModel)) {
        modelSelect.value = previousModel;
      } else if (providerId === defaults.provider && models.includes(defaults.model)) {
        modelSelect.value = defaults.model;
      } else if (models[0]) {
        modelSelect.value = models[0];
      }
    } catch (error) {
      modelSelect.innerHTML = '<option value="">no models available</option>';
      setText('workStatus', String(error));
    }
  }

  function syncAuthUiForProvider() {
    const providerId = document.getElementById('authProvider').value;
    const connectButton = document.getElementById('authStart');

    const provider = providerCache.find((item) => item.id === providerId);
    if (!provider) return;

    if (provider.authType === 'api-key') {
      connectButton.disabled = true;
      setText('authStatus', 'Provider ' + provider.id + ' requires API key setup in CLI.');
      document.getElementById('authSession').textContent = 'Run: pnpm --filter @orchestrace/cli dev auth ' + provider.id;
      document.getElementById('authPromptRow').style.display = 'none';
      return;
    }

    connectButton.disabled = false;
    if (!activeAuthSessionId) {
      setText('authStatus', '');
      document.getElementById('authSession').textContent = 'No auth session started.';
    }
  }

  async function refreshWorkSessions() {
    const data = await api('/api/work');
    workSessionsCache = data.sessions || [];

    if (selectedWorkId && !workSessionsCache.find((item) => item.id === selectedWorkId)) {
      selectedWorkId = null;
    }

    renderSessionList(workSessionsCache);
    renderSessionGraph(workSessionsCache);
    await renderSelectedEvents();
    await refreshSelectedChat();
    ensureWorkStreamSubscription();
  }

  async function selectWorkSession(id) {
    if (!id) {
      return;
    }

    selectedWorkId = id;
    renderSessionList(workSessionsCache);
    renderSessionGraph(workSessionsCache);
    await renderSelectedEvents();
    await refreshSelectedChat();
    ensureWorkStreamSubscription();
  }

  function syncGraphDeleteSelectedButton() {
    const button = document.getElementById('graphDeleteSelected');
    if (!button) {
      return;
    }

    const hasSelection = Boolean(selectedWorkId);
    button.disabled = !hasSelection;
    button.textContent = hasSelection
      ? 'Delete Selected (' + String(selectedWorkId).slice(0, 8) + ')'
      : 'Delete Selected';
  }

  async function deleteWorkSessionClient(id) {
    if (!id) {
      return;
    }

    const ok = window.confirm('Delete this agent session? This removes its events, chat, and checklist.');
    if (!ok) {
      return;
    }

    await api('/api/work/delete', 'POST', { id });
    if (selectedWorkId === id) {
      selectedWorkId = null;
    }

    setText('workStatus', 'Deleted session: ' + String(id).slice(0, 8));
    await refreshWorkSessions();
  }

  async function deleteSelectedGraphSession() {
    if (!selectedWorkId) {
      setText('workStatus', 'Select an agent first.');
      return;
    }

    await deleteWorkSessionClient(selectedWorkId);
  }

  async function retryWorkSession(id) {
    if (!id) {
      setText('workStatus', 'Missing session id for retry.');
      return;
    }

    const session = workSessionsCache.find((item) => item.id === id);
    if (!session) {
      setText('workStatus', 'Session not found for retry.');
      return;
    }

    if (session.status !== 'failed') {
      setText('workStatus', 'Retry is available only for failed sessions.');
      return;
    }

    const promptText = window.prompt('Retry failed session. You can edit the prompt before rerun:', session.prompt || '');
    if (promptText === null) {
      return;
    }

    const prompt = promptText.trim();
    if (!prompt) {
      setText('workStatus', 'Retry prompt cannot be empty.');
      return;
    }

    const result = await api('/api/work/start', 'POST', {
      workspaceId: session.workspaceId,
      prompt,
      provider: session.provider,
      model: session.model,
      autoApprove: Boolean(session.autoApprove),
    });

    selectedWorkId = result.id;
    setText('workStatus', 'Started retry session: ' + result.id);
    await refreshWorkSessions();
  }

  function renderSessionList(sessions) {
    const root = document.getElementById('workRows');
    root.innerHTML = '';

    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No sessions yet. Start work to see the graph animate.';
      root.appendChild(empty);
      return;
    }

    for (const session of sessions) {
      const card = document.createElement('article');
      card.className = 'session-item' + (selectedWorkId === session.id ? ' active' : '');
      const showRetry = session.status === 'failed';

      const escapedPrompt = escapeHtml(session.prompt || '').slice(0, 180);
      card.innerHTML =
        '<div class="session-item-head">'
          + '<strong>' + session.id.slice(0, 8) + '</strong>'
          + '<span class="badge ' + session.status + '">' + session.status + '</span>'
        + '</div>'
        + '<div class="meta">' + escapeHtml((session.workspaceName || 'workspace') + ' @ ' + (session.workspacePath || '')) + '</div>'
        + '<div class="meta">' + escapeHtml(session.provider + ' / ' + session.model) + '</div>'
        + '<div class="prompt">' + escapedPrompt + '</div>'
        + '<div class="session-actions">'
          + '<button class="secondary" data-view="' + session.id + '">View</button>'
          + (showRetry ? '<button class="secondary" data-retry="' + session.id + '">Retry Prompt</button>' : '')
          + '<button class="danger" data-cancel="' + session.id + '">Cancel</button>'
          + '<button class="danger" data-delete="' + session.id + '">Delete</button>'
        + '</div>';

      root.appendChild(card);

      card.addEventListener('click', async (event) => {
        const target = event.target;
        if (target instanceof Element && target.closest('button')) {
          return;
        }

        await selectWorkSession(session.id);
      });
    }

    root.querySelectorAll('button[data-view]').forEach((button) => {
      button.addEventListener('click', async () => {
        await selectWorkSession(button.getAttribute('data-view'));
      });
    });

    root.querySelectorAll('button[data-cancel]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.getAttribute('data-cancel');
        await api('/api/work/cancel', 'POST', { id });
        await refreshWorkSessions();
      });
    });

    root.querySelectorAll('button[data-retry]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.getAttribute('data-retry');
        await retryWorkSession(id).catch((error) => setText('workStatus', String(error)));
      });
    });

    root.querySelectorAll('button[data-delete]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.getAttribute('data-delete');
        await deleteWorkSessionClient(id);
      });
    });
  }

  function renderSessionGraph(sessions) {
    syncGraphDeleteSelectedButton();
    const svg = document.getElementById('sessionGraph');
    svg.innerHTML = '';

    if (!sessions.length) {
      svg.setAttribute('viewBox', '0 0 620 280');
      const text = createSvgText(310, 140, 'No sessions yet', 'node-label');
      text.setAttribute('text-anchor', 'middle');
      svg.appendChild(text);
      return;
    }

    const selectedSession = selectedWorkId
      ? sessions.find((item) => item.id === selectedWorkId)
      : null;
    const plannedSubAgents = selectedSession
      ? getPlannedSubAgentsForSession(selectedSession)
      : [];
    const subAgents = selectedSession
      ? parseSubAgentsFromEvents(selectedSession.events || [])
      : [];

    if (selectedSession && (plannedSubAgents.length > 0 || subAgents.length > 0)) {
      renderFocusedAgentGraph(svg, selectedSession, plannedSubAgents, subAgents);
      return;
    }

    const ordered = [...sessions].reverse();
    const width = Math.max(620, ordered.length * 170);
    const height = 280;
    const paddingX = 70;
    const centerY = height * 0.52;
    const step = ordered.length > 1 ? (width - paddingX * 2) / (ordered.length - 1) : 0;

    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);

    ordered.forEach((session, index) => {
      const x = paddingX + index * step;
      const y = centerY + Math.sin(index * 0.7) * 22;

      if (index > 0) {
        const prevX = paddingX + (index - 1) * step;
        const prevY = centerY + Math.sin((index - 1) * 0.7) * 22;
        const cx = (prevX + x) / 2;
        const cy = (prevY + y) / 2 - 12;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M ' + prevX + ' ' + prevY + ' Q ' + cx + ' ' + cy + ' ' + x + ' ' + y);
        path.setAttribute('class', 'graph-edge');
        svg.appendChild(path);
      }

      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.setAttribute('class', 'graph-node status-' + session.status + (selectedWorkId === session.id ? ' selected' : ''));
      group.setAttribute('transform', 'translate(' + x + ' ' + y + ')');
      group.style.cursor = 'pointer';

      const halo = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      halo.setAttribute('r', '18');
      halo.setAttribute('class', 'node-halo');
      group.appendChild(halo);

      const core = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      core.setAttribute('r', '12');
      core.setAttribute('class', 'node-core');
      group.appendChild(core);

      const label = createSvgText(0, 30, session.id.slice(0, 8), 'node-label');
      group.appendChild(label);

      const sub = createSvgText(0, 44, session.status, 'node-sub');
      group.appendChild(sub);

      group.addEventListener('click', async () => {
        await selectWorkSession(session.id);
      });

      svg.appendChild(group);
    });
  }

  function renderFocusedAgentGraph(svg, session, plannedSubAgents, spawnedSubAgents) {
    const plannedById = new Map();
    const graphNodes = [];

    for (const planned of plannedSubAgents) {
      const node = {
        id: planned.id,
        prompt: planned.prompt,
        status: 'planned',
        dependencies: Array.isArray(planned.dependencies) ? planned.dependencies : [],
        kind: 'planned',
      };
      plannedById.set(node.id, node);
      graphNodes.push(node);
    }

    for (const spawned of spawnedSubAgents) {
      const existing = plannedById.get(spawned.id);
      if (existing) {
        existing.status = normalizeGraphStatus(spawned.status);
        if (!existing.prompt && spawned.prompt) {
          existing.prompt = spawned.prompt;
        }
        continue;
      }

      graphNodes.push({
        id: spawned.id,
        prompt: spawned.prompt,
        status: normalizeGraphStatus(spawned.status),
        dependencies: [],
        kind: 'spawned',
      });
    }

    const count = graphNodes.length;
    const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(Math.max(1, count)))));
    const rows = Math.ceil(Math.max(1, count) / cols);
    const gapX = 170;
    const gapY = 90;
    const width = Math.max(760, 320 + cols * gapX);
    const height = Math.max(280, 120 + rows * gapY);
    const rootX = 130;
    const rootY = height / 2;
    const gridStartX = 300;
    const gridStartY = (height - (rows - 1) * gapY) / 2;

    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);

    const helper = createSvgText(20, 22, 'Focused graph: selected agent + planned/spawned sub-agents', 'node-sub');
    helper.setAttribute('text-anchor', 'start');
    helper.setAttribute('opacity', '0.85');
    svg.appendChild(helper);

    const root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    root.setAttribute('class', 'graph-node status-' + normalizeGraphStatus(session.status) + ' selected');
    root.setAttribute('transform', 'translate(' + rootX + ' ' + rootY + ')');
    root.style.cursor = 'pointer';

    const rootHalo = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    rootHalo.setAttribute('r', '22');
    rootHalo.setAttribute('class', 'node-halo');
    root.appendChild(rootHalo);

    const rootCore = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    rootCore.setAttribute('r', '14');
    rootCore.setAttribute('class', 'node-core');
    root.appendChild(rootCore);

    root.appendChild(createSvgText(0, 34, session.id.slice(0, 8), 'node-label'));
    root.appendChild(createSvgText(0, 48, 'root agent', 'node-sub'));

    root.addEventListener('click', async () => {
      await selectWorkSession(session.id);
    });
    svg.appendChild(root);

    const positions = new Map();
    graphNodes.forEach((agent, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = gridStartX + col * gapX;
      const y = gridStartY + row * gapY;
      positions.set(agent.id, { x, y });
    });

    graphNodes.forEach((agent) => {
      const target = positions.get(agent.id);
      if (!target) {
        return;
      }

      const deps = Array.isArray(agent.dependencies) ? agent.dependencies : [];
      const resolvedDeps = deps.filter((depId) => positions.has(depId));
      if (resolvedDeps.length === 0) {
        const cx = (rootX + target.x) / 2;
        const cy = (rootY + target.y) / 2 - 10;
        const edge = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        edge.setAttribute('d', 'M ' + rootX + ' ' + rootY + ' Q ' + cx + ' ' + cy + ' ' + target.x + ' ' + target.y);
        edge.setAttribute('class', 'graph-edge');
        svg.appendChild(edge);
        return;
      }

      resolvedDeps.forEach((depId) => {
        const source = positions.get(depId);
        if (!source) {
          return;
        }
        const cx = (source.x + target.x) / 2;
        const cy = (source.y + target.y) / 2 - 8;
        const edge = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        edge.setAttribute('d', 'M ' + source.x + ' ' + source.y + ' Q ' + cx + ' ' + cy + ' ' + target.x + ' ' + target.y);
        edge.setAttribute('class', 'graph-edge');
        svg.appendChild(edge);
      });
    });

    graphNodes.forEach((agent) => {
      const position = positions.get(agent.id);
      if (!position) {
        return;
      }

      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.setAttribute('class', 'graph-node subagent status-' + normalizeGraphStatus(agent.status));
      group.setAttribute('transform', 'translate(' + position.x + ' ' + position.y + ')');

      const halo = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      halo.setAttribute('r', '16');
      halo.setAttribute('class', 'node-halo');
      group.appendChild(halo);

      const core = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      core.setAttribute('r', '10');
      core.setAttribute('class', 'node-core');
      group.appendChild(core);

      const label = createSvgText(0, 28, agent.id, 'node-label');
      group.appendChild(label);

      const sub = createSvgText(0, 42, summarizeText(agent.prompt || agent.status, 44), 'node-sub');
      group.appendChild(sub);

      const kindSub = createSvgText(0, 56, agent.kind === 'planned' ? 'planned' : 'spawned', 'node-sub');
      kindSub.setAttribute('opacity', '0.72');
      group.appendChild(kindSub);

      if (agent.prompt) {
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = agent.prompt;
        group.appendChild(title);
      }

      svg.appendChild(group);
    });
  }

  function getPlannedSubAgentsForSession(session) {
    const direct = normalizePlannedGraphNodes(session && session.agentGraph ? session.agentGraph : []);
    if (direct.length > 0) {
      return direct;
    }

    return parsePlannedSubAgentsFromEvents(session && session.events ? session.events : []);
  }

  function parsePlannedSubAgentsFromEvents(events) {
    let latest = [];

    for (const event of events || []) {
      const message = typeof event.message === 'string' ? event.message : '';
      if (!message) {
        continue;
      }

      const match = message.match(/tool\\s+agent_graph_set\\s+input\\s+(.+)$/);
      if (!match) {
        continue;
      }

      const parsed = parseAgentGraphInputPreview(match[1]);
      if (!parsed || !Array.isArray(parsed.nodes)) {
        continue;
      }

      const normalized = normalizePlannedGraphNodes(parsed.nodes);
      if (normalized.length > 0) {
        latest = normalized;
      }
    }

    return latest;
  }

  function parseAgentGraphInputPreview(raw) {
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      return null;
    }

    return null;
  }

  function normalizePlannedGraphNodes(rawNodes) {
    if (!Array.isArray(rawNodes)) {
      return [];
    }

    const seen = new Set();
    const nodes = [];
    rawNodes.forEach((rawNode) => {
      if (!rawNode || typeof rawNode !== 'object') {
        return;
      }

      const id = String(rawNode.id || '').trim();
      const prompt = String(rawNode.prompt || '').trim();
      if (!id || !prompt || seen.has(id)) {
        return;
      }

      const dependencies = Array.isArray(rawNode.dependencies)
        ? rawNode.dependencies.map((value) => String(value || '').trim()).filter((value) => value && value !== id)
        : [];

      nodes.push({
        id,
        prompt,
        dependencies,
      });
      seen.add(id);
    });

    return nodes;
  }

  function parseSubAgentsFromEvents(events) {
    const entries = [];
    const byId = new Map();
    let started = 0;

    for (const event of events || []) {
      const message = typeof event.message === 'string' ? event.message : '';
      if (!message) {
        continue;
      }

      const inputMatch = message.match(/tool\\s+subagent_spawn\\s+input\\s+(.+)$/);
      if (inputMatch) {
        started += 1;
        const id = 'sub-' + String(started);
        const prompt = extractSubagentPrompt(inputMatch[1]);
        const current = byId.get(id) || { id, prompt: '', status: 'running' };
        if (prompt) {
          current.prompt = prompt;
        }
        if (!byId.has(id)) {
          byId.set(id, current);
          entries.push(current);
        }
        continue;
      }

      const outputMatch = message.match(/tool\\s+subagent_spawn\\s+output(?:\\s+\\[error\\])?\\s+(.+)$/);
      if (!outputMatch) {
        continue;
      }

      const body = outputMatch[1];
      const statusMatch = body.match(/Sub-agent\\s+(sub-\\d+)\\s+(completed|failed)/i);
      const hasError = message.includes('[error]');
      let id = '';
      let status = hasError ? 'failed' : 'completed';

      if (statusMatch) {
        id = statusMatch[1];
        status = statusMatch[2].toLowerCase() === 'failed' ? 'failed' : 'completed';
      } else {
        const firstRunning = entries.find((entry) => entry.status === 'running');
        if (!firstRunning) {
          continue;
        }
        id = firstRunning.id;
      }

      const current = byId.get(id) || { id, prompt: '', status: 'running' };
      current.status = status;
      if (!current.prompt) {
        current.prompt = summarizeText(body, 120);
      }

      if (!byId.has(id)) {
        byId.set(id, current);
        entries.push(current);
      }
    }

    entries.sort((a, b) => parseSubAgentIndex(a.id) - parseSubAgentIndex(b.id));
    return entries;
  }

  function extractSubagentPrompt(rawInput) {
    if (!rawInput) {
      return '';
    }

    try {
      const parsed = JSON.parse(rawInput);
      if (parsed && typeof parsed === 'object' && typeof parsed.prompt === 'string') {
        return summarizeText(parsed.prompt, 120);
      }
    } catch {
      // fall back to regex extraction from compact preview text
    }

    const match = rawInput.match(/"prompt"\\s*:\\s*"([^"]+)"/);
    if (!match) {
      return '';
    }

    const cleaned = String(match[1]).replace(/\\\\"/g, '"');
    return summarizeText(cleaned, 120);
  }

  function parseSubAgentIndex(id) {
    const match = String(id || '').match(/^sub-(\\d+)$/i);
    if (!match) {
      return Number.MAX_SAFE_INTEGER;
    }
    return Number(match[1]);
  }

  function normalizeGraphStatus(status) {
    if (status === 'running' || status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'planned') {
      return status;
    }
    return 'running';
  }

  function createSvgText(x, y, text, className) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    node.setAttribute('x', String(x));
    node.setAttribute('y', String(y));
    node.setAttribute('class', className);
    node.textContent = text;
    return node;
  }

  async function renderSelectedEvents() {
    const eventsEl = document.getElementById('events');
    if (!selectedWorkId) {
      eventsEl.textContent = 'Select a node or session card to inspect events.';
      return;
    }

    const session = workSessionsCache.find((item) => item.id === selectedWorkId);
    if (!session) {
      eventsEl.textContent = 'Session not found.';
      return;
    }

    const lines = [
      'Agent: ' + session.id,
      'Status: ' + (session.status || 'unknown'),
      'Workspace: ' + (session.workspacePath || '(unknown)'),
      'Model: ' + (session.provider || '(unknown)') + ' / ' + (session.model || '(unknown)'),
      'Prompt: ' + (session.prompt || '(none)'),
    ];

    const live = liveStreamState[selectedWorkId];
    if (live && live.text) {
      lines.push('');
      lines.push('Live stream (SSE):');
      lines.push(live.text);
      lines.push('');
    }

    for (const event of session.events || []) {
      lines.push('[' + event.time + '] ' + event.message);
    }

    if (session.error) {
      lines.push('ERROR: ' + session.error);
    }

    if (session.output && session.output.planPath) {
      lines.push('Plan path: ' + session.output.planPath);
    }

    eventsEl.textContent = lines.length ? lines.join('\\n') : '(no events yet)';
  }

  async function refreshSelectedChat() {
    if (!selectedWorkId) {
      closeChatStreamSubscription();
      chatMessagesCache = [];
      selectedAgentTodos = [];
      renderChatMessages(chatMessagesCache);
      renderSelectedTodos();
      setText('chatStatus', '');
      liveChatState.usage = null;
      liveChatState.usageEstimated = false;
      return;
    }

    if (liveChatState.sessionId && liveChatState.sessionId !== selectedWorkId) {
      closeChatStreamSubscription();
      liveChatState.sessionId = null;
      liveChatState.text = '';
      liveChatState.error = '';
      liveChatState.status = '';
      liveChatState.usage = null;
      liveChatState.usageEstimated = false;
    }

    const data = await api('/api/work/agent?id=' + encodeURIComponent(selectedWorkId));
    chatMessagesCache = data.messages || [];
    selectedAgentTodos = data.todos || [];
    renderChatMessages(chatMessagesCache);
    renderSelectedTodos();
  }

  async function sendChatMessage() {
    if (chatBusy) {
      return;
    }

    if (!selectedWorkId) {
      setText('chatStatus', 'Select an agent session first.');
      return;
    }

    const message = document.getElementById('chatInput').value.trim();
    if (!message) {
      setText('chatStatus', 'Message is required.');
      return;
    }

    chatBusy = true;
    setText('chatStatus', 'Streaming reply from selected agent...');

    try {
      await streamChatMessage(selectedWorkId, message);
      document.getElementById('chatInput').value = '';
      setText('chatStatus', 'Reply received via SSE. Context retained for this agent session.');
    } finally {
      chatBusy = false;
    }
  }

  async function startWork() {
    const workspaceId = document.getElementById('workWorkspace').value.trim();
    const prompt = document.getElementById('workPrompt').value.trim();
    const provider = document.getElementById('workProvider').value.trim();
    const model = document.getElementById('workModel').value.trim();
    const autoApprove = document.getElementById('autoApprove').checked;

    if (!prompt) {
      setText('workStatus', 'Prompt is required.');
      return;
    }

    if (!provider) {
      setText('workStatus', 'Select a connected provider first.');
      return;
    }

    if (!model) {
      setText('workStatus', 'Select a model for the connected provider.');
      return;
    }

    const result = await api('/api/work/start', 'POST', {
      workspaceId,
      prompt,
      provider,
      model,
      autoApprove,
    });
    selectedWorkId = result.id;
    setText('workStatus', 'Started work session: ' + result.id);
    await refreshWorkSessions();
  }

  async function startAuth() {
    const flowVersion = ++authFlowVersion;
    const providerId = document.getElementById('authProvider').value;
    const provider = providerCache.find((item) => item.id === providerId);

    if (!provider) {
      setText('authStatus', 'Choose a provider first.');
      return;
    }

    if (provider.authType === 'api-key') {
      setText('authStatus', 'Provider ' + provider.id + ' requires API key setup in CLI.');
      document.getElementById('authSession').textContent = 'Run: pnpm --filter @orchestrace/cli dev auth ' + provider.id;
      return;
    }

    const result = await api('/api/auth/start', 'POST', { providerId });
    if (flowVersion !== authFlowVersion) {
      return;
    }

    if (document.getElementById('authProvider').value !== providerId) {
      return;
    }

    activeAuthSessionId = result.sessionId;
    setText('authStatus', 'Auth session started: ' + result.sessionId);

    if (authPollId) clearInterval(authPollId);
    authPollId = setInterval(async () => {
      if (flowVersion !== authFlowVersion) {
        if (authPollId) {
          clearInterval(authPollId);
          authPollId = null;
        }
        return;
      }

      try {
        const sessionResult = await api('/api/auth/session?id=' + encodeURIComponent(activeAuthSessionId));
        if (flowVersion !== authFlowVersion) {
          return;
        }

        if (document.getElementById('authProvider').value !== sessionResult.session.providerId) {
          return;
        }

        renderAuthSession(sessionResult.session);
        if (sessionResult.session.state === 'completed' || sessionResult.session.state === 'failed') {
          clearInterval(authPollId);
          authPollId = null;
          await refreshProviders();
        }
      } catch (error) {
        setText('authStatus', String(error));
      }
    }, 1200);
  }

  function renderAuthSession(session) {
    const promptRow = document.getElementById('authPromptRow');
    if (document.getElementById('authProvider').value !== session.providerId) {
      promptRow.style.display = 'none';
      return;
    }

    const lines = [
      'provider: ' + session.providerId,
      'state: ' + session.state,
    ];

    if (session.authUrl) lines.push('url: ' + session.authUrl);
    if (session.authInstructions) lines.push('instructions: ' + session.authInstructions);
    if (session.promptMessage) lines.push('prompt: ' + session.promptMessage);
    if (session.error) lines.push('error: ' + session.error);

    promptRow.style.display = session.state === 'awaiting-input' ? 'grid' : 'none';

    document.getElementById('authSession').textContent = lines.join('\\n');
  }

  async function sendAuthPromptInput() {
    if (!activeAuthSessionId) {
      setText('authStatus', 'No active auth session. Start authentication first.');
      return;
    }

    const value = document.getElementById('authPromptInput').value;
    await api('/api/auth/respond', 'POST', { sessionId: activeAuthSessionId, value });
    document.getElementById('authPromptInput').value = '';
  }

  function setText(id, text) {
    document.getElementById(id).textContent = text;
  }

  function escapeHtml(text) {
    return String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }

  document.getElementById('themeLight').addEventListener('click', () => applyTheme('light'));
  document.getElementById('themeDark').addEventListener('click', () => applyTheme('dark'));
  document.getElementById('screenSettings').addEventListener('click', () => applyScreen('settings'));
  document.getElementById('screenWorking').addEventListener('click', () => applyScreen('working'));
  document.getElementById('authProvider').addEventListener('change', () => {
    authFlowVersion += 1;
    if (authPollId) {
      clearInterval(authPollId);
      authPollId = null;
    }
    activeAuthSessionId = null;
    document.getElementById('authPromptRow').style.display = 'none';
    document.getElementById('authSession').textContent = 'No auth session started.';
    setText('authStatus', '');
    syncAuthUiForProvider();
    refreshWorkspaceReadiness().catch((e) => setText('workspaceStatus', String(e)));
  });
  document.getElementById('workspaceAdd').addEventListener('click', () => addWorkspace().catch((e) => setText('workspaceStatus', String(e))));
  document.getElementById('workspaceActivate').addEventListener('click', () => activateWorkspace().catch((e) => setText('workspaceStatus', String(e))));
  document.getElementById('workspaceRemove').addEventListener('click', () => removeWorkspace().catch((e) => setText('workspaceStatus', String(e))));
  document.getElementById('workspaceSelect').addEventListener('change', () => {
    const selected = document.getElementById('workspaceSelect').value;
    if (selected) {
      document.getElementById('workWorkspace').value = selected;
    }
  });
  document.getElementById('workProvider').addEventListener('change', () => {
    refreshWorkModels()
      .then(() => refreshWorkspaceReadiness())
      .catch((e) => setText('workStatus', String(e)));
  });
  document.getElementById('workStart').addEventListener('click', () => startWork().catch((e) => setText('workStatus', String(e))));
  document.getElementById('graphDeleteSelected').addEventListener('click', () => deleteSelectedGraphSession().catch((e) => setText('workStatus', String(e))));
  document.getElementById('chatSend').addEventListener('click', () => sendChatMessage().catch((e) => setText('chatStatus', String(e))));
  document.getElementById('todoAdd').addEventListener('click', () => addAgentTodo().catch((e) => setText('todoStatus', String(e))));
  document.getElementById('todoInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addAgentTodo().catch((e) => setText('todoStatus', String(e)));
    }
  });
  document.getElementById('authStart').addEventListener('click', () => startAuth().catch((e) => setText('authStatus', String(e))));
  document.getElementById('authPromptSend').addEventListener('click', () => sendAuthPromptInput().catch((e) => setText('authStatus', String(e))));

  initTheme();
  initScreen();
  initHmr();
  refreshWorkspaces().catch((e) => setText('workspaceStatus', String(e)));
  refreshProviders().catch((e) => setText('authStatus', String(e)));
  refreshWorkSessions().catch((e) => setText('workStatus', String(e)));
  renderSelectedTodos();
  setInterval(() => refreshWorkSessions().catch(() => {}), 2000);
</script>
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
