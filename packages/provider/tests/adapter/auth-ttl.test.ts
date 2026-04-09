import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const oauthMock = vi.hoisted(() => ({
  getOAuthApiKey: vi.fn(),
  getOAuthProvider: vi.fn(),
  getOAuthProviders: vi.fn(() => [{ id: 'github-copilot', name: 'GitHub Copilot' }]),
  loginGitHubCopilot: vi.fn(),
}));

const piAiMock = vi.hoisted(() => ({
  getEnvApiKey: vi.fn(() => undefined),
  getProviders: vi.fn(() => ['github-copilot']),
}));

vi.mock('@mariozechner/pi-ai', () => piAiMock);


vi.mock('@mariozechner/pi-ai/oauth', () => oauthMock);

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProviderAuthManager } from '../../src/auth.js';

describe('ProviderAuthManager Copilot TTL awareness', () => {
  let authPath: string;

    beforeEach(async () => {
    vi.clearAllMocks();
    piAiMock.getEnvApiKey.mockReset();
    piAiMock.getEnvApiKey.mockReturnValue(undefined);
    piAiMock.getProviders.mockReset();
    piAiMock.getProviders.mockReturnValue(['github-copilot']);

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

    it('forces refresh even when stored token TTL is healthy when explicitly requested', async () => {
    const now = Math.floor(Date.now() / 1000);
    await writeAuthStore(now + 3600);

    oauthMock.getOAuthApiKey.mockResolvedValue({
      apiKey: 'force-refreshed-token',
      newCredentials: {
        access: 'force-refreshed-access',
        refresh: 'refresh-token',
        expires: now + 7200,
      },
    });

    const auth = new ProviderAuthManager({ authFilePath: authPath });
    const token = await auth.resolveApiKey('github-copilot', { forceRefresh: true });

    expect(token).toBe('force-refreshed-token');
    expect(oauthMock.getOAuthApiKey).toHaveBeenCalledTimes(1);

    const persisted = JSON.parse(await readFile(authPath, 'utf-8')) as {
      oauth: Record<string, { access: string }>;
    };
    expect(persisted.oauth['github-copilot'].access).toBe('force-refreshed-access');
  });

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

  it('does not refresh near-expiry token when refresh is disabled', async () => {
    const now = Math.floor(Date.now() / 1000);
    await writeAuthStore(now + 30);

    const auth = new ProviderAuthManager({ authFilePath: authPath });
    const token = await auth.resolveApiKey('github-copilot', { allowRefresh: false });

    expect(token).toBeUndefined();
    expect(oauthMock.getOAuthApiKey).not.toHaveBeenCalled();
  });

    it('does not refresh oauth token when refresh is disabled', async () => {
    const now = Math.floor(Date.now() / 1000);
    await writeAuthStore(now + 3600);

    oauthMock.getOAuthApiKey.mockResolvedValue({
      apiKey: 'unexpected-refresh',
      newCredentials: {
        access: 'unexpected-refresh',
        refresh: 'refresh-token',
        expires: now + 3600,
      },
    });

    const auth = new ProviderAuthManager({ authFilePath: authPath });
    const token = await auth.resolveApiKey('github-copilot', { allowRefresh: false });

    // Healthy Copilot tokens are returned from stored access even with refresh disabled.
    expect(token).toBe('stored-access-token');
    expect(oauthMock.getOAuthApiKey).not.toHaveBeenCalled();
  });

  it('refreshes token when below caller minimum TTL threshold', async () => {
    const now = Math.floor(Date.now() / 1000);
    await writeAuthStore(now + 300);

    oauthMock.getOAuthApiKey.mockResolvedValue({
      apiKey: 'refreshed-min-ttl-token',
      newCredentials: {
        access: 'refreshed-min-ttl-access',
        refresh: 'refresh-token',
        expires: now + 3600,
      },
    });

    const auth = new ProviderAuthManager({ authFilePath: authPath });
    const token = await auth.resolveApiKey('github-copilot', { minimumTtlSeconds: 600 });

    expect(token).toBe('refreshed-min-ttl-token');
    expect(oauthMock.getOAuthApiKey).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when refreshed token still does not meet minimum TTL threshold', async () => {
    const now = Math.floor(Date.now() / 1000);
    await writeAuthStore(now + 10);

    oauthMock.getOAuthApiKey.mockResolvedValue({
      apiKey: 'refreshed-still-low-ttl-token',
      newCredentials: {
        access: 'refreshed-still-low-ttl-access',
        refresh: 'refresh-token',
        expires: now + 120,
      },
    });

    const auth = new ProviderAuthManager({ authFilePath: authPath });
    const token = await auth.resolveApiKey('github-copilot', { minimumTtlSeconds: 600 });

    expect(token).toBeUndefined();
    expect(oauthMock.getOAuthApiKey).toHaveBeenCalledTimes(1);
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

  it('allows github-copilot env key fallback when oauth/store is absent', async () => {
    piAiMock.getEnvApiKey.mockReturnValue('copilot-env-token');

    const auth = new ProviderAuthManager({ authFilePath: authPath });
    const token = await auth.resolveApiKey('github-copilot', { allowRefresh: false });

    expect(token).toBe('copilot-env-token');
    expect(piAiMock.getEnvApiKey).toHaveBeenCalledWith('github-copilot');
  });

  it('returns actionable readiness error when github-copilot credentials are missing', async () => {
    const auth = new ProviderAuthManager({ authFilePath: authPath });
    const readiness = await auth.validateProviderReadiness('github-copilot', { allowRefresh: false });

    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect(readiness.code).toBe('provider_missing_credentials');
      expect(readiness.message).toContain('GitHub Copilot is missing credentials');
      expect(readiness.remediation).toEqual(expect.arrayContaining([
        expect.stringContaining('orchestrace auth github-copilot'),
        expect.stringContaining('GITHUB_COPILOT_API_KEY'),
      ]));
    }
  });

  it('reports readiness success when github-copilot env key is available', async () => {
    piAiMock.getEnvApiKey.mockReturnValue('copilot-env-token');

    const auth = new ProviderAuthManager({ authFilePath: authPath });
    const readiness = await auth.validateProviderReadiness('github-copilot', { allowRefresh: false });

    expect(readiness).toEqual({
      ok: true,
      provider: 'github-copilot',
      source: 'none',
    });
  });
});