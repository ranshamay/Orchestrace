// ---------------------------------------------------------------------------
// Observer — Daemon
// ---------------------------------------------------------------------------
// Long-lived background process that watches session event logs, analyzes
// completed sessions via LLM, and spawns fix sessions for findings.
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventStore } from '@orchestrace/store';
import type { LlmAdapter } from '@orchestrace/provider';
import {
  ALL_FINDING_CATEGORIES,
  DEFAULT_OBSERVER_CONFIG,
  type FindingCategory,
  type FindingSeverity,
  type ObserverConfig,
  type ObserverDaemonState,
} from './types.js';
import { FindingRegistry } from './registry.js';
import { summarizeSession, formatSummaryForLlm, type SessionSummary } from './summarizer.js';
import { analyzeSessionSummaries } from './analyzer.js';
import { spawnFixSessions, type StartSessionFn } from './spawner.js';
import type { LogFindingCategory } from './log-watcher.js';

type AnalysisSummaryEntry = {
  sessionId: string;
  summary: SessionSummary;
  estimatedPromptChars: number;
};

type LogWatcherFindingInput = {
  category: LogFindingCategory;
  severity: FindingSeverity;
  title: string;
  issueSummary: string;
  evidence: string[];
  severityRationale?: string;
  relevantFiles?: string[];
};

type RealtimeFindingInput = {
  category: FindingCategory;
  severity: FindingSeverity;
  title: string;
  issueSummary: string;
  evidence: string[];
  severityRationale?: string;
  relevantFiles?: string[];
};

type FindingContractInput = {
  severity: FindingSeverity;
  issueSummary: string;
  evidence: string[];
  severityRationale?: string;
};

const LOG_WATCHER_SOURCE_SESSION_ID = 'log-watcher';

export interface ObserverDaemonOptions {
  /** Root .orchestrace directory path. */
  orchestraceDir: string;
  /** Event store instance (shared with ui-server). */
  eventStore: EventStore;
  /** LLM adapter (shared with ui-server). */
  llm: LlmAdapter;
  /** Function to create a new work session (closure from ui-server). */
  startSession: StartSessionFn;
  /** Resolve API key for a given provider (shared auth with ui-server). */
  resolveApiKey: (provider: string) => Promise<string | undefined>;
}

export class ObserverDaemon {
  private readonly orchestraceDir: string;
  private readonly observerDir: string;
  private readonly eventStore: EventStore;
  private readonly llm: LlmAdapter;
  private readonly startSession: StartSessionFn;
  private readonly resolveApiKey: (provider: string) => Promise<string | undefined>;
  private readonly registry: FindingRegistry;
  private config: ObserverConfig = { ...DEFAULT_OBSERVER_CONFIG };
  private state: ObserverDaemonState = {
    running: false,
    lastAnalysisAt: null,
    analyzedSessions: new Set(),
    observerSessionIds: new Set(),
  };
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private controller = new AbortController();
  private rateLimitBlockedUntilMs = 0;
  private consecutiveRateLimitFailures = 0;
  /**
   * Fix session IDs spawned during THIS process run only.
   * Used for the concurrency limit. Separate from observerSessionIds which
   * tracks ALL-time observer sessions (used to skip re-analysis).
   */
  private activeFixSessionIds: Set<string> = new Set();

  constructor(options: ObserverDaemonOptions) {
    this.orchestraceDir = options.orchestraceDir;
    this.observerDir = join(options.orchestraceDir, 'observer');
    this.eventStore = options.eventStore;
    this.llm = options.llm;
    this.startSession = options.startSession;
    this.resolveApiKey = options.resolveApiKey;
    this.registry = new FindingRegistry(this.observerDir);
  }

  /** Initialize: load config & findings from disk, start the loop if enabled. */
  async start(): Promise<void> {
    await this.loadConfig();
    await this.loadState();
    await this.registry.load();

    // Seed observer session IDs and already-analyzed sessions from registry
    for (const finding of this.registry.getAll()) {
      if (finding.fixSessionId) {
        this.state.observerSessionIds.add(finding.fixSessionId);
      }
      for (const sid of finding.observedInSessions ?? []) {
        this.state.analyzedSessions.add(sid);
      }
    }

    if (this.config.enabled) {
      this.state.running = true;
      console.log('[orchestrace][observer] Daemon started');
      this.scheduleNextCycle();
    } else {
      console.log('[orchestrace][observer] Daemon loaded but disabled (enable via API or config)');
    }
  }

