import { materializeSession, type EventStore, type SessionChatMessage } from '@orchestrace/store';

const DEFAULT_SCAN_INTERVAL_MS = 60_000;
const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_API_TIMEOUT_MS = 15_000;

export interface PrMergeScannerOptions {
  eventStore: EventStore;
  resolveGithubToken: () => Promise<string | undefined>;
  scanIntervalMs?: number;
}

export interface ExtractedPrInfo {
  host: string;
  owner: string;
  repo: string;
  prNumber: number;
  url: string;
}

interface ScannerRunContext {
  token?: string;
}

export class PrMergeScanner {
  private readonly eventStore: EventStore;
  private readonly resolveGithubToken: () => Promise<string | undefined>;
  private readonly scanIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private callbacks = new Set<(sessionId: string) => void>();

  constructor(options: PrMergeScannerOptions) {
    this.eventStore = options.eventStore;
    this.resolveGithubToken = options.resolveGithubToken;
    this.scanIntervalMs = Number.isFinite(options.scanIntervalMs) && (options.scanIntervalMs ?? 0) > 0
      ? Number(options.scanIntervalMs)
      : DEFAULT_SCAN_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    void this.scanOnce();
    this.timer = setInterval(() => {
      void this.scanOnce();
    }, this.scanIntervalMs);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  onSessionMerged(callback: (sessionId: string) => void): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  async scanOnce(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      const sessionIds = await this.eventStore.listSessions();
      const context: ScannerRunContext = {};
      for (const sessionId of sessionIds) {
        await this.scanSession(sessionId, context);
      }
    } catch (error) {
      console.warn(`[pr-merge-scanner] Scan failed: ${toErrorMessage(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async scanSession(sessionId: string, context: ScannerRunContext): Promise<void> {
    try {
      const events = await this.eventStore.read(sessionId);
      if (events.length === 0) {
        return;
      }

      const session = materializeSession(events);
      if (!session) {
        return;
      }

      if (session.status !== 'completed') {
        return;
      }

      if (session.config.deliveryStrategy === 'merge-after-ci') {
        // These sessions should already be merged by the delivery flow.
        return;
      }

      const pr = extractPrInfoFromMessages(session.chatThread?.messages ?? []);
      if (!pr) {
        return;
      }

      const token = await this.resolveToken(context);
      if (!token) {
        return;
      }

      const merged = await isPullRequestMerged({ token, pr });
      if (!merged) {
        return;
      }

      const time = new Date().toISOString();
      await this.eventStore.append(sessionId, {
        time,
        type: 'session:status-change',
        payload: { status: 'merged' },
      });

      for (const callback of this.callbacks) {
        try {
          callback(sessionId);
        } catch {
          // Isolate callback failures so scanner keeps running.
        }
      }
    } catch (error) {
      console.warn(`[pr-merge-scanner] Session ${sessionId} scan failed: ${toErrorMessage(error)}`);
    }
  }

  private async resolveToken(context: ScannerRunContext): Promise<string | undefined> {
    if (context.token) {
      return context.token;
    }

    const token = await this.resolveGithubToken().catch(() => undefined);
    if (!token) {
      return undefined;
    }

    context.token = token;
    return token;
  }
}

export function extractPrInfoFromMessages(messages: SessionChatMessage[]): ExtractedPrInfo | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'system') {
      continue;
    }
    const parsed = extractPrInfoFromText(message.content);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

function extractPrInfoFromText(content: string): ExtractedPrInfo | undefined {
  const urlMatches = content.match(/https?:\/\/[^\s)]+/gi);
  if (!urlMatches || urlMatches.length === 0) {
    return undefined;
  }

  for (const candidate of urlMatches) {
    const parsed = parsePullRequestUrl(candidate);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

function parsePullRequestUrl(rawUrl: string): ExtractedPrInfo | undefined {
  const cleaned = rawUrl.trim().replace(/[),.;!?]+$/, '');
  try {
    const url = new URL(cleaned);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 4) {
      return undefined;
    }

    const [owner, repo, kind, numberPart] = parts;
    if (kind !== 'pull') {
      return undefined;
    }

    const prNumber = Number.parseInt(numberPart, 10);
    if (!Number.isFinite(prNumber) || prNumber <= 0) {
      return undefined;
    }

    return {
      host: url.hostname.toLowerCase(),
      owner,
      repo,
      prNumber,
      url: `${url.protocol}//${url.host}/${owner}/${repo}/pull/${prNumber}`,
    };
  } catch {
    return undefined;
  }
}

async function isPullRequestMerged(params: { token: string; pr: ExtractedPrInfo }): Promise<boolean> {
  const baseUrl = buildGitHubApiBaseUrl(params.pr.host);
  const path = `/repos/${params.pr.owner}/${params.pr.repo}/pulls/${params.pr.prNumber}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `token ${params.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'orchestrace-pr-merge-scanner',
    },
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });

  if (!response.ok) {
    return false;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return false;
  }

  const data = await response.json().catch(() => undefined);
  if (!isRecord(data)) {
    return false;
  }

  if (typeof data.merged === 'boolean') {
    return data.merged;
  }

  return typeof data.merged_at === 'string' && data.merged_at.length > 0;
}

function buildGitHubApiBaseUrl(host: string): string {
  const normalizedHost = host.trim().toLowerCase();
  if (normalizedHost === 'github.com') {
    return GITHUB_API_BASE_URL;
  }
  return `https://${normalizedHost}/api/v3`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error);
}