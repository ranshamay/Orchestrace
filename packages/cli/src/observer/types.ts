// ---------------------------------------------------------------------------
// Observer Agent — type definitions
// ---------------------------------------------------------------------------

import type { ObserverFindingCategory, ObserverFindingSeverity } from '@orchestrace/store';

/** Categories of issues the observer can identify. */
export type FindingCategory = ObserverFindingCategory;


export const ALL_FINDING_CATEGORIES: FindingCategory[] = [
  'code-quality',
  'performance',
  'agent-efficiency',
  'architecture',
  'test-coverage',
];

export type FindingSeverity = ObserverFindingSeverity;
export type FindingSchemaVersion = '1' | '2';

/** Canonical v2 evidence entry describing concrete remediation/context. */
export interface FindingEvidence {
  text: string;
}

/** Shared finding body fields. */
interface ObserverFindingBase {
  category: FindingCategory;
  severity: FindingSeverity;
  /** One-line title of the finding. */
  title: string;
  /** Detailed description of the issue. */
  description: string;
  /** Concise task-ready summary of the implementation work needed. */
  issueSummary?: string;
  /** File paths relevant to this finding (if any). */
  relevantFiles?: string[];
}

/** Legacy finding payload shape (v1). */
export interface ObserverFindingV1 extends ObserverFindingBase {
  schemaVersion: '1';
  /** Legacy concrete fix suggestion. */
  suggestedFix: string;
}

/** Canonical finding payload shape (v2). */
export interface ObserverFindingV2 extends ObserverFindingBase {
  schemaVersion: '2';
  /** Canonical evidence list used by parser/store and consumers. */
  evidence: FindingEvidence[];
}

/**
 * Incoming finding payload accepted during migration.
 * Allows legacy `suggestedFix` and new `evidence[]` shapes.
 */
export type ObserverFindingInput =
  | (ObserverFindingBase & {
      schemaVersion?: '1';
      suggestedFix: string;
      evidence?: FindingEvidence[];
    })
  | (ObserverFindingBase & {
      schemaVersion?: '2';
      evidence: FindingEvidence[];
      suggestedFix?: string;
    });

/** A single observation/issue found by the observer LLM. */
export type ObserverFinding = (ObserverFindingV1 | ObserverFindingV2) & {
  /** Deterministic fingerprint for deduplication (hash of category + normalized description). */
  fingerprint: string;
  /** Session IDs where this issue was observed. */
  observedInSessions: string[];
  /** When the finding was first detected. */
  detectedAt: string;
};

/** Canonical normalized finding payload used internally/persisted records. */
export type NormalizedObserverFinding = Omit<ObserverFinding, 'schemaVersion' | 'suggestedFix'> & {
  schemaVersion: '2';
  evidence: FindingEvidence[];
};

/** Persistent state of a registered finding (stored in findings.json). */
export interface FindingRecord extends NormalizedObserverFinding {
  /** The session ID spawned to fix this finding, or null if not yet spawned. */
  fixSessionId: string | null;
  /** Status of the fix attempt. */
  fixStatus: 'pending' | 'spawned' | 'completed' | 'failed';
  /** Additional session IDs that matched this fingerprint after the first detection. */
  additionalSessions: string[];
}

const LEGACY_FALLBACK_EVIDENCE_TEXT = 'No suggested fix provided in legacy finding payload.';

export function normalizeFindingEvidence(
  evidence: FindingEvidence[] | undefined,
  suggestedFix: string | undefined,
): FindingEvidence[] {
  const sanitizedEvidence = (evidence ?? [])
    .filter((entry): entry is FindingEvidence => !!entry && typeof entry.text === 'string')
    .map((entry) => ({ text: entry.text.trim() }))
    .filter((entry) => entry.text.length > 0);

  if (sanitizedEvidence.length > 0) {
    return sanitizedEvidence;
  }

  if (typeof suggestedFix === 'string' && suggestedFix.trim().length > 0) {
    return [{ text: suggestedFix.trim() }];
  }

  return [{ text: LEGACY_FALLBACK_EVIDENCE_TEXT }];
}