  /** Stop the daemon loop. */
  stop(): void {
    this.state.running = false;
    this.controller.abort();
    this.controller = new AbortController();
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    console.log('[orchestrace][observer] Daemon stopped');
  }

  /** Enable or disable the daemon. Persists to config. */
  async setEnabled(enabled: boolean): Promise<void> {
    this.config.enabled = enabled;
    await this.saveConfig();

    if (enabled && !this.state.running) {
      this.state.running = true;
      this.controller = new AbortController();
      console.log('[orchestrace][observer] Daemon enabled');
      this.scheduleNextCycle();
    } else if (!enabled && this.state.running) {
      this.stop();
    }
  }

  /** Update observer configuration. */
  async updateConfig(partial: Partial<ObserverConfig>): Promise<void> {
    Object.assign(this.config, partial);
    this.config = sanitizeObserverConfig(this.config);
    await this.saveConfig();
  }

  /** Get current config (for API). */
  getConfig(): Readonly<ObserverConfig> {
    return this.config;
  }

  /** Get current daemon state (for API). */
  getState(): {
    running: boolean;
    lastAnalysisAt: string | null;
    rateLimitedUntil: string | null;
    analyzedCount: number;
    pendingFindings: number;
    totalFindings: number;
  } {
    return {
      running: this.state.running,
      lastAnalysisAt: this.state.lastAnalysisAt,
      rateLimitedUntil: this.rateLimitBlockedUntilMs > Date.now()
        ? new Date(this.rateLimitBlockedUntilMs).toISOString()
        : null,
      analyzedCount: this.state.analyzedSessions.size,
      pendingFindings: this.registry.getPending().length,
      totalFindings: this.registry.getAll().length,
    };
  }

  /** Get all findings (for API). */
  getFindings() {
    return this.registry.getAll();
  }

  /** Get analyzed session ids (for API). */
  getAnalyzedSessionIds(): string[] {
    return [...this.state.analyzedSessions];
  }

  /** Check if a session was created by the observer. */
  isObserverSession(sessionId: string): boolean {
    return this.state.observerSessionIds.has(sessionId) || this.registry.isObserverSession(sessionId);
  }

  /** Manually trigger an analysis cycle (for API/testing). */
  async triggerAnalysis(): Promise<{ analyzed: number; findings: number; spawned: number }> {
    return this.runAnalysisCycle();
  }

  /**
   * Register newly detected log-watcher findings and spawn fix sessions immediately.
   * This bypasses the daemon cooldown loop so backend log issues can trigger remediation quickly.
   */
  async ingestLogWatcherFindings(findings: LogWatcherFindingInput[]): Promise<{ registered: number; spawned: number }> {
    if (findings.length === 0) {
      return { registered: 0, spawned: 0 };
    }

    let registered = 0;
    for (const finding of findings) {
      const mappedCategory = mapLogWatcherCategory(finding.category);
      if (!this.config.assessmentCategories.includes(mappedCategory)) {
        continue;
      }
      if (!isValidFindingContract(finding)) {
        continue;
      }

      const { isNew } = this.registry.register({
        category: mappedCategory,
        severity: finding.severity,
        title: finding.title,
        issueSummary: finding.issueSummary,
        evidence: finding.evidence,
        severityRationale: finding.severityRationale,
        relevantFiles: finding.relevantFiles,
      }, [LOG_WATCHER_SOURCE_SESSION_ID]);

      if (isNew) {
        registered += 1;
      }
    }

    const spawned = await this.spawnPendingFindings();
    await this.registry.save();

    if (registered > 0 || spawned > 0) {
      console.log(
        `[orchestrace][observer] Log watcher ingest: registered=${registered} spawned=${spawned}`,
      );
    }

    return { registered, spawned };
  }

