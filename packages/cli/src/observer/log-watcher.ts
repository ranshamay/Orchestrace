// ---------------------------------------------------------------------------
// Log Watcher — Observes Backend Logs for Issues & Improvements
// ---------------------------------------------------------------------------
// Tails the persistent backend log stream, accumulates recent entries, and
// periodically triggers LLM analysis to find errors, warnings, performance
// issues, and improvement opportunities in the running system.
// ---------------------------------------------------------------------------

import type { LlmAdapter } from '@orchestrace/provider';
import type { ObserverConfig, FindingCategory, FindingSeverity } from './types.js';
import { ALL_FINDING_CATEGORIES } from './types.js';
import type { BackendLogger } from './backend-logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogWatcherStatus = 'idle' | 'watching' | 'analyzing' | 'stopped';

export interface LogFinding {
  id: string;
  category: LogFindingCategory;
  severity: FindingSeverity;
  title: string;
    description: string;
  issueSummary: string;
  evidence: string;
  relevantFiles?: string[];
  logSnippet: string;

  detectedAt: string;
}

export type LogFindingCategory =
  | 'error-pattern'
  | 'performance'
  | 'configuration'
  | 'reliability'
  | 'security';

export const ALL_LOG_FINDING_CATEGORIES: LogFindingCategory[] = [
  'error-pattern',
  'performance',
  'configuration',
  'reliability',
  'security',
];

export interface LogWatcherState {
  status: LogWatcherStatus;
  findings: LogFinding[];
  analyzedBatches: number;
  lastAnalyzedAt: string | null;
  linesProcessed: number;
}

export interface LogWatcherOptions {
  llm: LlmAdapter;
  config: ObserverConfig;
  logger: BackendLogger;
  resolveApiKey: (provider: string) => Promise<string | undefined>;
  /** Called when status or findings change. */
  onStateChange?: (state: LogWatcherState) => void;
  /** Called only with findings newly detected in the latest analysis batch. */
  onFindings?: (findings: LogFinding[]) => void | Promise<void>;
  /** Maximum lines to accumulate before triggering analysis (default 200). */
  batchSize?: number;
  /** Time window (ms) — trigger analysis after this interval even if batch isn't full (default 120s). */
  timeWindowMs?: number;
}

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

const LOG_WATCHER_SYSTEM_PROMPT = `You are a backend log analysis agent for the Orchestrace system — an AI-powered coding orchestration platform.
You receive batches of backend log lines from the running system and your job is to identify issues, patterns, and improvements.

The logs contain:
- **ui-server logs**: HTTP requests, SSE connections, session lifecycle, API calls
- **runner process logs**: Child process output from AI coding agents (tool calls, LLM interactions, file operations)
- **observer logs**: Observer daemon and per-session observer activity
- **auth logs**: Provider authentication, OAuth flows, API key resolution
- **event store logs**: Session event persistence, file I/O

You look for these categories:

1. **Error Patterns** — recurring errors, unhandled exceptions, failed operations, error cascades
2. **Performance** — slow operations, high-frequency redundant calls, memory concerns, bottlenecks
3. **Configuration** — misconfigurations, missing env vars, auth issues, incorrect settings
4. **Reliability** — race conditions, timeout patterns, retry storms, connection instability
5. **Security** — credential exposure, unsafe operations, missing validation

Guidelines:
- Only report CONCRETE, ACTIONABLE issues backed by evidence from the logs
- Include the relevant log snippet (1-3 key lines) in each finding
- Each finding must include "issueSummary" (what to change) and "evidence" (why this is a real issue)


- Don't flag normal operational logs (startup messages, successful operations)
- Focus on patterns — a single transient error is less important than a recurring one
- Rate severity honestly: critical = data loss/security, high = breaking errors, medium = perf/reliability, low = minor improvements
- If no significant issues are found in the batch, return an empty findings array

Respond ONLY with valid JSON matching this schema:
\`\`\`json
{
  "findings": [
    {
      "category": "error-pattern|performance|configuration|reliability|security",
      "severity": "low|medium|high|critical",
      "title": "Short one-line title",
            "description": "Detailed description of the issue with context from the logs",
      "issueSummary": "Concrete change to make (code/config/action)",
      "evidence": "Key log-based evidence backing this issue",
      "relevantFiles": ["path/to/file.ts"],
      "logSnippet": "The 1-3 key log lines that evidence this issue"

    }
  ]
}
\`\`\``;

// ---------------------------------------------------------------------------
// LogWatcher
// ---------------------------------------------------------------------------

export class LogWatcher {
  private readonly llm: LlmAdapter;
  private config: ObserverConfig;
  private readonly resolveApiKey: (provider: string) => Promise<string | undefined>;
  private readonly onStateChange?: (state: LogWatcherState) => void;
  private readonly onFindings?: (findings: LogFinding[]) => void | Promise<void>;
  private readonly batchSize: number;
  private readonly timeWindowMs: number;

  private state: LogWatcherState = {
    status: 'idle',
    findings: [],
    analyzedBatches: 0,
    lastAnalyzedAt: null,
    linesProcessed: 0,
  };

  private buffer: string[] = [];
  private unsubscribe: (() => void) | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController = new AbortController();
  private analyzing = false;

  constructor(options: LogWatcherOptions) {
    this.llm = options.llm;
    this.config = { ...options.config };
    this.resolveApiKey = options.resolveApiKey;
    this.onStateChange = options.onStateChange;
    this.onFindings = options.onFindings;
    this.batchSize = options.batchSize ?? 200;
    this.timeWindowMs = options.timeWindowMs ?? 120_000;
  }

