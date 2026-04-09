import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const oauthMock = vi.hoisted(() => ({
  getOAuthApiKey: vi.fn(),
  getOAuthProvider: vi.fn(),
  getOAuthProviders: vi.fn(() => [{ id: 'github-copilot', name: 'GitHub Copilot' }]),
  loginGitHubCopilot: vi.fn(),
}));

vi.mock('@mariozechner/pi-ai', () => ({
  getEnvApiKey: vi.fn(() => undefined),
  getProviders: vi.fn(() => ['github-copilot']),
}));

vi.mock('@mariozechner/pi-ai/oauth', () => oauthMock);

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProviderAuthManager } from '../../src/auth.js';

describe('ProviderAuthManager Copilot TTL awareness', () => {
  let authPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const root = await mkdtemp(join(tmpdir(), 'orchestrace-auth-ttl-'));
    authPath = join(root, 'auth.json');
  });

  afterEach(async () => {
    if (authPath) {
      await rm(dirname(authPath), { recursive: true, force: true });
    }
  });

  async function writeAuthStore(expiresEpochSeconds: number) {
    const store = {
      oauth: {
        'github-copilot': {
          access: 'stored-access-token',
          refresh: 'refresh-token',
          expires: expiresEpochSeconds,
        },
      },
      apiKeys: {},
    };

    await writeFile(authPath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
  }

  it('refreshes token proactively when near expiry', async () => {
    const now = Math.floor(Date.now() / 1000);
    await writeAuthStore(now + 30);

    oauthMock.getOAuthApiKey.mockResolvedValue({
      apiKey: 'refreshed-token',
      newCredentials: {
        access: 'refreshed-access',
        refresh: 'refresh-token',
        expires: now + 3600,
      },
    });

    const auth = new ProviderAuthManager({ authFilePath: authPath });
    const token = await auth.resolveApiKey('github-copilot');

    expect(token).toBe('refreshed-token');
    expect(oauthMock.getOAuthApiKey).toHaveBeenCalledTimes(1);

    const persisted = JSON.parse(await readFile(authPath, 'utf-8')) as {
      oauth: Record<string, { access: string }>;
    };
    expect(persisted.oauth['github-copilot'].access).toBe('refreshed-access');
  });

  it('uses stored token without refresh when TTL is healthy', async () => {
    const now = Math.floor(Date.now() / 1000);
    await writeAuthStore(now + 3600);

    const auth = new ProviderAuthManager({ authFilePath: authPath });
    const token = await auth.resolveApiKey('github-copilot');

    expect(token).toBe('stored-access-token');
    expect(oauthMock.getOAuthApiKey).not.toHaveBeenCalled();
  });

  it('includes near-expiry metadata in status', async () => {
    const now = Math.floor(Date.now() / 1000);
    await writeAuthStore(now + 60);

    const auth = new ProviderAuthManager({ authFilePath: authPath });
    const status = await auth.getStatus('github-copilot');

    expect(status.tokenTtl).toBeDefined();
    expect(status.tokenTtl?.isNearExpiry).toBe(true);
    expect(status.tokenTtl?.refreshRecommended).toBe(true);
  });
});