  /**
   * Register newly detected per-session observer findings and spawn fix sessions immediately.
   */
  async ingestSessionObserverFindings(
    sourceSessionId: string,
    findings: RealtimeFindingInput[],
  ): Promise<{ registered: number; spawned: number }> {
    if (!sourceSessionId || findings.length === 0) {
      return { registered: 0, spawned: 0 };
    }

    let registered = 0;
    for (const finding of findings) {
      if (!this.config.assessmentCategories.includes(finding.category)) {
        continue;
      }
      if (!isValidFindingContract(finding)) {
        continue;
      }

      const { isNew } = this.registry.register({
        category: finding.category,
        severity: finding.severity,
        title: finding.title,
        issueSummary: finding.issueSummary,
        evidence: finding.evidence,
        severityRationale: finding.severityRationale,
        relevantFiles: finding.relevantFiles,
      }, [sourceSessionId]);

      if (isNew) {
        registered += 1;
      }
    }

    const spawned = await this.spawnPendingFindings();
    await this.registry.save();

    if (registered > 0 || spawned > 0) {
      console.log(
        `[orchestrace][observer] Session observer ingest (${sourceSessionId}): registered=${registered} spawned=${spawned}`,
      );
    }

    return { registered, spawned };
  }

  /**
   * Spawn ALL pending findings immediately, ignoring the concurrent sessions cap.
   * For use via the API when manually draining the queue.
   * Returns the number of sessions successfully spawned.
   */
  async spawnAll(): Promise<number> {
    const spawned = await spawnFixSessions(this.registry, this.config, this.startSession, 0, true);
    if (spawned > 0) {
      this.trackNewlySpawnedFixSessions();
      await this.registry.save();
      console.log(`[orchestrace][observer] Spawned all: ${spawned} fix sessions queued`);
    }
    return spawned;
  }

