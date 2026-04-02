import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { orchestrate } from '@orchestrace/core';
import type { DagEvent, PlanApprovalRequest, TaskGraph } from '@orchestrace/core';
import { getModels } from '@mariozechner/pi-ai';
import { PiAiAdapter, ProviderAuthManager } from '@orchestrace/provider';
import type { ProviderInfo } from '@orchestrace/provider';

export interface UiServerOptions {
  port?: number;
}

type WorkState = 'running' | 'completed' | 'failed' | 'cancelled';

interface WorkSession {
  id: string;
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

export async function startUiServer(options: UiServerOptions = {}): Promise<void> {
  const port = options.port ?? 4310;
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  const authManager = new ProviderAuthManager();
  const llm = new PiAiAdapter();

  const workSessions = new Map<string, WorkSession>();
  const authSessions = new Map<string, AuthSession>();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const { pathname } = url;

      if (req.method === 'GET' && pathname === '/') {
        sendHtml(res, renderDashboardHtml());
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
        const method = asString(body.method);

        if (!providerId) {
          sendJson(res, 400, { error: 'Missing providerId' });
          return;
        }

        const provider = authManager.listProviders().find((item) => item.id === providerId);
        if (!provider) {
          sendJson(res, 404, { error: `Unknown provider: ${providerId}` });
          return;
        }

        if (method === 'api-key') {
          const apiKey = asString(body.apiKey);
          if (!apiKey) {
            sendJson(res, 400, { error: 'Missing apiKey' });
            return;
          }

          try {
            await authManager.configureApiKey(providerId, apiKey);
            sendJson(res, 200, { ok: true, message: `Saved API key for ${providerId}` });
          } catch (error) {
            sendJson(res, 400, { error: toErrorMessage(error) });
          }
          return;
        }

        if (method !== 'oauth') {
          sendJson(res, 400, { error: 'method must be oauth or api-key' });
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
        const prompt = asString(body.prompt);
        const provider = asString(body.provider) || process.env.ORCHESTRACE_DEFAULT_PROVIDER || 'anthropic';
        const model = asString(body.model) || process.env.ORCHESTRACE_DEFAULT_MODEL || 'claude-sonnet-4-20250514';
        const autoApprove = Boolean(body.autoApprove);

        if (!prompt) {
          sendJson(res, 400, { error: 'Missing prompt' });
          return;
        }

        const id = randomUUID();
        const controller = new AbortController();
        const session: WorkSession = {
          id,
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

        const graph = buildSingleTaskGraph(id, prompt);

        void orchestrate(graph, {
          llm,
          cwd: workspaceRoot,
          planOutputDir: join(workspaceRoot, '.orchestrace', 'plans'),
          defaultModel: { provider, model },
          maxParallel: 1,
          requirePlanApproval: !autoApprove,
          onPlanApproval: async (_request: PlanApprovalRequest) => autoApprove,
          signal: controller.signal,
          resolveApiKey: async (providerId) => authManager.resolveApiKey(providerId),
          onEvent: (event) => {
            session.updatedAt = now();
            const uiEvent = toUiEvent(event);
            if (uiEvent) {
              session.events.push(uiEvent);
              if (session.events.length > 200) {
                session.events.shift();
              }
            }

            if ('taskId' in event) {
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
        }).catch((error) => {
          if (session.status !== 'cancelled') {
            session.status = 'failed';
            session.error = toErrorMessage(error);
            session.updatedAt = now();
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

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(res, 500, { error: toErrorMessage(error) });
    }
  });

  await new Promise<void>((resolvePromise) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`UI server listening on http://127.0.0.1:${port}`);
      resolvePromise();
    });
  });
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

function findWorkspaceRoot(startDir: string): string {
  let current = resolve(startDir);

  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml')) || existsSync(join(current, '.git'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return resolve(startDir);
    }
    current = parent;
  }
}

function renderDashboardHtml(): string {
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

    <section class="panel">
      <h2 class="section-title">Auth Control</h2>
      <div class="grid">
        <div>
          <label>Provider</label>
          <select id="authProvider"></select>
        </div>
        <div>
          <label>Method</label>
          <select id="authMethod">
            <option value="oauth">oauth</option>
            <option value="api-key">api-key</option>
          </select>
        </div>
        <div class="full">
          <label>API key (when method=api-key)</label>
          <input id="authApiKey" type="password" placeholder="sk-..." />
        </div>
        <div class="full actions">
          <button class="primary" id="authStart">Authenticate</button>
        </div>
      </div>
      <div id="authStatus" class="status-note"></div>
      <div id="authSession" class="auth-console">No auth session started.</div>
      <div class="grid" style="margin-top:8px;">
        <div class="full">
          <label>OAuth prompt response</label>
          <input id="authPromptInput" placeholder="Paste device code or answer" />
        </div>
        <div class="full actions">
          <button class="secondary" id="authPromptSend">Send OAuth Input</button>
        </div>
      </div>
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

    <section class="panel">
      <h2 class="section-title">Start Work</h2>
      <div class="grid">
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

    <section class="panel">
      <h2 class="section-title">Sessions</h2>
      <div id="workRows" class="session-list"></div>
    </section>
  </main>

<script>
  let selectedWorkId = null;
  let authPollId = null;
  let activeAuthSessionId = null;
  let providerCache = [];
  let statusCache = [];
  let workSessionsCache = [];
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

    for (const provider of providerCache) {
      const status = statusCache.find((item) => item.provider === provider.id);
      const opt = document.createElement('option');
      opt.value = provider.id;
      opt.textContent = provider.id + ' [' + (status ? status.source : 'none') + ']';
      select.appendChild(opt);

      const wopt = document.createElement('option');
      wopt.value = provider.id;
      wopt.textContent = provider.id;
      workProvider.appendChild(wopt);
    }

    if (previous && providerCache.find((item) => item.id === previous)) {
      select.value = previous;
    }

    if (previousWorkProvider && providerCache.find((item) => item.id === previousWorkProvider)) {
      workProvider.value = previousWorkProvider;
    } else if (providerCache.find((item) => item.id === defaults.provider)) {
      workProvider.value = defaults.provider;
    } else if (providerCache[0]) {
      workProvider.value = providerCache[0].id;
    }

    await refreshWorkModels();
    syncAuthMethodWithProvider();
  }

