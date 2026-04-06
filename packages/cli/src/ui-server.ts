import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { orchestrate, PromptSectionName, renderPromptSections } from '@orchestrace/core';
import type { DagEvent, PlanApprovalRequest, PromptSection, TaskGraph } from '@orchestrace/core';
import { getModels } from '@mariozechner/pi-ai';
import { PiAiAdapter, ProviderAuthManager, type LlmToolCallEvent } from '@orchestrace/provider';
import {
  createWorktree,
  WorktreeLockError,
  type WorktreeHandle,
  type WorktreeStartupWarning,
} from '@orchestrace/sandbox';
import {
  DEFAULT_AGENT_TOOL_POLICY_VERSION,
  createAgentToolset,
  listAgentTools,
  type AgentToolPhase,
} from '@orchestrace/tools';
import { now } from './ui-server/clock.js';
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
import { broadcastTodoUpdate, broadcastWorkStream, closeWorkStream, sendSse } from './ui-server/sse.js';
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
  SessionLlmStatus,
  UiDagEvent,
  UiPreferences,
  UiServerOptions,
  WorkSession,
  WorkState,
  LlmSessionState,
} from './ui-server/types.js';
import { WorkspaceManager } from './workspace-manager.js';

const SUB_AGENT_READ_ONLY_TOOL_ALLOWLIST = [
  'list_directory',
  'read_file',
  'search_files',
  'git_diff',
  'git_status',
];

const GITHUB_PROVIDER_ID = 'github';
const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_DEVICE_AUTH_SCOPES_DEFAULT = ['repo', 'workflow', 'read:org'];
// Public OAuth app client id used for GitHub device flow (mirrors CLI-style auth UX).
const GITHUB_DEVICE_AUTH_CLIENT_ID_DEFAULT = '178c6fc778ccc68e1d6a';
const DEFAULT_UI_ADAPTIVE_CONCURRENCY = false;
const DEFAULT_UI_BATCH_CONCURRENCY = 8;
const DEFAULT_UI_BATCH_MIN_CONCURRENCY = 1;
const SUBAGENT_WORKER_PROMPT_PREVIEW_MAX_CHARS = 2_000;
const SUBAGENT_WORKER_OUTPUT_PREVIEW_MAX_CHARS = 4_000;
const LLM_STATUS_MIN_EMIT_INTERVAL_MS = 1_500;