  /**
   * Notify the daemon that a fix session has reached a terminal state.
   * Closes the loop: marks the associated finding as completed or failed
   * based on whether the session succeeded and opened a PR.
   */
  onFixSessionCompleted(sessionId: string, status: 'completed' | 'failed' | 'cancelled', outputText?: string): void {
    this.activeFixSessionIds.delete(sessionId);

    const finding = this.registry.getAll().find((f) => f.fixSessionId === sessionId);
    if (!finding) return;

    if (status === 'completed' && outputText && hasPrUrl(outputText)) {
      this.registry.markFixResult(finding.fingerprint, 'completed');
      void this.registry.save();
      console.log(
        `[orchestrace][observer] Finding "${finding.title}" resolved — PR detected in fix session ${sessionId}`,
      );
    } else if (status === 'failed' || status === 'cancelled') {
      this.registry.markFixResult(finding.fingerprint, 'failed');
      void this.registry.save();
      console.log(
        `[orchestrace][observer] Finding "${finding.title}" fix session ${sessionId} ${status}`,
      );
    }
    // If completed without a PR, leave as 'spawned' — could still be in progress or partial fix
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private scheduleNextCycle(): void {
    if (!this.state.running) return;
    this.loopTimer = setTimeout(async () => {
      try {
        await this.runAnalysisCycle();
      } catch (err) {
        console.error('[orchestrace][observer] Analysis cycle error:', err);
      }
      this.scheduleNextCycle();
    }, this.config.analysisCooldownMs);
  }

  private async runAnalysisCycle(): Promise<{ analyzed: number; findings: number; spawned: number }> {
    const nowMs = Date.now();
    if (this.rateLimitBlockedUntilMs > nowMs) {
      return { analyzed: 0, findings: 0, spawned: 0 };
    }

    const allSessionIds = await this.eventStore.listSessions();

    // Filter out: already analyzed, observer's own sessions, excluded
    const candidates = allSessionIds.filter((sid) => {
      if (this.state.analyzedSessions.has(sid)) return false;
      if (this.state.observerSessionIds.has(sid)) return false;
      if (this.config.excludeSessionIds.includes(sid)) return false;
      return true;
    });

    // Only analyze completed/failed sessions (not running ones)
    const toAnalyze: string[] = [];
    for (const sid of candidates) {
      const events = await this.eventStore.read(sid);
      const statusEvent = [...events].reverse().find((e) => e.type === 'session:status-change');
      if (statusEvent && statusEvent.type === 'session:status-change') {
        const status = statusEvent.payload.status;
        if (status === 'completed' || status === 'failed') {
          toAnalyze.push(sid);
        }
      }
    }

    if (toAnalyze.length === 0) {
      // No new sessions to analyze, but still try to spawn pending findings.
      const spawned = await this.spawnPendingFindings();
      return { analyzed: 0, findings: 0, spawned };
    }

    // Summarize sessions
    const summaries: AnalysisSummaryEntry[] = [];
    for (const sid of toAnalyze) {
      const summary = await summarizeSession(this.eventStore, sid);
      if (summary) {
        summaries.push({
          sessionId: sid,
          summary,
          estimatedPromptChars: estimateSummaryPromptChars(summary),
        });
      }
    }

    if (summaries.length === 0) {
      const spawned = await this.spawnPendingFindings();
      return { analyzed: 0, findings: 0, spawned };
    }

    const batches = createAnalysisBatches(
      summaries,
      this.config.maxAnalysisPromptChars,
      this.config.maxSessionsPerAnalysisBatch,
    );

    let analyzedCount = 0;
    let newFindings = 0;
    let rateLimited = false;
    for (const batch of batches) {
      try {
        const analysisResult = await analyzeSessionSummaries(
          this.llm,
          this.config,
          batch.map((entry) => entry.summary),
          this.controller.signal,
          this.resolveApiKey,
        );

        // Register findings with dedup
        const sessionIds = batch.map((entry) => entry.sessionId);
        for (const finding of analysisResult.findings) {
          const { isNew } = this.registry.register(finding, sessionIds);
          if (isNew) newFindings++;
        }

        // Mark sessions analyzed only after successful analysis call.
        for (const entry of batch) {
          this.state.analyzedSessions.add(entry.sessionId);
        }
        analyzedCount += batch.length;
      } catch (error) {
        if (!isRateLimitError(error)) {
          throw error;
        }

        rateLimited = true;
        const cooldownMs = this.applyRateLimitCooldown();
        await this.saveState();
        console.warn(
          `[orchestrace][observer] Rate limit hit; pausing analysis for ${Math.round(cooldownMs / 1000)}s.`,
        );
        break;
      }
    }

    if (!rateLimited) {
      this.consecutiveRateLimitFailures = 0;
      this.rateLimitBlockedUntilMs = 0;
    }

    // Spawn fix sessions for pending findings, respecting concurrency limit.
    const spawned = await this.spawnPendingFindings();

    await this.registry.save();
    this.state.lastAnalysisAt = new Date().toISOString();
    await this.saveState();

    console.log(
      `[orchestrace][observer] Cycle complete: analyzed=${analyzedCount} findings=${newFindings} spawned=${spawned}`,
    );

    return { analyzed: analyzedCount, findings: newFindings, spawned };
  }

  /** Spawn fix sessions for all pending findings. Extracted so it can be called from early-return paths. */
  private async spawnPendingFindings(): Promise<number> {
    const activeFixSessionCount = this.activeFixSessionIds.size;
    const spawned = await spawnFixSessions(this.registry, this.config, this.startSession, activeFixSessionCount);
    if (spawned > 0) {
      this.trackNewlySpawnedFixSessions();
      await this.registry.save();
    }
    return spawned;
  }

  /**
   * Record only fix sessions first seen in this process run as active.
   * Previously spawned historical sessions are tracked in observerSessionIds at startup
   * and must not count against current concurrency.
   */
  private trackNewlySpawnedFixSessions(): void {
    for (const finding of this.registry.getAll()) {
      if (!finding.fixSessionId || finding.fixStatus !== 'spawned') {
        continue;
      }

      if (!this.state.observerSessionIds.has(finding.fixSessionId)) {
        this.state.observerSessionIds.add(finding.fixSessionId);
        this.activeFixSessionIds.add(finding.fixSessionId);
      }
    }
  }

  private applyRateLimitCooldown(): number {
    const baseCooldownMs = Math.max(5_000, this.config.rateLimitCooldownMs);
    const maxCooldownMs = Math.max(baseCooldownMs, this.config.maxRateLimitBackoffMs);
    const exponent = Math.min(this.consecutiveRateLimitFailures, 8);
    const cooldownMs = Math.min(baseCooldownMs * (2 ** exponent), maxCooldownMs);
    this.consecutiveRateLimitFailures += 1;
    this.rateLimitBlockedUntilMs = Date.now() + cooldownMs;
    return cooldownMs;
  }

  private async loadConfig(): Promise<void> {
    const configPath = join(this.observerDir, 'config.json');
    try {
      const raw = await readFile(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      this.config = sanitizeObserverConfig({ ...DEFAULT_OBSERVER_CONFIG, ...parsed });
    } catch {
      // No config file — use defaults
      this.config = sanitizeObserverConfig({ ...DEFAULT_OBSERVER_CONFIG });
    }
  }

  private async saveConfig(): Promise<void> {
    const configPath = join(this.observerDir, 'config.json');
    await mkdir(this.observerDir, { recursive: true });
    await writeFile(configPath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  /**
   * Load durable daemon state (analyzed sessions + rate-limit backoff) from disk
   * so that restarts do not re-analyze sessions or reset cooldown windows.
   */
  private async loadState(): Promise<void> {
    const statePath = join(this.observerDir, 'state.json');
    try {
      const raw = await readFile(statePath, 'utf-8');
      const parsed = JSON.parse(raw) as {
        analyzedSessions?: string[];
        rateLimitBlockedUntilMs?: number;
        consecutiveRateLimitFailures?: number;
        lastAnalysisAt?: string | null;
      };

      if (Array.isArray(parsed.analyzedSessions)) {
        for (const sid of parsed.analyzedSessions) {
          if (typeof sid === 'string') {
            this.state.analyzedSessions.add(sid);
          }
        }
      }

      if (typeof parsed.rateLimitBlockedUntilMs === 'number' && Number.isFinite(parsed.rateLimitBlockedUntilMs)) {
        this.rateLimitBlockedUntilMs = parsed.rateLimitBlockedUntilMs;
      }
      if (typeof parsed.consecutiveRateLimitFailures === 'number' && Number.isFinite(parsed.consecutiveRateLimitFailures)) {
        this.consecutiveRateLimitFailures = Math.max(0, Math.round(parsed.consecutiveRateLimitFailures));
      }
      if (typeof parsed.lastAnalysisAt === 'string') {
        this.state.lastAnalysisAt = parsed.lastAnalysisAt;
      }
    } catch {
      // No state file yet — start fresh
    }
  }

  /** Persist durable daemon state to disk. */
  private async saveState(): Promise<void> {
    const statePath = join(this.observerDir, 'state.json');
    await mkdir(this.observerDir, { recursive: true });
    const payload = {
      analyzedSessions: [...this.state.analyzedSessions],
      rateLimitBlockedUntilMs: this.rateLimitBlockedUntilMs,
      consecutiveRateLimitFailures: this.consecutiveRateLimitFailures,
      lastAnalysisAt: this.state.lastAnalysisAt,
    };
    await writeFile(statePath, JSON.stringify(payload, null, 2), 'utf-8');
  }
}

function sanitizeObserverConfig(config: ObserverConfig): ObserverConfig {
  const provider = sanitizeNonEmptyString(config.provider, DEFAULT_OBSERVER_CONFIG.provider);
  const model = sanitizeNonEmptyString(config.model, DEFAULT_OBSERVER_CONFIG.model);
  const logWatcherProvider = sanitizeNonEmptyString(config.logWatcherProvider, provider);
  const logWatcherModel = sanitizeNonEmptyString(config.logWatcherModel, model);
  const fixProvider = sanitizeNonEmptyString(config.fixProvider, DEFAULT_OBSERVER_CONFIG.fixProvider);
  const fixModel = sanitizeNonEmptyString(config.fixModel, DEFAULT_OBSERVER_CONFIG.fixModel);
  const categories = Array.isArray(config.assessmentCategories)
    ? config.assessmentCategories.filter((c): c is FindingCategory =>
      ALL_FINDING_CATEGORIES.includes(c as FindingCategory),
    )
    : [];

  const analysisCooldownMs = clampInt(config.analysisCooldownMs, 10_000, 86_400_000, DEFAULT_OBSERVER_CONFIG.analysisCooldownMs);
  const maxAnalysisPromptChars = clampInt(
    config.maxAnalysisPromptChars,
    20_000,
    2_000_000,
    DEFAULT_OBSERVER_CONFIG.maxAnalysisPromptChars,
  );
  const maxSessionsPerAnalysisBatch = clampInt(
    config.maxSessionsPerAnalysisBatch,
    1,
    50,
    DEFAULT_OBSERVER_CONFIG.maxSessionsPerAnalysisBatch,
  );
  const rateLimitCooldownMs = clampInt(
    config.rateLimitCooldownMs,
    5_000,
    86_400_000,
    DEFAULT_OBSERVER_CONFIG.rateLimitCooldownMs,
  );
  const maxRateLimitBackoffMs = clampInt(
    config.maxRateLimitBackoffMs,
    rateLimitCooldownMs,
    86_400_000,
    DEFAULT_OBSERVER_CONFIG.maxRateLimitBackoffMs,
  );
  const maxConcurrentFixSessions = clampInt(
    config.maxConcurrentFixSessions,
    0,
    100,
    DEFAULT_OBSERVER_CONFIG.maxConcurrentFixSessions,
  );

  return {
    ...config,
    provider,
    model,
    logWatcherProvider,
    logWatcherModel,
    fixProvider,
    fixModel,
    analysisCooldownMs,
    maxAnalysisPromptChars,
    maxSessionsPerAnalysisBatch,
    rateLimitCooldownMs,
    maxRateLimitBackoffMs,
    maxConcurrentFixSessions,
    assessmentCategories: categories.length > 0 ? categories : [...ALL_FINDING_CATEGORIES],
  };
}

function createAnalysisBatches(
  entries: AnalysisSummaryEntry[],
  maxPromptChars: number,
  maxSessionsPerBatch: number,
): AnalysisSummaryEntry[][] {
  const safeMaxPromptChars = Math.max(20_000, maxPromptChars);
  const safeMaxSessionsPerBatch = Math.max(1, maxSessionsPerBatch);
  const batches: AnalysisSummaryEntry[][] = [];
  let currentBatch: AnalysisSummaryEntry[] = [];
  let currentPromptChars = 0;

  for (const entry of entries) {
    const shouldStartNewBatch = currentBatch.length > 0 && (
      currentBatch.length >= safeMaxSessionsPerBatch
      || currentPromptChars + entry.estimatedPromptChars > safeMaxPromptChars
    );

    if (shouldStartNewBatch) {
      batches.push(currentBatch);
      currentBatch = [];
      currentPromptChars = 0;
    }

    currentBatch.push(entry);
    currentPromptChars += entry.estimatedPromptChars;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function estimateSummaryPromptChars(summary: SessionSummary): number {
  // Include fixed framing overhead and separators added by buildAnalysisPrompt.
  const PER_SUMMARY_OVERHEAD_CHARS = 12;
  return formatSummaryForLlm(summary).length + PER_SUMMARY_OVERHEAD_CHARS;
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const maybeFailure = error as { failureType?: unknown; message?: unknown };
  if (maybeFailure.failureType === 'rate_limit') {
    return true;
  }

  if (typeof maybeFailure.message !== 'string') {
    return false;
  }

  return /(rate\s*limit|quota exceeded|too many requests|\b429\b)/i.test(maybeFailure.message);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function sanitizeNonEmptyString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function isValidFindingContract(finding: FindingContractInput): boolean {
  if (!isSingleSentence(finding.issueSummary)) {
    return false;
  }
  if (finding.evidence.length < 2 || finding.evidence.length > 3) {
    return false;
  }
  if (containsRecommendationLanguage([
    finding.issueSummary,
    ...finding.evidence,
    finding.severityRationale ?? '',
  ].join(' '))) {
    return false;
  }
  if ((finding.severity === 'high' || finding.severity === 'critical') && !finding.severityRationale) {
    return false;
  }
  return true;
}

function isSingleSentence(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  const sentenceEndings = (normalized.match(/[.!?](?:\s|$)/g) ?? []).length;
  return sentenceEndings <= 1;
}

function containsRecommendationLanguage(text: string): boolean {
  return /(should\s+|recommend|fix\s+by|to\s+fix|implement\s+|change\s+the\s+code|add\s+this|remove\s+this|update\s+to)/i.test(text);
}

/**
 * Return true if the given text contains a GitHub pull-request URL.
 * Used to detect that a fix session actually opened a PR.
 */
function hasPrUrl(text: string): boolean {
  return /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i.test(text);
}

function mapLogWatcherCategory(category: LogFindingCategory): FindingCategory {
  switch (category) {
    case 'performance':
      return 'performance';
    case 'error-pattern':
    case 'configuration':
      return 'code-quality';
    case 'reliability':
    case 'security':
      return 'architecture';
    default:
      return 'code-quality';
  }
}