  async function refreshWorkModels() {
    const providerId = document.getElementById('workProvider').value;
    const modelSelect = document.getElementById('workModel');
    const previousModel = modelSelect.value;
    modelSelect.innerHTML = '';

    if (!providerId) return;

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

  function syncAuthMethodWithProvider() {
    const providerId = document.getElementById('authProvider').value;
    const methodSelect = document.getElementById('authMethod');
    const keyInput = document.getElementById('authApiKey');

    const provider = providerCache.find((item) => item.id === providerId);
    if (!provider) return;

    if (provider.authType === 'oauth') {
      methodSelect.value = 'oauth';
      methodSelect.disabled = true;
      keyInput.disabled = true;
      keyInput.placeholder = 'Disabled: this provider uses OAuth';
      return;
    }

    methodSelect.disabled = false;
    keyInput.disabled = methodSelect.value !== 'api-key';
    keyInput.placeholder = keyInput.disabled ? 'Enter only when api-key is selected' : 'sk-...';
  }

  async function refreshWorkSessions() {
    const data = await api('/api/work');
    workSessionsCache = data.sessions || [];
    renderSessionList(workSessionsCache);
    renderSessionGraph(workSessionsCache);
    await renderSelectedEvents();
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

    const lines = [];
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

  async function startWork() {
    const prompt = document.getElementById('workPrompt').value.trim();
    const provider = document.getElementById('workProvider').value.trim();
    const model = document.getElementById('workModel').value.trim();
    const autoApprove = document.getElementById('autoApprove').checked;

    if (!prompt) {
      setText('workStatus', 'Prompt is required.');
      return;
    }

    const result = await api('/api/work/start', 'POST', { prompt, provider, model, autoApprove });
    selectedWorkId = result.id;
    setText('workStatus', 'Started work session: ' + result.id);
    await refreshWorkSessions();
  }

  async function startAuth() {
    const providerId = document.getElementById('authProvider').value;
    const method = document.getElementById('authMethod').value;
    const apiKey = document.getElementById('authApiKey').value;

    const result = await api('/api/auth/start', 'POST', { providerId, method, apiKey });
    activeAuthSessionId = result.sessionId;
    setText('authStatus', 'Auth session started: ' + result.sessionId);

    if (authPollId) clearInterval(authPollId);
    authPollId = setInterval(async () => {
      try {
        const sessionResult = await api('/api/auth/session?id=' + encodeURIComponent(activeAuthSessionId));
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
    const lines = [
      'provider: ' + session.providerId,
      'state: ' + session.state,
    ];

    if (session.authUrl) lines.push('url: ' + session.authUrl);
    if (session.authInstructions) lines.push('instructions: ' + session.authInstructions);
    if (session.promptMessage) lines.push('prompt: ' + session.promptMessage);
    if (session.error) lines.push('error: ' + session.error);

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
  document.getElementById('authProvider').addEventListener('change', syncAuthMethodWithProvider);
  document.getElementById('authMethod').addEventListener('change', syncAuthMethodWithProvider);
  document.getElementById('workProvider').addEventListener('change', () => refreshWorkModels().catch((e) => setText('workStatus', String(e))));
  document.getElementById('workStart').addEventListener('click', () => startWork().catch((e) => setText('workStatus', String(e))));
  document.getElementById('authStart').addEventListener('click', () => startAuth().catch((e) => setText('authStatus', String(e))));
  document.getElementById('authPromptSend').addEventListener('click', () => sendAuthPromptInput().catch((e) => setText('authStatus', String(e))));

  initTheme();
  refreshProviders().catch((e) => setText('authStatus', String(e)));
  refreshWorkSessions().catch((e) => setText('workStatus', String(e)));
  setInterval(() => refreshWorkSessions().catch(() => {}), 2000);
</script>
</body>
</html>`;
}
