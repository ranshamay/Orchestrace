import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const oauthMock = vi.hoisted(() => ({
  getOAuthApiKey: vi.fn(),
  getOAuthProvider: vi.fn(),
  getOAuthProviders: vi.fn(() => [{ id: 'github-copilot', name: 'GitHub Copilot' }]),
  loginGitHubCopilot: vi.fn(),
}));

const piAiMock = vi.hoisted(() => ({
  getEnvApiKey: vi.fn(() => undefined),
  getProviders: vi.fn(() => ['anthropic', 'github-copilot']),
}));

vi.mock('@mariozechner/pi-ai', () => piAiMock);
vi.mock('@mariozechner/pi-ai/oauth', () => oauthMock);

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProviderAuthManager, ProviderAuthValidationError } from '../../src/auth.js';

describe('ProviderAuthManager auth preflight', () => {
  let authPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const root = await mkdtemp(join(tmpdir(), 'orchestrace-auth-preflight-'));
    authPath = join(root, 'auth.json');
  });

  afterEach(async () => {
    if (authPath) {
      await rm(dirname(authPath), { recursive: true, force: true });
    }
  });

  it('throws actionable error when API-key provider is not configured', async () => {
    const auth = new ProviderAuthManager({ authFilePath: authPath });

    await expect(auth.assertProviderConfigured('anthropic')).rejects.toMatchObject({
      name: 'ProviderAuthValidationError',
      code: 'AUTH_PROVIDER_NOT_CONFIGURED',
      details: { provider: 'anthropic' },
    });

    await expect(auth.assertProviderConfigured('anthropic')).rejects.toThrow(/ANTHROPIC_API_KEY/);
    await expect(auth.assertProviderConfigured('anthropic')).rejects.toThrow(/orchestrace auth anthropic/);
  });

  it('throws GitHub Copilot specific OAuth guidance when not configured', async () => {
    const auth = new ProviderAuthManager({ authFilePath: authPath });

    const thrown = await auth.assertProviderConfigured('github-copilot').catch((error) => error);
    expect(thrown).toBeInstanceOf(ProviderAuthValidationError);
    expect((thrown as ProviderAuthValidationError).code).toBe('AUTH_PROVIDER_NOT_CONFIGURED');
    expect((thrown as Error).message).toContain('orchestrace auth github-copilot');
    expect((thrown as Error).message).toContain('GitHub Copilot credentials are not read from environment variables');
  });

  it('passes preflight for configured API-key provider via stored key', async () => {
    await writeFile(
      authPath,
      `${JSON.stringify({
        oauth: {},
        apiKeys: {
          anthropic: 'stored-test-key',
        },
      }, null, 2)}\n`,
      'utf-8',
    );

    const auth = new ProviderAuthManager({ authFilePath: authPath });
    await expect(auth.assertProvidersConfigured(['anthropic'])).resolves.toBeUndefined();
  });
});