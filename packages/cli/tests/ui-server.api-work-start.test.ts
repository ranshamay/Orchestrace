import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetModels = vi.hoisted(() => vi.fn<(provider: string) => Array<{ id: string }>>());
const mockGetModelInfo = vi.hoisted(() => vi.fn((_provider: string, _model: string) => ({
  provider: 'anthropic',
  model: 'mock',
  inputTokenLimit: 200_000,
  outputTokenLimit: 8_192,
})));
const mockCreateWorktree = vi.hoisted(() => vi.fn(async (workspacePath: string, branch: string) => ({
  path: workspacePath,
  branch,
  warnings: [],
  cleanup: async () => {},
})));
const mockProviderGetAllStatus = vi.hoisted(() => vi.fn(async () => [{ provider: 'anthropic', source: 'env' }]));
const mockResolveApiKey = vi.hoisted(() => vi.fn(async () => 'test-key'));
const mockPromptSectionName = vi.hoisted(
  () => new Proxy({}, { get: (_target, prop) => String(prop) }) as Record<string, string>,
);
const state = vi.hoisted(() => ({
  capturedHandler: undefined as ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined,
}));

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: vi.fn((handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
      state.capturedHandler = handler;
      return {
        listen: (_port: number, _host: string, cb?: () => void) => cb?.(),
        on: vi.fn(),
      };
    }),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        unref: () => void;
        on: (event: string, listener: (...args: unknown[]) => void) => EventEmitter;
      };
      child.pid = 12345;
      child.unref = () => {};
      return child;
    },
  };
});

vi.mock('@orchestrace/store', () => ({
  FileEventStore: class {
    async append() {}
    async appendBatch() {}
    async listSessions() { return []; }
    async read() { return []; }
    async getMetadata() { return undefined; }
    async setMetadata() {}
    watch() { return () => {}; }
    async deleteSession() {}
  },
  materializeSession: () => null,
}));

vi.mock('../src/observer/index.js', () => ({
  ObserverDaemon: class {
    async start() {}
  },
}));

vi.mock('@mariozechner/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mariozechner/pi-ai')>();
  return {
    ...actual,
    getModels: (...args: [string]) => mockGetModels(...args),
  };
});

vi.mock('@orchestrace/core', () => ({
  PromptSectionName: mockPromptSectionName,
  renderPromptSections: () => '',
}));

vi.mock('@orchestrace/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orchestrace/sandbox')>();
  return {
    ...actual,
    createWorktree: (...args: [string, string]) => mockCreateWorktree(...args),
  };
});

vi.mock('../src/workspace-manager.js', () => ({
  WorkspaceManager: class {
    private readonly rootDir: string;

    constructor(_root: string) {
      this.rootDir = mkdtempSync(join(tmpdir(), 'orchestrace-ui-server-test-'));
    }

    async getActiveWorkspace() {
      return { id: 'ws-1', name: 'Workspace 1', path: this.rootDir };
    }

    async selectWorkspace(workspaceId: string) {
      if (workspaceId === 'ws-2') {
        return { id: 'ws-2', name: 'Workspace 2', path: `${this.rootDir}-ws2` };
      }
      return { id: 'ws-1', name: 'Workspace 1', path: this.rootDir };
    }

    getRootDir() {
      return this.rootDir;
    }
  },
}));

vi.mock('../src/ui-server/clock.js', () => ({ now: () => '2025-01-01T00:00:00.000Z' }));

vi.mock('@orchestrace/provider', () => ({
  PiAiAdapter: class {
    getModelInfo(provider: string, model: string) {
      return mockGetModelInfo(provider, model);
    }
  },
  ProviderAuthManager: class {
    async getAllStatus() {
      return mockProviderGetAllStatus();
    }
    async resolveApiKey(_provider: string) {
      return mockResolveApiKey();
    }
    listProviders() {
      return [];
    }
    async getProviders() {
      return [];
    }
    async initiateAuth() {
      return { status: 'success' };
    }
    async submitInput() {
      return { status: 'success' };
    }
    async cancelSession() {
      return;
    }
    async logout() {
      return;
    }
  },
}));

function createMockRequest(method: 'GET' | 'POST', url: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf-8');
  const req = new EventEmitter() as IncomingMessage & AsyncIterable<Buffer>;
  req.method = method;
  req.url = url;
  req.headers = body === undefined
    ? {}
    : {
      'content-type': 'application/json',
      'content-length': String(payload.length),
    };
  req[Symbol.asyncIterator] = async function* () {
    if (payload.length > 0) {
      yield payload;
    }
  };
  return req as IncomingMessage;
}

function createMockResponse() {
  let statusCode = 0;
  let bodyText = '';

  const res = {
    statusCode,
    setHeader() {
      return this;
    },
    end(chunk?: string) {
      bodyText = chunk ?? '';
      return this;
    },
    writeHead(code: number) {
      statusCode = code;
      return this;
    },
    write() {
      return true;
    },
  } as unknown as ServerResponse;

  Object.defineProperty(res, 'statusCode', {
    get: () => statusCode,
    set: (value: number) => {
      statusCode = value;
    },
  });

  return {
    res,
    getStatusCode: () => statusCode,
    getJson: () => (bodyText ? JSON.parse(bodyText) : {}),
  };
}

