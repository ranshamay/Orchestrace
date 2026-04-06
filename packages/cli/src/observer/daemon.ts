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
  type ObserverConfig,
  type ObserverDaemonState,
} from './types.js';
import { FindingRegistry } from './registry.js';
import { summarizeSession } from './summarizer.js';
import { analyzeSessionSummaries } from './analyzer.js';
import { spawnFixSessions, type StartSessionFn } from './spawner.js';

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
    await this.registry.load();

    // Seed observer session IDs from registry so we skip them
    for (const finding of this.registry.getAll()) {
      if (finding.fixSessionId) {
        this.state.observerSessionIds.add(finding.fixSessionId);
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
    analyzedCount: number;
    pendingFindings: number;
    totalFindings: number;
  } {
    return {
      running: this.state.running,
      lastAnalysisAt: this.state.lastAnalysisAt,
      analyzedCount: this.state.analyzedSessions.size,
      pendingFindings: this.registry.getPending().length,
      totalFindings: this.registry.getAll().length,
    };
  }

  /** Get all findings (for API). */
  getFindings() {
    return this.registry.getAll();
  }

  /** Check if a session was created by the observer. */
  isObserverSession(sessionId: string): boolean {
    return this.state.observerSessionIds.has(sessionId) || this.registry.isObserverSession(sessionId);
  }

  /** Manually trigger an analysis cycle (for API/testing). */
  async triggerAnalysis(): Promise<{ analyzed: number; findings: number; spawned: number }> {
    return this.runAnalysisCycle();
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
      return { analyzed: 0, findings: 0, spawned: 0 };
    }

    // Summarize sessions
    const summaries = [];
    for (const sid of toAnalyze) {
      const summary = await summarizeSession(this.eventStore, sid);
      if (summary) summaries.push(summary);
      this.state.analyzedSessions.add(sid);
    }

    if (summaries.length === 0) {
      return { analyzed: toAnalyze.length, findings: 0, spawned: 0 };
    }

    // Analyze via LLM
    const analysisResult = await analyzeSessionSummaries(
      this.llm,
      this.config,
      summaries,
      this.controller.signal,
      this.resolveApiKey,
    );

    // Register findings with dedup
    let newFindings = 0;
    const sessionIds = summaries.map((s) => s.sessionId);
    for (const finding of analysisResult.findings) {
      const { isNew } = this.registry.register(finding, sessionIds);
      if (isNew) newFindings++;
    }

    // Spawn fix sessions for pending findings, respecting concurrency limit.
    // Count in-flight sessions: spawned findings whose session is still tracked as active.
    const activeFixSessionCount = this.registry.getAll().filter(
      (f) => f.fixStatus === 'spawned' && f.fixSessionId && this.state.observerSessionIds.has(f.fixSessionId),
    ).length;
    const spawned = await spawnFixSessions(this.registry, this.config, this.startSession, activeFixSessionCount);

    // Track spawned session IDs
    for (const finding of this.registry.getAll()) {
      if (finding.fixSessionId) {
        this.state.observerSessionIds.add(finding.fixSessionId);
      }
    }

    await this.registry.save();
    this.state.lastAnalysisAt = new Date().toISOString();

    console.log(
      `[orchestrace][observer] Cycle complete: analyzed=${toAnalyze.length} findings=${newFindings} spawned=${spawned}`,
    );

    return { analyzed: toAnalyze.length, findings: newFindings, spawned };
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
}

function sanitizeObserverConfig(config: ObserverConfig): ObserverConfig {
  const categories = Array.isArray(config.assessmentCategories)
    ? config.assessmentCategories.filter((c): c is FindingCategory =>
      ALL_FINDING_CATEGORIES.includes(c as FindingCategory),
    )
    : [];

  return {
    ...config,
    assessmentCategories: categories.length > 0 ? categories : [...ALL_FINDING_CATEGORIES],
  };
}
