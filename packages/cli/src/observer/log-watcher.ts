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
  schemaVersion?: '1' | '2';
  suggestedFix?: string;
  evidence?: Array<{ text: string }>;
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

const LOG_LOOP_MIN_TOOL_CALLS = 12;
const LOG_LOOP_MIN_RATIO = 0.9;


export type LogWatcherRuntimeError = {
  source: 'log-watcher';
  operation: 'analyze-batch' | 'emit-findings';
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
};

export interface LogWatcherOptions {
  llm: LlmAdapter;
  config: ObserverConfig;
  logger: BackendLogger;
  resolveApiKey: (provider: string) => Promise<string | undefined>;
  /** Called when status or findings change. */
  onStateChange?: (state: LogWatcherState) => void;
  /** Called only with findings newly detected in the latest analysis batch. */
  onFindings?: (findings: LogFinding[]) => void | Promise<void>;
  /** Called when analysis/runtime errors occur in watcher execution. */
  onError?: (error: LogWatcherRuntimeError) => void | Promise<void>;
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
- Each evidence entry must be a specific code change or configuration adjustment

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
      "evidence": [{ "text": "Concrete fix — specific code change, config adjustment, or action to take" }],
      "relevantFiles": ["path/to/file.ts"],
      "logSnippet": "The 1-3 key log lines that evidence this issue"

    }
  ]
}
\`\`\`
Compatibility: legacy outputs with \`suggestedFix\` string are also accepted during rollout.`;

// ---------------------------------------------------------------------------
// LogWatcher
// ---------------------------------------------------------------------------

export class LogWatcher {
  private readonly llm: LlmAdapter;
  private config: ObserverConfig;
  private readonly resolveApiKey: (provider: string) => Promise<string | undefined>;
  private readonly onStateChange?: (state: LogWatcherState) => void;
    private readonly onFindings?: (findings: LogFinding[]) => void | Promise<void>;
  private readonly onError?: (error: LogWatcherRuntimeError) => void | Promise<void>;
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
    this.onError = options.onError;
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
      const context = {
        provider,
        model,
        batchSize: batch.length,
        bufferedLinesRemaining: this.buffer.length,
      };


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
      const loopFinding = detectImplementationDiscoveryLoopFromLogs(batch);
      if (loopFinding) {
        findings.unshift(loopFinding);
      }

      const newlyDetected: LogFinding[] = [];

      for (const finding of findings) {
        // Deduplicate by title
        if (this.state.findings.some((f) => f.title === finding.title)) continue;
        this.state.findings.push(finding);
        newlyDetected.push(finding);
      }


            if (newlyDetected.length > 0 && this.onFindings) {
        void Promise.resolve(this.onFindings(newlyDetected)).catch((err) => {
          this.emitError({
            source: 'log-watcher',
            operation: 'emit-findings',
            message: toErrorMessage(err),
            timestamp: new Date().toISOString(),
            context: {
              findingsCount: newlyDetected.length,
              ...context,
            },
          });
        });
      }


