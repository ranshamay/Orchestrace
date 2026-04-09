import type { ResolveApiKeyOptions } from '@orchestrace/provider';
import { COPILOT_MINIMUM_REQUEST_TTL_SECONDS } from '@orchestrace/provider';

const GITHUB_COPILOT_PROVIDER_ID = 'github-copilot';

export type ResolveProviderApiKey = (
  providerId: string,
  options?: ResolveApiKeyOptions,
) => Promise<string | undefined>;

export function resolveCopilotApiKeyOptions(providerId: string): ResolveApiKeyOptions | undefined {
  if (providerId !== GITHUB_COPILOT_PROVIDER_ID) {
    return undefined;
  }

  return {
    minimumTtlSeconds: COPILOT_MINIMUM_REQUEST_TTL_SECONDS,
  };
}

export function withCopilotTtl(
  providerId: string,
  options?: ResolveApiKeyOptions,
): ResolveApiKeyOptions | undefined {
  const copilotOptions = resolveCopilotApiKeyOptions(providerId);
  if (!copilotOptions) {
    return options;
  }

  return {
    ...copilotOptions,
    ...options,
  };
}

export async function resolveProviderApiKeyWithCopilotTtl(
  resolver: ResolveProviderApiKey,
  providerId: string,
  options?: ResolveApiKeyOptions,
): Promise<string | undefined> {
  return resolver(providerId, withCopilotTtl(providerId, options));
}