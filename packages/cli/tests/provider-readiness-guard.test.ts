import { describe, expect, it, vi } from 'vitest';
import { validateSessionProvidersReadiness } from '../src/ui-server.js';

describe('provider readiness guard', () => {
  it('fails fast with actionable planning-provider message when credentials are missing', async () => {
    const authManager = {
      validateProviderReadiness: vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          provider: 'github-copilot',
          code: 'provider_missing_credentials',
          source: 'none',
          message: 'GitHub Copilot is missing credentials. Connect OAuth credentials via `orchestrace auth github-copilot`.',
          remediation: ['Connect OAuth credentials via `orchestrace auth github-copilot`.'],
        }),
    };

    const result = await validateSessionProvidersReadiness(
      authManager as never,
      'github-copilot',
      'anthropic',
    );

    expect(result).toEqual({
      ok: false,
      statusCode: 400,
      error: expect.stringContaining('Planning provider is not ready'),
    });
    expect(authManager.validateProviderReadiness).toHaveBeenCalledTimes(1);
    expect(authManager.validateProviderReadiness).toHaveBeenCalledWith('github-copilot');
  });

  it('passes when both planning and implementation providers are ready', async () => {
    const authManager = {
      validateProviderReadiness: vi.fn()
        .mockResolvedValueOnce({ ok: true, provider: 'github-copilot', source: 'oauth' })
        .mockResolvedValueOnce({ ok: true, provider: 'anthropic', source: 'env' }),
    };

    const result = await validateSessionProvidersReadiness(
      authManager as never,
      'github-copilot',
      'anthropic',
    );

    expect(result).toEqual({ ok: true });
    expect(authManager.validateProviderReadiness).toHaveBeenCalledTimes(2);
    expect(authManager.validateProviderReadiness).toHaveBeenNthCalledWith(1, 'github-copilot');
    expect(authManager.validateProviderReadiness).toHaveBeenNthCalledWith(2, 'anthropic');
  });
});