// ---------------------------------------------------------------------------
// Observer Agent — type definitions
// ---------------------------------------------------------------------------

/** Categories of issues the observer can identify. */
export type FindingCategory =
  | 'code-quality'
  | 'performance'
  | 'agent-efficiency'
  | 'architecture'
  | 'test-coverage';

export const ALL_FINDING_CATEGORIES: FindingCategory[] = [
  'code-quality',
  'performance',
  'agent-efficiency',
  'architecture',
  'test-coverage',
];

export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical';

/** A single observation/issue found by the observer LLM. */
export interface ObserverFinding {
  /** Deterministic fingerprint for deduplication (hash of category + normalized description). */
  fingerprint: string;
  category: FindingCategory;
  severity: FindingSeverity;
  /** One-line title of the finding. */
  title: string;
  /** Detailed description of the issue. */
  description: string;
  /** Concrete fix suggestion the observer will use as a session prompt. */
  suggestedFix: string;
  /** File paths relevant to this finding (if any). */
  relevantFiles?: string[];
  /** Session IDs where this issue was observed. */
  observedInSessions: string[];
  /** When the finding was first detected. */
  detectedAt: string;
}

/** Persistent state of a registered finding (stored in findings.json). */
export interface FindingRecord extends ObserverFinding {
  /** The session ID spawned to fix this finding, or null if not yet spawned. */
  fixSessionId: string | null;
  /** Status of the fix attempt. */
  fixStatus: 'pending' | 'spawned' | 'completed' | 'failed';
  /** Additional session IDs that matched this fingerprint after the first detection. */
  additionalSessions: string[];
}

/** Observer daemon configuration (persisted in .orchestrace/observer/config.json). */
export interface ObserverConfig {
  /** Whether the observer daemon is enabled. */
  enabled: boolean;
  /** Provider to use for the observer's own LLM analysis calls. */
  provider: string;
  /** Model to use for the observer's own LLM analysis calls. */
  model: string;
  /** Provider to use when spawning fix sessions. */
  fixProvider: string;
  /** Model to use when spawning fix sessions. */
  fixModel: string;
  /** Whether fix sessions require auto-approve (default true for full autonomy). */
  fixAutoApprove: boolean;
  /** Minimum interval (ms) between analysis cycles. */
  analysisCooldownMs: number;
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
  fixProvider: 'anthropic',
  fixModel: 'claude-sonnet-4-20250514',
  fixAutoApprove: true,
  analysisCooldownMs: 60_000,
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
  findings: Array<{
    category: FindingCategory;
    severity: FindingSeverity;
    title: string;
    description: string;
    suggestedFix: string;
    relevantFiles?: string[];
  }>;
}
