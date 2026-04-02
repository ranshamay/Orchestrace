import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { orchestrate } from '@orchestrace/core';
import type { DagEvent, PlanApprovalRequest, TaskGraph } from '@orchestrace/core';
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
        sendJson(res, 200, { providers, statuses });
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
          cwd: process.cwd(),
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

function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Orchestrace UI</title>
  <style>
    :root {
      --bg: #f3f1ea;
      --card: #fffdf8;
      --ink: #1f2a2c;
      --muted: #5c6a6e;
      --accent: #0f766e;
      --danger: #b42318;
      --border: #d8d2c5;
    }
    body { margin: 0; font-family: ui-sans-serif, -apple-system, Segoe UI, sans-serif; background: radial-gradient(circle at 10% 10%, #fff6dc, var(--bg)); color: var(--ink); }
    .wrap { max-width: 1100px; margin: 24px auto; padding: 0 16px; display: grid; gap: 16px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 16px; box-shadow: 0 4px 18px rgba(20,20,20,.05); }
    h1 { margin: 0 0 6px; font-size: 22px; }
    h2 { margin: 0 0 10px; font-size: 18px; }
    .row { display: grid; gap: 8px; grid-template-columns: repeat(12, 1fr); align-items: center; }
    .row > * { grid-column: span 12; }
    @media (min-width: 820px) {
      .c4 { grid-column: span 4; }
      .c6 { grid-column: span 6; }
      .c8 { grid-column: span 8; }
      .c12 { grid-column: span 12; }
    }
    input, select, textarea, button { width: 100%; box-sizing: border-box; border-radius: 10px; border: 1px solid var(--border); padding: 10px; font-size: 14px; background: white; color: var(--ink); }
    textarea { min-height: 90px; resize: vertical; }
    button { background: var(--accent); color: white; border: none; font-weight: 600; cursor: pointer; }
    button.secondary { background: #475467; }
    button.danger { background: var(--danger); }
    .muted { color: var(--muted); font-size: 13px; }
    .tag { font-size: 12px; border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; display: inline-block; margin-right: 6px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid var(--border); padding: 8px 6px; font-size: 13px; vertical-align: top; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
    .events { max-height: 220px; overflow: auto; border: 1px solid var(--border); border-radius: 10px; padding: 8px; background: #fff; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Orchestrace Dashboard</h1>
      <div class="muted">Track agent status, start/cancel work, and manage provider authentication.</div>
    </div>

    <div class="card">
      <h2>Auth</h2>
      <div class="row">
        <div class="c4"><label>Provider</label><select id="authProvider"></select></div>
        <div class="c4"><label>Method</label><select id="authMethod"><option value="oauth">oauth</option><option value="api-key">api-key</option></select></div>
        <div class="c4"><label>API key (if api-key)</label><input id="authApiKey" type="password" placeholder="sk-..." /></div>
        <div class="c4"><button id="authStart">Authenticate</button></div>
      </div>
      <div id="authStatus" class="muted" style="margin-top:8px"></div>
      <div id="authSession" class="events mono" style="margin-top:10px"></div>
      <div class="row" style="margin-top:8px">
        <div class="c8"><input id="authPromptInput" placeholder="Response for OAuth prompt" /></div>
        <div class="c4"><button id="authPromptSend" class="secondary">Send OAuth Input</button></div>
      </div>
    </div>

    <div class="card">
      <h2>Start Work</h2>
      <div class="row">
        <div class="c6"><label>Provider</label><input id="workProvider" placeholder="github-copilot" /></div>
        <div class="c6"><label>Model</label><input id="workModel" placeholder="gpt-4o" /></div>
        <div class="c12"><label>Prompt</label><textarea id="workPrompt" placeholder="Describe the work to run"></textarea></div>
        <div class="c4"><label><input id="autoApprove" type="checkbox" checked /> Auto approve plan</label></div>
        <div class="c4"><button id="workStart">Start</button></div>
      </div>
      <div id="workStatus" class="muted" style="margin-top:8px"></div>
    </div>

    <div class="card">
      <h2>Agent Sessions</h2>
      <table>
        <thead><tr><th>ID</th><th>Status</th><th>Provider/Model</th><th>Prompt</th><th>Actions</th></tr></thead>
        <tbody id="workRows"></tbody>
      </table>
      <h2 style="margin-top:14px">Selected Session Events</h2>
      <div id="events" class="events mono"></div>
    </div>
  </div>

<script>
  let selectedWorkId = null;
  let authPollId = null;

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

  async function refreshProviders() {
    const data = await api('/api/providers');
    const select = document.getElementById('authProvider');
    select.innerHTML = '';

    for (const provider of data.providers) {
      const status = data.statuses.find((item) => item.provider === provider.id);
      const opt = document.createElement('option');
      opt.value = provider.id;
      opt.textContent = provider.id + ' [' + (status ? status.source : 'none') + ']';
      select.appendChild(opt);
    }

    const first = data.providers[0];
    if (first) {
      document.getElementById('workProvider').value = first.id;
    }
  }

  async function refreshWorkSessions() {
    const data = await api('/api/work');
    const rows = document.getElementById('workRows');
    rows.innerHTML = '';

    for (const session of data.sessions) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="mono">' + session.id.slice(0, 8) + '</td>' +
        '<td><span class="tag">' + session.status + '</span></td>' +
        '<td class="mono">' + session.provider + ' / ' + session.model + '</td>' +
        '<td>' + escapeHtml(session.prompt).slice(0, 100) + '</td>' +
        '<td>' +
          '<button class="secondary" data-view="' + session.id + '">view</button> ' +
          '<button class="danger" data-cancel="' + session.id + '">cancel</button>' +
        '</td>';
      rows.appendChild(tr);
    }

    rows.querySelectorAll('button[data-view]').forEach((button) => {
      button.addEventListener('click', async () => {
        selectedWorkId = button.getAttribute('data-view');
        await renderSelectedEvents();
      });
    });

    rows.querySelectorAll('button[data-cancel]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.getAttribute('data-cancel');
        await api('/api/work/cancel', 'POST', { id });
        await refreshWorkSessions();
        await renderSelectedEvents();
      });
    });
  }

  async function renderSelectedEvents() {
    const eventsEl = document.getElementById('events');
    if (!selectedWorkId) {
      eventsEl.textContent = 'Select a session to inspect events.';
      return;
    }

    const data = await api('/api/work');
    const session = data.sessions.find((item) => item.id === selectedWorkId);
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

    eventsEl.textContent = lines.length ? lines.join('\n') : '(no events yet)';
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
    await renderSelectedEvents();
  }

  async function startAuth() {
    const providerId = document.getElementById('authProvider').value;
    const method = document.getElementById('authMethod').value;
    const apiKey = document.getElementById('authApiKey').value;

    const result = await api('/api/auth/start', 'POST', { providerId, method, apiKey });
    setText('authStatus', 'Auth session started: ' + result.sessionId);
    if (authPollId) clearInterval(authPollId);

    authPollId = setInterval(async () => {
      try {
        const sessionResult = await api('/api/auth/session?id=' + encodeURIComponent(result.sessionId));
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

    document.getElementById('authSession').textContent = lines.join('\n');
  }

  async function sendAuthPromptInput() {
    const statusText = document.getElementById('authStatus').textContent;
    const match = /([0-9a-fA-F-]{36})/.exec(statusText || '');
    if (!match) {
      setText('authStatus', 'No active auth session id found. Start auth first.');
      return;
    }

    const value = document.getElementById('authPromptInput').value;
    await api('/api/auth/respond', 'POST', { sessionId: match[1], value });
    document.getElementById('authPromptInput').value = '';
  }

  function setText(id, text) {
    document.getElementById(id).textContent = text;
  }

  function escapeHtml(text) {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }

  document.getElementById('workStart').addEventListener('click', () => startWork().catch((e) => setText('workStatus', String(e))));
  document.getElementById('authStart').addEventListener('click', () => startAuth().catch((e) => setText('authStatus', String(e))));
  document.getElementById('authPromptSend').addEventListener('click', () => sendAuthPromptInput().catch((e) => setText('authStatus', String(e))));

  setInterval(() => refreshWorkSessions().then(renderSelectedEvents).catch(() => {}), 2000);
  refreshProviders().catch((e) => setText('authStatus', String(e)));
  refreshWorkSessions().then(renderSelectedEvents).catch((e) => setText('workStatus', String(e)));
</script>
</body>
</html>`;
}
