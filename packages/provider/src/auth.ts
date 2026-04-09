import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { getEnvApiKey, getProviders } from '@mariozechner/pi-ai';
import {
  getOAuthApiKey,
  getOAuthProvider,
  getOAuthProviders,
  loginGitHubCopilot,
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

export interface ProviderInfo {
  id: string;
  name: string;
  authType: 'oauth' | 'api-key' | 'mixed';
  envVars: string[];
}

const GITHUB_COPILOT_PROVIDER_ID = 'github-copilot';
const COPILOT_TOKEN_REFRESH_SKEW_SECONDS = 120;
const COPILOT_TOKEN_NEAR_EXPIRY_WARNING_SECONDS = 10 * 60;

export interface ProviderTokenTtlStatus {
  provider: string;
  expiresAt?: string;
  expiresInSeconds?: number;
  isExpired: boolean;
  isNearExpiry: boolean;
  refreshRecommended: boolean;
}

export interface ProviderAuthStatus {
  provider: string;
  authType: ProviderInfo['authType'];
  envConfigured: boolean;
  oauthConfigured: boolean;
  storedApiKeyConfigured: boolean;
  source: 'store' | 'env' | 'oauth' | 'none';
  tokenTtl?: ProviderTokenTtlStatus;
}

export interface ProviderAuthManagerOptions {
  authFilePath?: string;
}

export interface ResolveApiKeyOptions {
  /**
   * Allow refresh side effects (token refresh + persistence) during resolve.
   * Defaults to true for backward compatibility when explicitly resolving credentials.
   */
  allowRefresh?: boolean;
}


export interface PersistedAuthStore {
  oauth: Record<string, OAuthCredentials>;
  apiKeys: Record<string, string>;
}

export class ProviderAuthManager {
  private readonly authFilePath: string;
  private readonly legacyAuthPaths: string[];

  constructor(options: ProviderAuthManagerOptions = {}) {
    const explicitAuthPath = options.authFilePath ?? process.env.ORCHESTRACE_AUTH_FILE;
    const workspaceRoot = findWorkspaceRoot(process.cwd());
    this.authFilePath = explicitAuthPath
      ? resolve(explicitAuthPath)
      : join(workspaceRoot, 'auth.json');

    this.legacyAuthPaths = [
      resolve('auth.json'),
      join(workspaceRoot, 'packages', 'cli', 'auth.json'),
    ].filter((path, index, all) => path !== this.authFilePath && all.indexOf(path) === index);
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
        if (id === GITHUB_COPILOT_PROVIDER_ID) {
          authType = 'oauth';
        } else if (oauth && envVars.length > 0) {
          authType = 'mixed';
        } else if (oauth) {
          authType = 'oauth';
        }

        return {
          id,
          name: oauth?.name ?? id,
          authType,
          envVars,
        };
      });
  }

  async loginOAuth(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
    let credentials: OAuthCredentials;

    // GitHub Copilot must use device/mobile code OAuth flow.
    if (providerId === GITHUB_COPILOT_PROVIDER_ID) {
      credentials = await loginGitHubCopilot({
        onAuth: (url, instructions) => callbacks.onAuth({ url, instructions }),
        onPrompt: callbacks.onPrompt,
        onProgress: callbacks.onProgress,
        signal: callbacks.signal,
      });
    } else {
      const provider = getOAuthProvider(providerId);
      if (!provider) {
        throw new Error(`Provider "${providerId}" does not support OAuth login.`);
      }
      credentials = await provider.login(callbacks);
    }

    const store = await this.loadStore();
    store.oauth[providerId] = credentials;
    await this.saveStore(store);
  }

  async configureApiKey(providerId: string, apiKey: string): Promise<{ path: string }> {
    if (providerId === 'github-copilot') {
      throw new Error(
        'GitHub Copilot authentication must use OAuth device/mobile code flow. '
        + 'Run `orchestrace auth github-copilot`.',
      );
    }

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

  async clearApiKey(providerId: string): Promise<{ path: string; removed: boolean }> {
    const store = await this.loadStore();
    const removed = providerId in store.apiKeys;
    if (removed) {
      delete store.apiKeys[providerId];
      await this.saveStore(store);
    }

    return { path: this.authFilePath, removed };
  }

      async resolveApiKey(providerId: string, options: ResolveApiKeyOptions = {}): Promise<string | undefined> {
    const store = await this.loadStore();
    const allowRefresh = options.allowRefresh ?? true;

    const storedApiKey = store.apiKeys[providerId];
    if (storedApiKey) {
      return storedApiKey;
    }

    const oauthCredentials = store.oauth[providerId];
    if (oauthCredentials) {
      try {
        if (providerId === GITHUB_COPILOT_PROVIDER_ID) {
          const ttl = computeTokenTtlStatus(providerId, oauthCredentials);
          if (!ttl || ttl.refreshRecommended) {
            if (!allowRefresh) {
              return undefined;
            }

            const result = await getOAuthApiKey(providerId as OAuthProviderId, store.oauth);
            if (!result) {
              return undefined;
            }

            store.oauth[providerId] = result.newCredentials;
            await this.saveStore(store);
            return result.apiKey;
          }

          const apiKey = oauthCredentials.access?.trim();
          if (apiKey) {
            return apiKey;
          }
        }

        if (!allowRefresh) {
          return undefined;
        }

        const result = await getOAuthApiKey(providerId as OAuthProviderId, store.oauth);
        if (!result) {
          return undefined;
        }

        store.oauth[providerId] = result.newCredentials;
        await this.saveStore(store);
        return result.apiKey;
      } catch {
        return undefined;
      }
    }

    // Optional fallback for users who still prefer environment variables.
    // GitHub Copilot intentionally does not use this fallback to enforce device OAuth.
    if (providerId === GITHUB_COPILOT_PROVIDER_ID) {
      return undefined;
    }

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
      tokenTtl: computeTokenTtlStatus(providerId, store.oauth[providerId]),
    };
  }

  async getTokenTtlStatus(providerId: string): Promise<ProviderTokenTtlStatus | undefined> {
    const store = await this.loadStore();
    return computeTokenTtlStatus(providerId, store.oauth[providerId]);
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
    const primary = await this.readStore(this.authFilePath);
    if (primary) {
      return primary;
    }

    // One-time migration path from older relative storage locations.
    for (const legacyPath of this.legacyAuthPaths) {
      const legacy = await this.readStore(legacyPath);
      if (!legacy) continue;

      await this.saveStore(legacy);
      return legacy;
    }

    return { oauth: {}, apiKeys: {} };
  }

  private async readStore(path: string): Promise<PersistedAuthStore | undefined> {
    try {
      const raw = await readFile(path, 'utf-8');
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
        return undefined;
      }
      throw error;
    }
  }

  private async saveStore(store: PersistedAuthStore): Promise<void> {
    await mkdir(dirname(this.authFilePath), { recursive: true });
    await writeFile(this.authFilePath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
  }
}