export function normalizeObserverFindingInput(
  finding: ObserverFindingInput,
): Omit<NormalizedObserverFinding, 'fingerprint' | 'observedInSessions' | 'detectedAt'> {
  return {
    schemaVersion: '2',
    category: finding.category,
    severity: finding.severity,
    title: finding.title,
    description: finding.description,
    relevantFiles: finding.relevantFiles,
    evidence: normalizeFindingEvidence(finding.evidence, finding.suggestedFix),
  };
}

/** Build consumer-facing task text from normalized evidence entries. */
export function findingTaskTextFromEvidence(evidence: FindingEvidence[]): string {
  const lines = evidence
    .map((entry) => entry.text.trim())
    .filter((text) => text.length > 0);

  if (lines.length === 0) {
    return LEGACY_FALLBACK_EVIDENCE_TEXT;
  }

  if (lines.length === 1) {
    return lines[0];
  }

  return lines.map((line, idx) => `${idx + 1}. ${line}`).join('\n');
}

/** Observer daemon configuration (persisted in .orchestrace/observer/config.json). */
export interface ObserverConfig {
  /** Whether the observer daemon is enabled. */
  enabled: boolean;
  /** Provider to use for the observer's own LLM analysis calls. */
  provider: string;
  /** Model to use for the observer's own LLM analysis calls. */
  model: string;
  /** Provider to use for backend log watcher analysis calls. */
  logWatcherProvider: string;
  /** Model to use for backend log watcher analysis calls. */
  logWatcherModel: string;
  /** Provider to use when spawning fix sessions. */
  fixProvider: string;
  /** Model to use when spawning fix sessions. */
  fixModel: string;
  /** Whether fix sessions require auto-approve (default true for full autonomy). */
  fixAutoApprove: boolean;
  /** Minimum interval (ms) between analysis cycles. */
  analysisCooldownMs: number;
  /** Max prompt size (chars) per observer analysis request. */
  maxAnalysisPromptChars: number;
  /** Max number of session summaries to include in one analysis request. */
  maxSessionsPerAnalysisBatch: number;
  /** Base cooldown applied after an observer analysis rate-limit failure. */
  rateLimitCooldownMs: number;
  /** Upper cap for exponential rate-limit cooldown backoff. */
  maxRateLimitBackoffMs: number;
  /** Which finding categories should be assessed by the observer. */
  assessmentCategories: FindingCategory[];
  /** Session IDs to exclude from observation. */
  excludeSessionIds: string[];
  /** Only observe sessions in these workspaces (empty = all). */
  workspaceFilter: string[];
  /** Maximum number of observer-spawned fix sessions that may run concurrently (0 = unlimited). */
  maxConcurrentFixSessions: number;
}

export const DEFAULT_OBSERVER_CONFIG: ObserverConfig = {
  enabled: false,
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  logWatcherProvider: 'anthropic',
  logWatcherModel: 'claude-sonnet-4-20250514',
  fixProvider: 'anthropic',
  fixModel: 'claude-sonnet-4-20250514',
  fixAutoApprove: true,
  analysisCooldownMs: 60_000,
  maxAnalysisPromptChars: 180_000,
  maxSessionsPerAnalysisBatch: 3,
  rateLimitCooldownMs: 120_000,
  maxRateLimitBackoffMs: 900_000,
  assessmentCategories: [...ALL_FINDING_CATEGORIES],
  excludeSessionIds: [],
  workspaceFilter: [],
  maxConcurrentFixSessions: 3,
};

/** Internal state of the observer daemon (not persisted). */
export interface ObserverDaemonState {
  /** Whether the daemon loop is currently running. */
  running: boolean;
  /** Timestamp of the last completed analysis cycle. */
  lastAnalysisAt: string | null;
  /** Session IDs already analyzed (to avoid re-processing). */
  analyzedSessions: Set<string>;
  /** Session IDs of observer-spawned fix sessions (to skip observing them). */
  observerSessionIds: Set<string>;
}

/** Structured output from the LLM analysis of a session's event log. */
export interface AnalysisResult {
  findings: ObserverFindingInput[];
}