type LlmStatusEmissionState = {
  key: string;
  emittedAt: number;
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

function createReadOnlySubAgentToolset(
  cwd: string,
  options?: { adaptiveConcurrency?: boolean; batchConcurrency?: number; batchMinConcurrency?: number },
) {
  return createAgentToolset({
    cwd,
    phase: 'planning',
    adaptiveConcurrency: options?.adaptiveConcurrency,
    batchConcurrency: options?.batchConcurrency,
    batchMinConcurrency: options?.batchMinConcurrency,
    permissions: {
      allowWriteTools: false,
      allowRunCommand: false,
      toolAllowlist: [...SUB_AGENT_READ_ONLY_TOOL_ALLOWLIST],
    },
  });
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

  const workSessions = new Map<string, WorkSession>();
  const authSessions = new Map<string, AuthSession>();
  const githubDeviceAuthSessions = new Map<string, GithubDeviceAuthSession>();
  const sessionChats = new Map<string, SessionChatThread>();
  const sessionTodos = new Map<string, AgentTodoItem[]>();
  const pendingSubagentNodeIdsBySession = new Map<string, Map<string, string[]>>();
  const chatStreams = new Map<string, ChatTokenStream>();
  let uiPreferences = resolveUiPreferencesDefaults();
  const hmrClients = new Set<ServerResponse>();
  const workStreamClients = new Map<string, Set<ServerResponse>>();
  const chatStreamClients = new Map<string, Set<ServerResponse>>();
  const uiStatePath = join(workspaceManager.getRootDir(), '.orchestrace', 'ui-state.json');

  const restoredUiPreferences = await restoreUiState(uiStatePath, workSessions, sessionChats, sessionTodos);
  uiPreferences = normalizeUiPreferences(restoredUiPreferences, resolveUiPreferencesDefaults());

  const uiStatePersistence = createUiStatePersistence(
    uiStatePath,
    workSessions,
    sessionChats,
    sessionTodos,
    () => ({ ...uiPreferences }),
  );

  function deleteWorkSession(id: string): boolean {
    const session = workSessions.get(id);
    if (!session) {
      return false;
    }

    if (session.status === 'running') {
      session.controller.abort();
      session.status = 'cancelled';
      session.updatedAt = now();
      session.llmStatus = createLlmStatus('cancelled', session.updatedAt, {
        detail: 'Cancelled by user.',
      });
    }

    if (session.cleanupWorktree) {
      void session.cleanupWorktree().catch(() => {});
      session.cleanupWorktree = undefined;
    }

    closeWorkStream(workStreamClients, id);
    workSessions.delete(id);
    sessionChats.delete(id);
    sessionTodos.delete(id);
    pendingSubagentNodeIdsBySession.delete(id);

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

  async function startWorkSession(request: {
    workspaceId?: string;
    prompt: string;
    promptParts?: SessionChatContentPart[];
    provider: string;
    model: string;
    autoApprove: boolean;
    adaptiveConcurrency?: boolean;
    batchConcurrency?: number;
    batchMinConcurrency?: number;
  }): Promise<{ id: string; warnings?: WorktreeStartupWarning[] } | { error: string; statusCode: number }> {
    const promptParts = cloneChatContentParts(request.promptParts ?? []);
    const prompt = asString(request.prompt);

    const providerStatuses = await authManager.getAllStatus();
    const providerStatus = providerStatuses.find((item) => item.provider === request.provider);
    if (!providerStatus || providerStatus.source === 'none') {
      return {
        error: `Provider ${request.provider} is not connected. Connect it in Settings first.`,
        statusCode: 400,
      };
    }

    const workspace = request.workspaceId
      ? await workspaceManager.selectWorkspace(request.workspaceId)
      : await workspaceManager.getActiveWorkspace();

    if (!prompt && promptParts.length === 0) {
      return { error: 'Missing prompt', statusCode: 400 };
    }

    const normalizedPrompt = promptParts.length > 0
      ? compactInlineImageMarkdown(prompt || summarizeChatContentParts(promptParts))
      : (prompt || summarizeChatContentParts(promptParts));

    const id = randomUUID();
    const adaptiveConcurrency = request.adaptiveConcurrency ?? uiPreferences.adaptiveConcurrency;
    const batchConcurrency = normalizePositiveSetting(request.batchConcurrency, uiPreferences.batchConcurrency);
    const batchMinConcurrency = Math.min(
      batchConcurrency,
      normalizePositiveSetting(request.batchMinConcurrency, uiPreferences.batchMinConcurrency),
    );

    let worktreeHandle: WorktreeHandle;
    let executionPath = workspace.path;
    let startupWarnings: WorktreeStartupWarning[] | undefined;
    try {
      worktreeHandle = await createWorktree(workspace.path, `session-${id}`);
      executionPath = worktreeHandle.path;
      startupWarnings = worktreeHandle.warnings;
    } catch (error) {
      if (error instanceof WorktreeLockError) {
        return {
          error: `Worktree is currently in use by another session (${error.metadata?.host ?? 'unknown host'} pid ${error.metadata?.pid ?? 'unknown'}).`,
          statusCode: 409,
        };
      }
      return {
        error: `Failed to create worktree: ${toErrorMessage(error)}`,
        statusCode: 500,
      };
    }

    const controller = new AbortController();
    const createdAt = now();
    let lastLlmStatusEmission: LlmStatusEmissionState | undefined;

    const session: WorkSession = {
      id,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePath: executionPath,
      prompt: normalizedPrompt,
      promptParts: promptParts.length > 0 ? cloneChatContentParts(promptParts) : undefined,
      provider: request.provider,
      model: request.model,
      autoApprove: request.autoApprove,
      adaptiveConcurrency,
      batchConcurrency,
      batchMinConcurrency,
      worktreePath: worktreeHandle.path,
      worktreeBranch: worktreeHandle.branch,
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
      cleanupWorktree: () => worktreeHandle.cleanup(),
    };

    workSessions.set(id, session);
    sessionChats.set(id, createSessionChatThread(session, promptParts));
    sessionTodos.set(id, []);
    uiStatePersistence.schedule();
    broadcastTodoUpdate(workStreamClients, id, sessionTodos.get(id) ?? []);

    const graph = buildSingleTaskGraph(id, normalizedPrompt);

    void orchestrate(graph, {
      llm,
      cwd: session.workspacePath,
      planOutputDir: join(session.workspacePath, '.orchestrace', 'plans'),
      promptVersion: process.env.ORCHESTRACE_PROMPT_VERSION,
      policyVersion: process.env.ORCHESTRACE_POLICY_VERSION ?? DEFAULT_AGENT_TOOL_POLICY_VERSION,
      defaultModel: { provider: request.provider, model: request.model },
      planningSystemPrompt: buildPlanningSystemPrompt(session),
      implementationSystemPrompt: buildImplementationSystemPrompt(session),
      maxParallel: 1,
      requirePlanApproval: !request.autoApprove,
      onPlanApproval: async (_approvalRequest: PlanApprovalRequest) => request.autoApprove,
      signal: controller.signal,
      resolveApiKey: async (providerId) => authManager.resolveApiKey(providerId),
      createToolset: ({ phase, task, graphId, provider: activeProvider, model: activeModel, reasoning }) => createAgentToolset({
        cwd: session.workspacePath,
        phase,
        taskType: task.type,
        graphId,
        taskId: task.id,
        provider: activeProvider,
        model: activeModel,
        reasoning,
        adaptiveConcurrency: session.adaptiveConcurrency,
        batchConcurrency: session.batchConcurrency,
        batchMinConcurrency: session.batchMinConcurrency,
        resolveGithubToken: () => githubAuthManager.resolveApiKey(GITHUB_PROVIDER_ID),
        runSubAgent: async (runSubAgentRequest, _signal) => {
          const subProvider = runSubAgentRequest.provider ?? activeProvider;
          const subModel = runSubAgentRequest.model ?? activeModel;
          const subAgentSignal = session.controller.signal;
          const subAgentToolset = createReadOnlySubAgentToolset(session.workspacePath, {
            adaptiveConcurrency: session.adaptiveConcurrency,
            batchConcurrency: session.batchConcurrency,
            batchMinConcurrency: session.batchMinConcurrency,
          });
          const subAgent = await llm.spawnAgent({
            provider: subProvider,
            model: subModel,
            reasoning: runSubAgentRequest.reasoning ?? reasoning,
            timeoutMs: resolveSubAgentTimeoutMs(),
            systemPrompt: runSubAgentRequest.systemPrompt
              ?? 'You are a focused sub-agent. Use only the provided task-relevant context, avoid unrelated history, and return concise actionable output.',
            signal: subAgentSignal,
            toolset: subAgentToolset,
            apiKey: await authManager.resolveApiKey(subProvider),
                      refreshApiKey: () => authManager.resolveApiKey(subProvider),
          });

          const result = await subAgent.complete(runSubAgentRequest.prompt, subAgentSignal);
          return {
            text: result.text,
            usage: result.usage,
          };
        },
      }),
      onEvent: (event) => {
        session.updatedAt = now();
        const llmStatus = deriveLlmStatusFromDagEvent(event, session.updatedAt);
        if (llmStatus && shouldEmitLlmStatus(llmStatus, lastLlmStatusEmission, session.updatedAt)) {
          session.llmStatus = llmStatus;
          lastLlmStatusEmission = {
            key: llmStatusIdentityKey(llmStatus),
            emittedAt: parseTimestamp(session.updatedAt),
          };
        }

        if (event.type === 'task:stream-delta') {
          broadcastWorkStream(workStreamClients, session.id, 'token', {
            id: session.id,
            taskId: event.taskId,
            phase: event.phase,
            attempt: event.attempt,
            delta: event.delta,
            llmStatus: session.llmStatus,
            time: now(),
          });
        }

        const uiEvent = toUiEvent(session.id, event);
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

        if (event.type === 'task:tool-call') {
          const graphProgressChanged = applyAgentGraphProgressFromToolEvent(
            session,
            event,
            pendingSubagentNodeIdsBySession,
          );
          if (graphProgressChanged) {
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

      const allOutputs = [...outputs.values()];
      const failedOutput = allOutputs.find((output) => output.status === 'failed');
      const primaryOutput = failedOutput ?? allOutputs[0];
      const failed = Boolean(failedOutput);
      const failureType = failedOutput?.failureType;

      session.status = failed ? 'failed' : 'completed';
      session.updatedAt = now();
      session.llmStatus = failed
        ? createLlmStatus('failed', session.updatedAt, {
          detail: failureType
            ? `${failureType}: ${failedOutput?.error || 'Execution failed.'}`
            : (failedOutput?.error || 'Execution failed.'),
          failureType,
        })
        : createLlmStatus('completed', session.updatedAt, {
          detail: 'Run completed successfully.',
        });
      lastLlmStatusEmission = {
        key: llmStatusIdentityKey(session.llmStatus),
        emittedAt: parseTimestamp(session.updatedAt),
      };
      session.output = {
        text: primaryOutput?.response,
        planPath: primaryOutput?.planPath,
        failureType,
      };
      session.error = failed ? failedOutput?.error ?? 'Execution failed' : undefined;

      broadcastWorkStream(workStreamClients, session.id, 'end', {
        id: session.id,
        status: session.status,
        llmStatus: session.llmStatus,
        time: now(),
      });

      const thread = sessionChats.get(session.id);
      if (thread && primaryOutput?.response) {
        thread.messages.push({
          role: 'assistant',
          content: primaryOutput.response,
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
        session.llmStatus = createLlmStatus('failed', session.updatedAt, {
          detail: session.error,
        });

        broadcastWorkStream(workStreamClients, session.id, 'error', {
          id: session.id,
          error: session.error,
          llmStatus: session.llmStatus,
          time: now(),
        });
        uiStatePersistence.schedule();
      }
    });

    return { id, warnings: startupWarnings && startupWarnings.length > 0 ? startupWarnings : undefined };
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
          llmStatus: session.llmStatus,
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
        uiStatePersistence.schedule();
        sendJson(res, 200, { preferences: { ...uiPreferences } });
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
        const body = await readJsonBody(req);
        const workspaceId = asString(body.workspaceId);
        const prompt = asString(body.prompt);
        const promptParts = parseChatContentParts(body.promptParts);
        const provider = asString(body.provider) || process.env.ORCHESTRACE_DEFAULT_PROVIDER || 'anthropic';
        const model = asString(body.model) || process.env.ORCHESTRACE_DEFAULT_MODEL || 'claude-sonnet-4-20250514';
        const autoApprove = Boolean(body.autoApprove);
        const adaptiveConcurrency = parseBooleanSetting(body.adaptiveConcurrency)
          ?? parseBooleanSetting(body.adaptiveToolConcurrency);
        const batchConcurrency = parsePositiveSetting(body.batchConcurrency)
          ?? parsePositiveSetting(body.toolBatchConcurrency);
        const batchMinConcurrency = parsePositiveSetting(body.batchMinConcurrency)
          ?? parsePositiveSetting(body.toolBatchMinConcurrency);
        const result = await startWorkSession({
          workspaceId,
          prompt,
          promptParts,
          provider,
          model,
          autoApprove,
          adaptiveConcurrency,
          batchConcurrency,
          batchMinConcurrency,
        });

        if ('error' in result) {
          sendJson(res, result.statusCode, { error: result.error });
          return;
        }

        sendJson(res, 200, {
          id: result.id,
          warnings: result.warnings,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/work/retry') {
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
        const retryPrompt = mergeRetryPromptWithFollowUp({
          prompt: sourceSession.prompt,
          followUpText,
          followUpParts,
        });
        const retryPromptParts = mergeRetryPromptPartsWithFollowUp({
          promptParts: sourceSession.promptParts,
          followUpText,
          followUpParts,
        });

        const result = await startWorkSession({
          workspaceId: sourceSession.workspaceId,
          prompt: retryPrompt,
          promptParts: retryPromptParts,
          provider: sourceSession.provider,
          model: sourceSession.model,
          autoApprove: sourceSession.autoApprove,
          adaptiveConcurrency: sourceSession.adaptiveConcurrency,
          batchConcurrency: sourceSession.batchConcurrency,
          batchMinConcurrency: sourceSession.batchMinConcurrency,
        });

        if ('error' in result) {
          sendJson(res, result.statusCode, { error: result.error });
          return;
        }

        sendJson(res, 200, {
          id: result.id,
          sourceId: id,
          warnings: result.warnings,
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
          adaptiveConcurrency: session.adaptiveConcurrency,
          batchConcurrency: session.batchConcurrency,
          batchMinConcurrency: session.batchMinConcurrency,
          resolveGithubToken: () => githubAuthManager.resolveApiKey(GITHUB_PROVIDER_ID),
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
              timeoutMs: resolveLongTurnTimeoutMs(),
              systemPrompt: buildChatSystemPrompt(session),
              toolset: createAgentToolset({
                cwd: session.workspacePath,
                phase: 'chat',
                adaptiveConcurrency: session.adaptiveConcurrency,
                batchConcurrency: session.batchConcurrency,
                batchMinConcurrency: session.batchMinConcurrency,
                resolveGithubToken: () => githubAuthManager.resolveApiKey(GITHUB_PROVIDER_ID),
                runSubAgent: async (runSubAgentRequest, _signal) => {
                  const subProvider = runSubAgentRequest.provider ?? session.provider;
                  const subModel = runSubAgentRequest.model ?? session.model;
                  const subAgentSignal = session.controller.signal;
                  const subAgentToolset = createReadOnlySubAgentToolset(session.workspacePath, {
                    adaptiveConcurrency: session.adaptiveConcurrency,
                    batchConcurrency: session.batchConcurrency,
                    batchMinConcurrency: session.batchMinConcurrency,
                  });
                  const subAgent = await llm.spawnAgent({
                    provider: subProvider,
                    model: subModel,
                    reasoning: runSubAgentRequest.reasoning,
                    timeoutMs: resolveSubAgentTimeoutMs(),
                    systemPrompt: runSubAgentRequest.systemPrompt
                      ?? 'You are a focused sub-agent. Use only the provided task-relevant context, avoid unrelated history, and return concise actionable output.',
                    signal: subAgentSignal,
                    toolset: subAgentToolset,
                    apiKey: await authManager.resolveApiKey(subProvider),
                      refreshApiKey: () => authManager.resolveApiKey(subProvider),
                  });

                  const result = await subAgent.complete(runSubAgentRequest.prompt, subAgentSignal);
                  return {
                    text: result.text,
                    usage: result.usage,
                  };
                },
              }),
              apiKey: await authManager.resolveApiKey(session.provider),
                refreshApiKey: () => authManager.resolveApiKey(session.provider),
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
              onToolCall: (toolEvent) => {
                handleChatToolCallEvent(
                  session,
                  toolEvent,
                  sessionTodos,
                  pendingSubagentNodeIdsBySession,
                  workStreamClients,
                  uiStatePersistence,
                );
              },
            });

            const responseText = ensureFollowUpSuggestions(response.text, 'chat');

            const assistantMessage: SessionChatMessage = {
              role: 'assistant',
              content: responseText,
              time: now(),
              usage: response.usage,
            };

            thread.messages.push(assistantMessage);
            trimThreadMessages(thread);
            thread.updatedAt = now();
            session.updatedAt = now();
            uiStatePersistence.schedule();

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
          timeoutMs: resolveLongTurnTimeoutMs(),
          systemPrompt: buildChatSystemPrompt(session),
          toolset: createAgentToolset({
            cwd: session.workspacePath,
            phase: 'chat',
            adaptiveConcurrency: session.adaptiveConcurrency,
            batchConcurrency: session.batchConcurrency,
            batchMinConcurrency: session.batchMinConcurrency,
            resolveGithubToken: () => githubAuthManager.resolveApiKey(GITHUB_PROVIDER_ID),
            runSubAgent: async (runSubAgentRequest, _signal) => {
              const subProvider = runSubAgentRequest.provider ?? session.provider;
              const subModel = runSubAgentRequest.model ?? session.model;
              const subAgentSignal = session.controller.signal;
              const subAgentToolset = createReadOnlySubAgentToolset(session.workspacePath, {
                adaptiveConcurrency: session.adaptiveConcurrency,
                batchConcurrency: session.batchConcurrency,
                batchMinConcurrency: session.batchMinConcurrency,
              });
              const subAgent = await llm.spawnAgent({
                provider: subProvider,
                model: subModel,
                reasoning: runSubAgentRequest.reasoning,
                timeoutMs: resolveSubAgentTimeoutMs(),
                systemPrompt: runSubAgentRequest.systemPrompt
                  ?? 'You are a focused sub-agent. Use only the provided task-relevant context, avoid unrelated history, and return concise actionable output.',
                signal: subAgentSignal,
                toolset: subAgentToolset,
                apiKey: await authManager.resolveApiKey(subProvider),
                refreshApiKey: () => authManager.resolveApiKey(subProvider),
              });

              const result = await subAgent.complete(runSubAgentRequest.prompt, subAgentSignal);
              return {
                text: result.text,
                usage: result.usage,
              };
            },
          }),
          apiKey: await authManager.resolveApiKey(session.provider),
          refreshApiKey: () => authManager.resolveApiKey(session.provider),
        });

        const chatPrompt = buildChatContinuationInput(thread);
        const response = await chatAgent.complete(chatPrompt, undefined, {
          onToolCall: (toolEvent) => {
            handleChatToolCallEvent(
              session,
              toolEvent,
              sessionTodos,
              pendingSubagentNodeIdsBySession,
              workStreamClients,
              uiStatePersistence,
            );
          },
        });
        const text = ensureFollowUpSuggestions(response.text, 'chat');

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

  return payload.preferences;
}

async function persistUiState(
  path: string,
  workSessions: Map<string, WorkSession>,
  sessionChats: Map<string, SessionChatThread>,
  sessionTodos: Map<string, AgentTodoItem[]>,
  preferences: UiPreferences,
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
    preferences: { ...preferences },
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
      preferences: isRecord(parsed.preferences) ? parsed.preferences as PersistedUiPreferences : undefined,
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
    provider: session.provider,
    model: session.model,
    autoApprove: session.autoApprove,
    adaptiveConcurrency: session.adaptiveConcurrency,
    batchConcurrency: session.batchConcurrency,
    batchMinConcurrency: session.batchMinConcurrency,
    worktreePath: session.worktreePath,
    worktreeBranch: session.worktreeBranch,
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
  const resumedLlmStatus = session.llmStatus
    ? normalizeLlmStatus(session.llmStatus, resumedUpdatedAt)
    : deriveLlmStatusFromWorkState(resumedStatus, resumedUpdatedAt, resumedError);

  return {
    ...session,
    promptParts: promptParts.length > 0 ? promptParts : undefined,
    adaptiveConcurrency: parseBooleanSetting(session.adaptiveConcurrency) ?? resolveAdaptiveConcurrencyDefault(),
    batchConcurrency: normalizePositiveSetting(session.batchConcurrency, resolveBatchConcurrencyDefault()),
    batchMinConcurrency: Math.min(
      normalizePositiveSetting(session.batchConcurrency, resolveBatchConcurrencyDefault()),
      normalizePositiveSetting(session.batchMinConcurrency, resolveBatchMinConcurrencyDefault()),
    ),
    worktreePath: asString(session.worktreePath) || session.workspacePath,
    worktreeBranch: asString(session.worktreeBranch) || 'unknown',
    agentGraph: normalizeSessionAgentGraphNodes(session.agentGraph),
    status: resumedStatus,
    llmStatus: resumedLlmStatus,
    error: resumedError,
    controller: new AbortController(),
    cleanupWorktree: undefined,
  };
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

async function waitMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function resolveGithubAuthStatus(authManager: ProviderAuthManager): Promise<Record<string, unknown>> {
  const status = await authManager.getStatus(GITHUB_PROVIDER_ID);
  const token = await authManager.resolveApiKey(GITHUB_PROVIDER_ID);
  if (!token) {
    return {
      connected: false,
      source: status.source,
      storedApiKeyConfigured: status.storedApiKeyConfigured,
      scopes: [],
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
        isolated: true,
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
    300_000,
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

function resolveUiPreferencesDefaults(): UiPreferences {
  const batchConcurrency = resolveBatchConcurrencyDefault();
  const batchMinConcurrency = Math.min(batchConcurrency, resolveBatchMinConcurrencyDefault());
  return {
    adaptiveConcurrency: resolveAdaptiveConcurrencyDefault(),
    batchConcurrency,
    batchMinConcurrency,
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

  return {
    adaptiveConcurrency: parseBooleanSetting(value.adaptiveConcurrency) ?? fallback.adaptiveConcurrency,
    batchConcurrency,
    batchMinConcurrency,
  };
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

function resolveSessionToolMode(session: WorkSession): AgentToolPhase {
  const phase = session.llmStatus.phase;
  if (phase === 'planning' || phase === 'implementation') {
    return phase;
  }

  switch (session.llmStatus.state) {
    case 'queued':
    case 'analyzing':
    case 'thinking':
    case 'planning':
    case 'awaiting-approval':
      return 'planning';
    default:
      return 'implementation';
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

function deriveLlmStatusFromDagEvent(event: DagEvent, updatedAt: string): SessionLlmStatus | undefined {
  switch (event.type) {
    case 'task:ready':
    case 'task:started':
    case 'task:planning':
      return createLlmStatus('analyzing', updatedAt, {
        detail: 'Reviewing prompt and dependencies.',
        taskId: event.taskId,
      });
    case 'task:stream-delta':
      return createLlmStatus('thinking', updatedAt, {
        detail: event.phase === 'planning' ? 'Generating plan...' : 'Generating implementation...',
        taskId: event.taskId,
        phase: event.phase,
      });
    case 'task:plan-persisted':
      return createLlmStatus('planning', updatedAt, {
        detail: 'Plan drafted and saved.',
        taskId: event.taskId,
      });
    case 'task:approval-requested':
      return createLlmStatus('awaiting-approval', updatedAt, {
        detail: 'Waiting for plan approval.',
        taskId: event.taskId,
      });
    case 'task:approved':
      return createLlmStatus('implementing', updatedAt, {
        detail: 'Plan approved. Starting implementation.',
        taskId: event.taskId,
      });
    case 'task:implementation-attempt':
      return createLlmStatus('implementing', updatedAt, {
        detail: `Implementation attempt ${event.attempt}/${event.maxAttempts}.`,
        taskId: event.taskId,
      });
    case 'task:tool-call':
      if (event.status !== 'started') {
        return undefined;
      }
      return createLlmStatus('using-tools', updatedAt, {
        detail: `Running tool ${event.toolName}.`,
        taskId: event.taskId,
        phase: event.phase,
      });
    case 'task:validating':
      return createLlmStatus('validating', updatedAt, {
        detail: 'Running verification checks.',
        taskId: event.taskId,
      });
    case 'task:verification-failed':
      return createLlmStatus('retrying', updatedAt, {
        detail: `Verification failed on attempt ${event.attempt}.`,
        taskId: event.taskId,
      });
    case 'task:retrying':
      return createLlmStatus('retrying', updatedAt, {
        detail: `Retrying (${event.attempt}/${event.maxRetries}).`,
        taskId: event.taskId,
      });
    case 'task:completed':
    case 'graph:completed':
      return createLlmStatus('completed', updatedAt, {
        detail: 'Run completed successfully.',
        taskId: 'taskId' in event ? event.taskId : undefined,
      });
    case 'task:failed':
    case 'graph:failed':
      return createLlmStatus('failed', updatedAt, {
        detail: event.type === 'task:failed' && event.failureType
          ? `${event.failureType}: ${event.error}`
          : event.error,
        failureType: event.type === 'task:failed' ? event.failureType : undefined,
        taskId: 'taskId' in event ? event.taskId : undefined,
      });
    default:
      return undefined;
  }
}

function toUiEvent(runId: string, event: DagEvent): UiDagEvent | undefined {
  const base = {
    time: now(),
    runId,
    type: event.type,
    taskId: 'taskId' in event ? event.taskId : undefined,
    failureType: event.type === 'task:failed' ? event.failureType : undefined,
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
          message: tagged(`${event.taskId}: tool ${event.toolName} input ${previewToolLog(event.input)}`),
        };
      }

      const errorSuffix = event.isError ? ' [error]' : '';
      return {
        ...base,
        message: tagged(`${event.taskId}: tool ${event.toolName} output${errorSuffix} ${previewToolLog(event.output)}`),
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
          `${event.taskId}: failed${event.failureType ? ` [${event.failureType}]` : ''} (${event.error})`,
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

function previewToolLog(value: string | undefined, maxChars = 600): string {
  if (!value) {
    return '(empty)';
  }

  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '(blank)';
  }

if (compact.length <= maxChars) {
    return compact;
  }

  return `${compact.slice(0, Math.max(0, maxChars - 3))}...`;
}

function resolveToolPreviewLimit(toolName: string, direction: 'input' | 'output'): number {
  if (toolName === 'subagent_spawn_batch') {
    return direction === 'input' ? 12_000 : 20_000;
  }

  if (toolName === 'subagent_worker') {
    return direction === 'input' ? 8_000 : 16_000;
  }

  if (toolName === 'subagent_spawn') {
    return direction === 'input' ? 4_000 : 12_000;
  }

  return 600;
}

function emitSubAgentWorkerEvent(params: {
  session: WorkSession;
  uiStatePersistence: { schedule: () => void; flush: () => Promise<void> };
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
    if (params.session.events.length > 200) {
      params.session.events.shift();
    }
  }

  // Note: emitSubAgentWorkerEvent is a standalone function without access to emitSessionEvent.
  // Sub-agent events are captured indirectly via the onEvent callback's dag-event dual-writes
  // during orchestration, and via handleChatToolCallEvent during chat. No separate dual-write
  // needed here — the UiDagEvent push + llmStatus mutation are already covered by the callers.

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
    }
  }

  // Note: emitSubAgentWorkerEvent is a standalone function without access to emitSessionEvent.
  // Sub-agent events are captured indirectly via the onEvent callback's dag-event dual-writes
  // during orchestration, and via handleChatToolCallEvent during chat. No separate dual-write
  // needed here — the UiDagEvent push + llmStatus mutation are already covered by the callers.
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
): void {
  const event = toChatToolDagEvent(toolEvent);
  const uiEvent = toUiEvent(session.id, event);
  if (uiEvent) {
    session.events.push(uiEvent);
    if (session.events.length > 200) {
      session.events.shift();
    }
  }

  let checklistChanged = false;
  let graphChanged = false;
  if (event.status === 'started') {
    checklistChanged = applyChecklistFromToolEvent(session.id, event, sessionTodos);
    if (checklistChanged) {
      broadcastTodoUpdate(workStreamClients, session.id, sessionTodos.get(session.id) ?? []);
    }

    graphChanged = applyAgentGraphFromToolEvent(session, event) || graphChanged;
  }

  const graphProgressChanged = applyAgentGraphProgressFromToolEvent(
    session,
    event,
    pendingSubagentNodeIdsBySession,
  );

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
        const status = normalizeChecklistTodoStatus(item.status);
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
    const status = normalizeChecklistTodoStatus(args.status);
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
  const status = normalizeChecklistTodoStatus(args.status);
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

function serializeWorkSession(session: WorkSession): Record<string, unknown> {
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
    provider: session.provider,
    model: session.model,
    autoApprove: session.autoApprove,
    adaptiveConcurrency: session.adaptiveConcurrency,
    batchConcurrency: session.batchConcurrency,
    batchMinConcurrency: session.batchMinConcurrency,
    worktreePath: session.worktreePath,
    worktreeBranch: session.worktreeBranch,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status,
    llmStatus: session.llmStatus,
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

type SessionPromptPhase = 'chat' | 'planning' | 'implementation';

type FollowUpSuggestionPhase = 'chat' | 'planning' | 'implementation';

function mergeRetryPromptWithFollowUp(params: {
  prompt: string;
  followUpText: string;
  followUpParts: SessionChatContentPart[];
}): string {
  const { prompt, followUpText, followUpParts } = params;
  const followUp = buildRetryFollowUpSummary({ followUpText, followUpParts });
  if (!followUp) {
    return prompt;
  }

  const base = prompt.trim();
  if (!base) {
    return followUp;
  }

  return `${base}\n\n${followUp}`;
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

function buildSessionSystemPrompt(session: WorkSession, phase: SessionPromptPhase): string {
  const phaseRules =
    phase === 'chat'
      ? [
          'Keep continuity with prior messages and avoid repeating completed work.',
          'Use chat responses to clarify intent, summarize progress, and gather missing context.',
          'When direct implementation is requested, proceed with concrete action-oriented steps.',
          'When the user asks for planning, switch to planning mode and perform todo_set + agent_graph_set before presenting the plan.',
          'When planning, require atomic task granularity: one action per task with explicit done criteria and verification commands.',
          'Reject broad bundled tasks; split work into smaller units before finalizing the plan.',
          'When publishing agent_graph_set, use descriptive node ids/names instead of generic n1/n2 labels.',
          'Planning requests must also use subagent_spawn or subagent_spawn_batch with focused, task-relevant context per sub-agent.',
          'Pass nodeId on each sub-agent request so graph progress stays visible and current.',
          'When asked to inspect or change todos/agent graph, call the corresponding tools instead of simulating success.',
          'When calling todo tools, use canonical statuses only: todo, in_progress, done.',
          'If no tool was executed, explicitly state that no tool output is available.',
          'Always end your response with 1-3 numbered next follow-up suggestions.',
        ]
      : phase === 'planning'
        ? [
            'Produce a concrete implementation plan with explicit staged execution and validation steps.',
            'Do not perform direct code edits in planning mode.',
            'Planning output must be highly granular and atomic: each task should represent one action and one completion outcome.',
            'Split broad, multi-area, or multi-step tasks into smaller independent tasks before finalizing.',
            'Each planned task must include explicit dependencies, concrete done criteria, and at least one verification command.',
            'Planning must produce and maintain todo_set and agent_graph_set state.',
            'Planning must use subagent_spawn or subagent_spawn_batch for focused parallel research and delegate only relevant context.',
            'For independent nodes, use subagent_spawn_batch so work runs in parallel.',
            'Pass nodeId for each sub-agent request so graph status stays current.',
            'Keep todo and dependency graph state synchronized.',
            'Always end your response with 1-3 numbered next follow-up suggestions.',
          ]
        : [
            'Execute approved work with minimal, scoped edits and verify outcomes.',
            'Read before editing, and use tool output to adapt after failures.',
            'Read todo_get and agent_graph_get before coding, then keep todo_update current while implementing.',
            'Use subagent_spawn or subagent_spawn_batch to execute parallelizable slices with minimal relevant context per agent.',
            'For independent nodes, use subagent_spawn_batch so work runs in parallel.',
            'Pass nodeId for each sub-agent request so graph status stays current.',
            'Use github_api for GitHub REST/GraphQL operations; do not use gh CLI.',
            'Iterate until validation passes or a true blocker is reached.',
            'After each push or PR update, query remote CI/check status with github_api and keep fixing/re-pushing until checks pass or a true blocker is reached.',
            'Do not stop at green checks alone: verify PR mergeability, required checks, and review state via github_api, then keep iterating until the PR is merge-ready or a true blocker is reached.',
            'Do not ask the user to continue after partial progress; continue autonomously until completion or a concrete blocker is reached.',
            'For transient tool or sub-agent failures (timeouts, aborts, rate limits), retry automatically before surfacing a blocker.',
            'Always end your response with 1-3 numbered next follow-up suggestions.',
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
    return buildFollowUpSuggestionsBlock(phase);
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