function getEnvVarCandidates(providerId: string): string[] {
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

function computeTokenTtlStatus(
  providerId: string,
  credentials: OAuthCredentials | undefined,
): ProviderTokenTtlStatus | undefined {
  if (!credentials || providerId !== GITHUB_COPILOT_PROVIDER_ID) {
    return undefined;
  }

  const expiresAtMs = normalizeExpiresToEpochMs(credentials.expires);
  if (!Number.isFinite(expiresAtMs)) {
    return {
      provider: providerId,
      isExpired: false,
      isNearExpiry: false,
      refreshRecommended: true,
    };
  }

  const nowMs = Date.now();
  const expiresInSeconds = Math.floor((expiresAtMs - nowMs) / 1000);
  const isExpired = expiresInSeconds <= 0;
  const isNearExpiry = expiresInSeconds <= COPILOT_TOKEN_NEAR_EXPIRY_WARNING_SECONDS;
  const refreshRecommended = expiresInSeconds <= COPILOT_TOKEN_REFRESH_SKEW_SECONDS;

  return {
    provider: providerId,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresInSeconds,
    isExpired,
    isNearExpiry,
    refreshRecommended,
  };
}

function normalizeExpiresToEpochMs(rawExpires: number): number {
  if (!Number.isFinite(rawExpires) || rawExpires <= 0) {
    return Number.NaN;
  }

  // OAuth libraries frequently serialize `exp` in seconds; legacy stores may keep milliseconds.
  return rawExpires > 1_000_000_000_000 ? rawExpires : rawExpires * 1000;
}

function findWorkspaceRoot(startDir: string): string {
  let current = resolve(startDir);

  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml')) || existsSync(join(current, '.git'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return resolve(startDir);
    }
    current = parent;
  }
}
