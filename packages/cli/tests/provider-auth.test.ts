import { describe, expect, it, vi } from 'vitest';
import { COPILOT_MINIMUM_REQUEST_TTL_SECONDS } from '@orchestrace/provider';
import {
  resolveCopilotApiKeyOptions,
  resolveProviderApiKeyWithCopilotTtl,
  withCopilotTtl,
} from '../src/provider-auth.js';

describe('provider-auth helper', () => {
  it('adds minimum TTL for github-copilot requests', () => {
    expect(resolveCopilotApiKeyOptions('github-copilot')).toEqual({
      minimumTtlSeconds: COPILOT_MINIMUM_REQUEST_TTL_SECONDS,
    });
  });

  it('leaves non-copilot provider options unchanged', () => {
    expect(resolveCopilotApiKeyOptions('anthropic')).toBeUndefined();
    expect(withCopilotTtl('anthropic', { allowRefresh: false })).toEqual({ allowRefresh: false });
  });

  it('merges TTL policy with caller-provided options', () => {
    expect(withCopilotTtl('github-copilot', { allowRefresh: false })).toEqual({
      allowRefresh: false,
      minimumTtlSeconds: COPILOT_MINIMUM_REQUEST_TTL_SECONDS,
    });
  });

  it('passes merged options to resolver', async () => {
    const resolver = vi.fn(async () => 'token');

    const token = await resolveProviderApiKeyWithCopilotTtl(
      resolver,
      'github-copilot',
      { allowRefresh: false },
    );

    expect(token).toBe('token');
    expect(resolver).toHaveBeenCalledWith('github-copilot', {
      allowRefresh: false,
      minimumTtlSeconds: COPILOT_MINIMUM_REQUEST_TTL_SECONDS,
    });
  });

  it('does not force TTL option for non-copilot resolver calls', async () => {
    const resolver = vi.fn(async () => 'token');

    await resolveProviderApiKeyWithCopilotTtl(resolver, 'anthropic');

    expect(resolver).toHaveBeenCalledWith('anthropic', undefined);
  });
});