async function invokeJson(method: 'GET' | 'POST', url: string, body?: unknown) {
  if (!state.capturedHandler) {
    throw new Error('Expected UI server handler to be captured');
  }

  const req = createMockRequest(method, url, body);
  const response = createMockResponse();
  await state.capturedHandler(req, response.res);
  return response;
}

describe('/api/work/start model resolution', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    state.capturedHandler = undefined;
    mockGetModels.mockImplementation(() => [{ id: 'claude-3-5-sonnet-latest' }]);
    mockCreateWorktree.mockImplementation(async (workspacePath: string, branch: string) => ({
      path: workspacePath,
      branch,
      warnings: [],
      cleanup: async () => {},
    }));

    const { startUiServer } = await import('../src/ui-server.js');
    await startUiServer({ port: 4310, hmr: false });
  });

  it('uses explicit model when provided', async () => {
    mockGetModels.mockImplementation(() => [{ id: 'claude-3-5-sonnet-latest' }, { id: 'claude-3-opus' }]);

    const response = await invokeJson('POST', '/api/work/start', {
      prompt: 'Implement feature X',
      provider: 'anthropic',
      model: 'claude-3-opus',
      executionContext: 'workspace',
    });

    expect(response.getStatusCode()).toBe(200);
    expect(mockGetModelInfo).toHaveBeenCalledWith('anthropic', 'claude-3-opus');
    const payload = response.getJson();
    expect(typeof payload.id).toBe('string');
    expect(payload.id.length).toBeGreaterThan(0);
  });

  it('falls back to first provider model when model is empty and models are available', async () => {
    mockGetModels.mockImplementation(() => [{ id: 'model-first' }, { id: 'model-second' }]);

    const response = await invokeJson('POST', '/api/work/start', {
      prompt: 'Implement feature X',
      provider: 'anthropic',
      model: '',
      executionContext: 'workspace',
    });

    expect(response.getStatusCode()).toBe(200);
    expect(mockGetModelInfo).toHaveBeenCalledWith('anthropic', 'model-first');
  });

  it('returns 400 when model is empty and provider has no models', async () => {
    mockGetModels.mockImplementation(() => []);

    const response = await invokeJson('POST', '/api/work/start', {
      prompt: 'Implement feature X',
      provider: 'anthropic',
      model: '',
      executionContext: 'workspace',
    });

    expect(response.getStatusCode()).toBe(400);
    expect(response.getJson()).toEqual({ error: 'No models available for provider' });
  });
});

describe('/api/work/start workspace path lock enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    state.capturedHandler = undefined;
    mockGetModels.mockImplementation(() => [{ id: 'claude-3-5-sonnet-latest' }]);

    const { startUiServer } = await import('../src/ui-server.js');
    await startUiServer({ port: 4310, hmr: false });
  });

  it('returns 409 when a second session attempts the same workspace path', async () => {
    const sharedPath = '/tmp/shared-worktree-path';
    const firstCleanup = vi.fn(async () => {});
    const secondCleanup = vi.fn(async () => {});

    mockCreateWorktree
      .mockResolvedValueOnce({
        path: sharedPath,
        branch: 'session-first',
        warnings: [],
        cleanup: firstCleanup,
      })
      .mockResolvedValueOnce({
        path: sharedPath,
        branch: 'session-second',
        warnings: [],
        cleanup: secondCleanup,
      });

    const first = await invokeJson('POST', '/api/work/start', {
      prompt: 'First run',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      executionContext: 'git-worktree',
    });

    expect(first.getStatusCode()).toBe(200);

    const second = await invokeJson('POST', '/api/work/start', {
      prompt: 'Second run',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      executionContext: 'git-worktree',
    });

    expect(second.getStatusCode()).toBe(409);
    expect(second.getJson().error).toContain('Workspace path is currently in use');
    expect(secondCleanup).toHaveBeenCalledTimes(1);
    expect(firstCleanup).not.toHaveBeenCalled();
  });

  it('releases lock on delete and allows path reuse by a new session', async () => {
    const sharedPath = '/tmp/reusable-worktree-path';

    mockCreateWorktree.mockResolvedValue({
      path: sharedPath,
      branch: 'session-branch',
      warnings: [],
      cleanup: async () => {},
    });

    const first = await invokeJson('POST', '/api/work/start', {
      prompt: 'First run',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      executionContext: 'git-worktree',
    });

    expect(first.getStatusCode()).toBe(200);
    const firstId = first.getJson().id as string;

    const blocked = await invokeJson('POST', '/api/work/start', {
      prompt: 'Blocked run',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      executionContext: 'git-worktree',
    });
    expect(blocked.getStatusCode()).toBe(409);

    const removed = await invokeJson('POST', '/api/work/delete', { id: firstId });
    expect(removed.getStatusCode()).toBe(200);

    const retried = await invokeJson('POST', '/api/work/start', {
      prompt: 'After delete',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      executionContext: 'git-worktree',
    });

    expect(retried.getStatusCode()).toBe(200);
  });
});