  /** Update runtime config snapshot (called when observer config changes). */
  updateConfig(config: ObserverConfig): void {
    this.config = { ...config };
  }

  /** Start watching log lines from the backend logger. */
  start(logger: BackendLogger): void {
    if (this.unsubscribe) return;
    this.state.status = 'watching';
    this.emitChange();

    this.unsubscribe = logger.onLine((line) => {
      this.buffer.push(line);
      this.state.linesProcessed++;

      if (this.buffer.length >= this.batchSize && !this.analyzing) {
        void this.flushAndAnalyze();
      }
    });

    // Time-based flush
    this.scheduleFlush();
  }

  /** Stop watching and clean up. */
  stop(): void {
    this.abortController.abort();
    this.abortController = new AbortController();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.state.status = 'stopped';
    this.emitChange();
  }

  /** Get current state. */
  getState(): Readonly<LogWatcherState> {
    return this.state;
  }

  /** Get all findings. */
  getFindings(): ReadonlyArray<LogFinding> {
    return this.state.findings;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      if (this.buffer.length > 0 && !this.analyzing) {
        void this.flushAndAnalyze();
      }
      this.scheduleFlush();
    }, this.timeWindowMs);
  }

  private async flushAndAnalyze(): Promise<void> {
    if (this.analyzing || this.buffer.length === 0) return;
    this.analyzing = true;

    // Take current buffer
    const batch = this.buffer.splice(0, this.batchSize);

    this.state.status = 'analyzing';
    this.emitChange();

    try {
      const prompt = this.buildAnalysisPrompt(batch);
      const provider = pickModelSetting(this.config.logWatcherProvider, this.config.provider);
      const model = pickModelSetting(this.config.logWatcherModel, this.config.model);
      const apiKey = await this.resolveApiKey(provider);

      const result = await this.llm.complete({
        provider,
        model,
        systemPrompt: LOG_WATCHER_SYSTEM_PROMPT,
        prompt,
        signal: this.abortController.signal,
                apiKey,
        refreshApiKey: () => this.resolveApiKey(provider),
        allowAuthRefreshRetry: true,


      });

      const findings = parseLogFindings(result.text);
      const newlyDetected: LogFinding[] = [];

      for (const finding of findings) {
        // Deduplicate by title
        if (this.state.findings.some((f) => f.title === finding.title)) continue;
        this.state.findings.push(finding);
        newlyDetected.push(finding);
      }

      if (newlyDetected.length > 0 && this.onFindings) {
        void Promise.resolve(this.onFindings(newlyDetected)).catch((err) => {
          process.stderr.write(
            `[orchestrace][log-watcher] Finding callback error: ${(err as Error).message}\n`,
          );
        });
      }

      this.state.analyzedBatches++;
      this.state.lastAnalyzedAt = new Date().toISOString();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        // Use original console to avoid recursion
        process.stderr.write(`[orchestrace][log-watcher] Analysis error: ${(err as Error).message}\n`);
      }
    } finally {
      this.analyzing = false;
      if ((this.state.status as string) !== 'stopped') {
        this.state.status = 'watching';
      }
      this.emitChange();
    }
  }

  private buildAnalysisPrompt(batch: string[]): string {
    const lines: string[] = [];
    lines.push(`# Backend Log Batch (${batch.length} lines)\n`);
    lines.push('Analyze the following backend log lines for issues and improvements:\n');
    lines.push('```');
    lines.push(...batch.map((l) => l.trimEnd()));
    lines.push('```\n');

    if (this.state.findings.length > 0) {
      lines.push('## Previously Reported Findings (do NOT repeat these)\n');
      for (const f of this.state.findings) {
        lines.push(`- [${f.severity}] ${f.title}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private emitChange(): void {
    this.onStateChange?.(this.state);
  }
}

// ---------------------------------------------------------------------------
// Response Parser
// ---------------------------------------------------------------------------

function parseLogFindings(text: string): LogFinding[] {
  try {
    // Strip markdown fences if present
    const cleaned = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '');
    const parsed = JSON.parse(cleaned);
    const raw = Array.isArray(parsed) ? parsed : parsed?.findings;
    if (!Array.isArray(raw)) return [];

    return raw
            .filter(
        (f: Record<string, unknown>) =>
          f &&
          typeof f.title === 'string' &&
          typeof f.description === 'string' &&
          typeof f.issueSummary === 'string' &&
          typeof f.evidence === 'string',
      )

      .map((f: Record<string, unknown>) => ({
        id: `logf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        category: validateLogCategory(f.category as string),
        severity: validateSeverity(f.severity as string),
                title: String(f.title),
        description: String(f.description),
        issueSummary: String(f.issueSummary ?? ''),
        evidence: String(f.evidence ?? ''),
        relevantFiles: Array.isArray(f.relevantFiles)

          ? f.relevantFiles.filter((x: unknown) => typeof x === 'string')
          : undefined,
        logSnippet: String(f.logSnippet ?? ''),
        detectedAt: new Date().toISOString(),
      }));
  } catch {
    return [];
  }
}

function validateLogCategory(cat: string): LogFindingCategory {
  const valid: LogFindingCategory[] = ['error-pattern', 'performance', 'configuration', 'reliability', 'security'];
  return valid.includes(cat as LogFindingCategory) ? (cat as LogFindingCategory) : 'error-pattern';
}

function validateSeverity(sev: string): FindingSeverity {
  const valid: FindingSeverity[] = ['low', 'medium', 'high', 'critical'];
  return valid.includes(sev as FindingSeverity) ? (sev as FindingSeverity) : 'medium';
}

function pickModelSetting(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}
