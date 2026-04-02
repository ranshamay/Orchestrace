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
  source: 'env' | 'oauth' | 'none';
}

export interface ProviderAuthManagerOptions {
  authFilePath?: string;
  envFilePath?: string;
}

export class ProviderAuthManager {
  private readonly authFilePath: string;
  private readonly envFilePath: string;

  constructor(options: ProviderAuthManagerOptions = {}) {
    this.authFilePath = resolve(options.authFilePath ?? 'auth.json');
    this.envFilePath = resolve(options.envFilePath ?? '.env');
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
    const auth = await this.loadAuthFile();
    auth[providerId] = credentials;
    await this.saveAuthFile(auth);
  }

  async configureApiKey(providerId: string, apiKey: string): Promise<{ envVar: string }> {
    const envVar = getPrimaryEnvVar(providerId);
    if (!envVar) {
      throw new Error(
        `No default environment variable mapping for provider "${providerId}". `
        + 'Use provider docs and set env vars manually.',
      );
    }

    await this.upsertEnvVar(envVar, apiKey);
    process.env[envVar] = apiKey;
    return { envVar };
  }

  async resolveApiKey(providerId: string): Promise<string | undefined> {
    const envApiKey = getEnvApiKey(providerId as never);
    if (envApiKey) {
      return envApiKey;
    }

    const auth = await this.loadAuthFile();
    if (!auth[providerId]) {
      return undefined;
    }

    const result = await getOAuthApiKey(providerId as OAuthProviderId, auth);
    if (!result) {
      return undefined;
    }

    auth[providerId] = result.newCredentials;
    await this.saveAuthFile(auth);
    return result.apiKey;
  }

  async getStatus(providerId: string): Promise<ProviderAuthStatus> {
    const provider = this.listProviders().find((item) => item.id === providerId) ?? {
      id: providerId,
      name: providerId,
      authType: 'api-key' as const,
      envVars: getEnvVarCandidates(providerId),
    };

    const auth = await this.loadAuthFile();
    const oauthConfigured = Boolean(auth[providerId]);
    const envConfigured = provider.envVars.some((envVar) => Boolean(process.env[envVar]));

    return {
      provider: provider.id,
      authType: provider.authType,
      envConfigured,
      oauthConfigured,
      source: envConfigured ? 'env' : oauthConfigured ? 'oauth' : 'none',
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

  private async loadAuthFile(): Promise<Record<string, OAuthCredentials>> {
    try {
      const raw = await readFile(this.authFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, OAuthCredentials>;
      }
      return {};
    } catch (error) {
      if (isFileMissing(error)) {
        return {};
      }
      throw error;
    }
  }

  private async saveAuthFile(auth: Record<string, OAuthCredentials>): Promise<void> {
    await writeFile(this.authFilePath, `${JSON.stringify(auth, null, 2)}\n`, 'utf-8');
  }

  private async upsertEnvVar(name: string, value: string): Promise<void> {
    const sanitized = value.trim();
    const line = `${name}=${sanitized}`;

    let current = '';
    try {
      current = await readFile(this.envFilePath, 'utf-8');
    } catch (error) {
      if (!isFileMissing(error)) {
        throw error;
      }
    }

    const escapedName = escapeRegex(name);
    const matcher = new RegExp(`^${escapedName}=.*$`, 'm');

    const next = matcher.test(current)
      ? current.replace(matcher, line)
      : `${current.trimEnd()}${current.trimEnd() ? '\n' : ''}${line}\n`;

    await writeFile(this.envFilePath, next, 'utf-8');
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

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
