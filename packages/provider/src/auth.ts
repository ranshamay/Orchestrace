import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getEnvApiKey, getProviders } from '@mariozechner/pi-ai';
import {
  getOAuthApiKey,
  getOAuthProvider,
  getOAuthProviders,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type OAuthProviderId,
} from '@mariozechner/pi-ai/oauth';

const ENV_VAR_BY_PROVIDER: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  'google-vertex': 'GOOGLE_CLOUD_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  'kimi-coding': 'KIMI_API_KEY',
  zai: 'ZAI_API_KEY',
};

const COPILOT_ENV_VARS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];

export interface ProviderInfo {
  id: string;
  name: string;
  authType: 'oauth' | 'api-key' | 'mixed';
  envVars: string[];
}

export interface ProviderAuthStatus {
  provider: string;
  authType: ProviderInfo['authType'];
  envConfigured: boolean;
  oauthConfigured: boolean;
  storedApiKeyConfigured: boolean;
  source: 'store' | 'env' | 'oauth' | 'none';
}

export interface ProviderAuthManagerOptions {
  authFilePath?: string;
}

export interface PersistedAuthStore {
  oauth: Record<string, OAuthCredentials>;
  apiKeys: Record<string, string>;
}

export class ProviderAuthManager {
  private readonly authFilePath: string;

  constructor(options: ProviderAuthManagerOptions = {}) {
    this.authFilePath = resolve(options.authFilePath ?? process.env.ORCHESTRACE_AUTH_FILE ?? 'auth.json');
  }

  listProviders(): ProviderInfo[] {
    const oauthProviders = new Map(getOAuthProviders().map((provider) => [provider.id, provider]));
    const ids = new Set<string>([
      ...getProviders().map((provider) => String(provider)),
      ...oauthProviders.keys(),
    ]);

    return [...ids]
      .sort((a, b) => a.localeCompare(b))
      .map((id) => {
        const oauth = oauthProviders.get(id);
        const envVars = getEnvVarCandidates(id);

        let authType: ProviderInfo['authType'] = 'api-key';
        if (oauth && envVars.length > 0) authType = 'mixed';
        else if (oauth) authType = 'oauth';

        return {
          id,
          name: oauth?.name ?? id,
          authType,
          envVars,
        };
      });
  }

  async loginOAuth(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      throw new Error(`Provider "${providerId}" does not support OAuth login.`);
    }

    const credentials = await provider.login(callbacks);
    const store = await this.loadStore();
    store.oauth[providerId] = credentials;
    await this.saveStore(store);
  }

  async configureApiKey(providerId: string, apiKey: string): Promise<{ path: string }> {
    const sanitized = apiKey.trim();
    if (!sanitized) {
      throw new Error('API key cannot be empty.');
    }

    const store = await this.loadStore();
    store.apiKeys[providerId] = sanitized;
    await this.saveStore(store);

    const envVar = getPrimaryEnvVar(providerId);
    if (envVar) {
      process.env[envVar] = sanitized;
    }

    return { path: this.authFilePath };
  }

  async resolveApiKey(providerId: string): Promise<string | undefined> {
    const store = await this.loadStore();

    const storedApiKey = store.apiKeys[providerId];
    if (storedApiKey) {
      return storedApiKey;
    }

    if (store.oauth[providerId]) {
      const result = await getOAuthApiKey(providerId as OAuthProviderId, store.oauth);
      if (!result) {
        return undefined;
      }

      store.oauth[providerId] = result.newCredentials;
      await this.saveStore(store);
      return result.apiKey;
    }

    // Optional fallback for users who still prefer environment variables.
    const envApiKey = getEnvApiKey(providerId as never);
    if (envApiKey) {
      return envApiKey;
    }

    return undefined;
  }

  async getStatus(providerId: string): Promise<ProviderAuthStatus> {
    const provider = this.listProviders().find((item) => item.id === providerId) ?? {
      id: providerId,
      name: providerId,
      authType: 'api-key' as const,
      envVars: getEnvVarCandidates(providerId),
    };

    const store = await this.loadStore();
    const oauthConfigured = Boolean(store.oauth[providerId]);
    const storedApiKeyConfigured = Boolean(store.apiKeys[providerId]);
    const envConfigured = provider.envVars.some((envVar) => Boolean(process.env[envVar]));

    return {
      provider: provider.id,
      authType: provider.authType,
      envConfigured,
      oauthConfigured,
      storedApiKeyConfigured,
      source: storedApiKeyConfigured ? 'store' : oauthConfigured ? 'oauth' : envConfigured ? 'env' : 'none',
    };
  }

  async getAllStatus(): Promise<ProviderAuthStatus[]> {
    const providers = this.listProviders();
    const statuses: ProviderAuthStatus[] = [];

    for (const provider of providers) {
      statuses.push(await this.getStatus(provider.id));
    }

    return statuses;
  }

  private async loadStore(): Promise<PersistedAuthStore> {
    try {
      const raw = await readFile(this.authFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return { oauth: {}, apiKeys: {} };
      }

      // New format
      if ('oauth' in parsed || 'apiKeys' in parsed) {
        const oauth = isRecord(parsed.oauth) ? parsed.oauth as Record<string, OAuthCredentials> : {};
        const apiKeys = isRecord(parsed.apiKeys) ? parsed.apiKeys as Record<string, string> : {};
        return { oauth, apiKeys };
      }

      // Backward compatibility: old format stored OAuth credentials at root.
      const oauth: Record<string, OAuthCredentials> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (looksLikeOAuthCredentials(value)) {
          oauth[key] = value;
        }
      }

      return { oauth, apiKeys: {} };
    } catch (error) {
      if (isFileMissing(error)) {
        return { oauth: {}, apiKeys: {} };
      }
      throw error;
    }
  }

  private async saveStore(store: PersistedAuthStore): Promise<void> {
    await writeFile(this.authFilePath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
  }
}

function getEnvVarCandidates(providerId: string): string[] {
  if (providerId === 'github-copilot') {
    return COPILOT_ENV_VARS;
  }

  const primary = ENV_VAR_BY_PROVIDER[providerId];
  return primary ? [primary] : [];
}

function getPrimaryEnvVar(providerId: string): string | undefined {
  const vars = getEnvVarCandidates(providerId);
  return vars[0];
}

function isFileMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function looksLikeOAuthCredentials(value: unknown): value is OAuthCredentials {
  if (!isRecord(value)) return false;
  return typeof value.access === 'string'
    && typeof value.refresh === 'string'
    && typeof value.expires === 'number';
}
