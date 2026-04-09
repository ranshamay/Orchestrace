import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const piAiMock = vi.hoisted(() => ({
  getEnvApiKey: vi.fn(() => undefined),
  getProviders: vi.fn(() => ['github-copilot']),
}));

vi.mock('@mariozechner/pi-ai', () => piAiMock);

vi.mock('@mariozechner/pi-ai/oauth', () => ({
  getOAuthApiKey: vi.fn(),
  getOAuthProvider: vi.fn(),
  getOAuthProviders: vi.fn(() => [{ id: 'github-copilot', name: 'GitHub Copilot' }]),
  loginGitHubCopilot: vi.fn(),
}));

import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProviderAuthManager } from '../../src/auth.js';

describe('ProviderAuthManager Copilot env fallback', () => {
  let authPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.GITHUB_COPILOT_API_KEY;
    const root = await mkdtemp(join(tmpdir(), 'orchestrace-auth-env-'));
    authPath = join(root, 'auth.json');
  });

  afterEach(async () => {
    delete process.env.GITHUB_COPILOT_API_KEY;
    if (authPath) {
      await rm(dirname(authPath), { recursive: true, force: true });
    }
  });

  it('resolves github-copilot API key from GITHUB_COPILOT_API_KEY when store/oauth are absent', async () => {
    process.env.GITHUB_COPILOT_API_KEY = 'copilot-env-token';
    const auth = new ProviderAuthManager({ authFilePath: authPath });

    const token = await auth.resolveApiKey('github-copilot');

    expect(token).toBe('copilot-env-token');
  });

  it('reports env auth source for github-copilot when only env key is configured', async () => {
    process.env.GITHUB_COPILOT_API_KEY = 'copilot-env-token';
    const auth = new ProviderAuthManager({ authFilePath: authPath });

    const status = await auth.getStatus('github-copilot');

    expect(status.envConfigured).toBe(true);
    expect(status.oauthConfigured).toBe(false);
    expect(status.storedApiKeyConfigured).toBe(false);
    expect(status.source).toBe('env');
  });
});