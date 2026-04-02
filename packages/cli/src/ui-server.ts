import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
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
  error?: string;
  output?: { text?: string; planPath?: string };
  controller: AbortController;
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
  const chatStreams = new Map<string, ChatTokenStream>();
  const hmrClients = new Set<ServerResponse>();
  const workStreamClients = new Map<string, Set<ServerResponse>>();
  const chatStreamClients = new Map<string, Set<ServerResponse>>();

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
          controller,
        };

        workSessions.set(id, session);
        sessionChats.set(id, createSessionChatThread(session));

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
          createToolset: ({ phase, task }) => createAgentToolset({
            cwd: workspace.path,
            phase,
            taskType: task.type,
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

            if ('taskId' in event && event.type !== 'task:stream-delta') {
              session.taskStatus[event.taskId] = event.type;
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
          closeWorkStream(workStreamClients, session.id);

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
            closeWorkStream(workStreamClients, session.id);
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
          closeWorkStream(workStreamClients, session.id);
        }

        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/work') {
        const sessions = [...workSessions.values()]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(serializeWorkSession);
        sendJson(res, 200, { sessions });
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

        const userMessage: SessionChatMessage = {
          role: 'user',
          content: message,
          time: now(),
        };
        thread.messages.push(userMessage);
        trimThreadMessages(thread);
        thread.updatedAt = now();

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
      transition: transform 180ms ease;
    }

    .graph-node:hover {
      transform: translateY(-2px);
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
          <div class="legend">
            <span class="running">running</span>
            <span class="completed">completed</span>
            <span class="failed">failed</span>
            <span class="cancelled">cancelled</span>
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
        <div id="chatMessages" class="events">Select an agent session to chat and continue with context.</div>
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
    if (!selectedSession || selectedSession.status !== 'running') {
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

    source.addEventListener('end', (event) => {
      try {
        const payload = JSON.parse(event.data || '{}');
        if (payload && payload.id && selectedWorkId === payload.id) {
          renderSelectedEvents().catch(() => {});
        }
      } catch {
        // ignore malformed stream payloads
      }
      closeWorkStreamSubscription();
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

  function renderChatMessages(messages) {
    const chatEl = document.getElementById('chatMessages');
    const lines = [];

    for (const message of messages || []) {
      const role = message.role === 'assistant' ? 'Agent' : 'You';
      lines.push('[' + message.time + '] ' + role + ': ' + message.content);
      if (message.usage) {
        lines.push('  tokens in/out: ' + message.usage.input + '/' + message.usage.output + ', cost: $' + Number(message.usage.cost || 0).toFixed(4));
      }
    }

    if (liveChatState.sessionId === selectedWorkId) {
      if (liveChatState.text) {
        lines.push('');
        lines.push('[live] Agent: ' + liveChatState.text);
      }
      if (liveChatState.usage) {
        const prefix = liveChatState.usageEstimated ? '[live][est]' : '[live]';
        lines.push(
          prefix + ' tokens in/out: '
            + liveChatState.usage.input + '/' + liveChatState.usage.output
            + ', cost: $' + Number(liveChatState.usage.cost || 0).toFixed(4),
        );
      }
      if (liveChatState.error) {
        lines.push('');
        lines.push('[live] ERROR: ' + liveChatState.error);
      }
    }

    chatEl.textContent = lines.length ? lines.join('\\n') : '(no messages yet)';
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
          + '<button class="danger" data-cancel="' + session.id + '">Cancel</button>'
        + '</div>';

      root.appendChild(card);
    }

    root.querySelectorAll('button[data-view]').forEach((button) => {
      button.addEventListener('click', async () => {
        selectedWorkId = button.getAttribute('data-view');
        renderSessionList(workSessionsCache);
        renderSessionGraph(workSessionsCache);
        await renderSelectedEvents();
        await refreshSelectedChat();
        ensureWorkStreamSubscription();
      });
    });

    root.querySelectorAll('button[data-cancel]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.getAttribute('data-cancel');
        await api('/api/work/cancel', 'POST', { id });
        await refreshWorkSessions();
      });
    });
  }

  function renderSessionGraph(sessions) {
    const svg = document.getElementById('sessionGraph');
    svg.innerHTML = '';

    if (!sessions.length) {
      svg.setAttribute('viewBox', '0 0 620 280');
      const text = createSvgText(310, 140, 'No sessions yet', 'node-label');
      text.setAttribute('text-anchor', 'middle');
      svg.appendChild(text);
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
        selectedWorkId = session.id;
        renderSessionList(workSessionsCache);
        renderSessionGraph(workSessionsCache);
        await renderSelectedEvents();
        await refreshSelectedChat();
        ensureWorkStreamSubscription();
      });

      svg.appendChild(group);
    });
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

    const lines = ['Workspace: ' + (session.workspacePath || '(unknown)')];

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
      document.getElementById('chatMessages').textContent = 'Select an agent session to chat and continue with context.';
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

    const data = await api('/api/work/chat?id=' + encodeURIComponent(selectedWorkId));
    chatMessagesCache = data.messages || [];
    renderChatMessages(chatMessagesCache);
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
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
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
  document.getElementById('chatSend').addEventListener('click', () => sendChatMessage().catch((e) => setText('chatStatus', String(e))));
  document.getElementById('authStart').addEventListener('click', () => startAuth().catch((e) => setText('authStatus', String(e))));
  document.getElementById('authPromptSend').addEventListener('click', () => sendAuthPromptInput().catch((e) => setText('authStatus', String(e))));

  initTheme();
  initScreen();
  initHmr();
  refreshWorkspaces().catch((e) => setText('workspaceStatus', String(e)));
  refreshProviders().catch((e) => setText('authStatus', String(e)));
  refreshWorkSessions().catch((e) => setText('workStatus', String(e)));
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