      this.state.analyzedBatches++;
      this.state.lastAnalyzedAt = new Date().toISOString();
        } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        this.emitError({
          source: 'log-watcher',
          operation: 'analyze-batch',
          message: toErrorMessage(err),
          timestamp: new Date().toISOString(),
          context: {
            batchSize: batch.length,
          },
        });
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

    private emitError(error: LogWatcherRuntimeError): void {
    if (this.onError) {
      void Promise.resolve(this.onError(error)).catch((handlerError) => {
        process.stderr.write(
          `[orchestrace][log-watcher] error handler failure: ${toErrorMessage(handlerError)}\n`,
        );
      });
      return;
    }

    process.stderr.write(`[orchestrace][log-watcher] ${error.operation} error: ${error.message}\n`);
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
      .filter((f: Record<string, unknown>) => isValidLogFindingCandidate(f))
      .map((f: Record<string, unknown>) => ({
        id: `logf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        category: f.category as LogFindingCategory,
        severity: f.severity as FindingSeverity,
        title: String(f.title).trim(),
        description: String(f.description).trim(),
        suggestedFix:
          typeof f.suggestedFix === 'string'
            ? f.suggestedFix.trim()
            : (typeof f.issueSummary === 'string' ? f.issueSummary.trim() : undefined),
        evidence: Array.isArray(f.evidence)
          ? f.evidence
              .filter(
                (x: unknown): x is { text: string } =>
                  !!x
                  && typeof x === 'object'
                  && typeof (x as Record<string, unknown>).text === 'string'
                  && (x as Record<string, unknown>).text!.toString().trim().length > 0,
              )
              .map((x: { text: string }) => ({ text: x.text.trim() }))
          : undefined,
        relevantFiles: Array.isArray(f.relevantFiles)
          ? f.relevantFiles.filter((x: unknown) => typeof x === 'string')
          : undefined,
        logSnippet: String(f.logSnippet).trim(),
        detectedAt: new Date().toISOString(),
      }));
  } catch {
    return [];
  }
}

function isValidLogFindingCandidate(f: Record<string, unknown>): boolean {
  const validCategories: LogFindingCategory[] = [
    'error-pattern',
    'performance',
    'configuration',
    'reliability',
    'security',
  ];
  const validSeverities: FindingSeverity[] = ['low', 'medium', 'high', 'critical'];

  const hasCore =
    typeof f.title === 'string'
    && f.title.trim().length > 0
    && typeof f.description === 'string'
    && f.description.trim().length > 0
    && typeof f.logSnippet === 'string'
    && f.logSnippet.trim().length > 0;

  if (!hasCore) return false;

  if (!validCategories.includes(f.category as LogFindingCategory)) {
    return false;
  }

  if (!validSeverities.includes(f.severity as FindingSeverity)) {
    return false;
  }

  const hasLegacy =
    (typeof f.suggestedFix === 'string' && f.suggestedFix.trim().length > 0)
    || (typeof f.issueSummary === 'string' && f.issueSummary.trim().length > 0);

  const hasEvidence =
    Array.isArray(f.evidence)
    && f.evidence.some((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const textValue = (entry as Record<string, unknown>).text;
      return typeof textValue === 'string' && textValue.trim().length > 0;
    });

  return hasLegacy || hasEvidence;
}

function detectImplementationDiscoveryLoopFromLogs(batch: string[]): LogFinding | null {
  const toolLines = batch.filter((line) => line.includes('Tool ') && line.includes(' input '));
  if (toolLines.length < LOG_LOOP_MIN_TOOL_CALLS) {
    return null;
  }

  const exploratory = toolLines.filter((line) => {
    const lower = line.toLowerCase();
    return (
      lower.includes('tool read_file')
      || lower.includes('tool read_files')
      || lower.includes('tool list_directory')
      || lower.includes('tool search_files')
    );
  });

  const writes = toolLines.filter((line) => {
    const lower = line.toLowerCase();
    return (
      lower.includes('tool write_file')
      || lower.includes('tool write_files')
      || lower.includes('tool edit_file')
      || lower.includes('tool edit_files')
    );
  });

  if (writes.length > 0) {
    return null;
  }

  const ratio = exploratory.length / toolLines.length;
  if (ratio < LOG_LOOP_MIN_RATIO) {
    return null;
  }

  return {
    id: `logf-gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    category: 'reliability',
    severity: 'critical',
    title: 'Implementation discovery loop with no code writes detected in logs',
    description:
      `Detected ${toolLines.length} tool-call inputs in the batch with ${exploratory.length} exploratory calls and zero write/edit calls. This indicates an execution loop that should be interrupted with immediate code changes.`,
    schemaVersion: '2',
    evidence: [
      {
        text: 'Interrupt exploratory loop immediately and enforce direct write/edit operations on targeted files before further discovery calls.',
      },
    ],
    relevantFiles: [
      'packages/cli/src/observer/prompts.ts',
      'packages/cli/src/observer/analyzer.ts',
      'packages/cli/src/observer/log-watcher.ts',
    ],
    logSnippet: toolLines.slice(0, 3).join('\n'),
    detectedAt: new Date().toISOString(),
  };
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }

  return String(err);
}


function pickModelSetting(value: unknown, fallback: string): string {

  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}
