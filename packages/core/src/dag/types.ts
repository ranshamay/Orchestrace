/** Task status through the execution lifecycle. */
export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'planning'
  | 'awaiting_approval'
  | 'running'
  | 'implementing'
  | 'testing'
  | 'validating'
  | 'completed'
  | 'failed'
  | 'retrying';

/** The kind of work a task performs. */
export type TaskType = 'code' | 'review' | 'test' | 'plan' | 'refactor' | 'custom';

export type ReplayFailureType =
  | 'timeout'
  | 'auth'
  | 'rate_limit'
  | 'tool_schema'
  | 'tool_runtime'
  | 'validation'
  | 'empty_response'
  | 'unknown';

/** Per-task model override. */
export interface ModelConfig {
  provider: string;
  model: string;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
}

/** Validation strategy for a task's output. */
export interface ValidationConfig {
  /** Shell commands to run (e.g. `["pnpm tsc --noEmit", "pnpm vitest run"]`). */
  commands?: string[];
  /** Custom async validator function. Return `true` to pass. */
  custom?: (output: TaskOutput) => Promise<boolean>;
  /** Max retries before marking failed. Default 0 (no retry). */
  maxRetries?: number;
  /** Delay between retries in ms. Default 1000. */
  retryDelayMs?: number;
}

/** Tester gate strategy for a task's output. */
export interface TesterConfig {
  /** Enable tester gate for this task. */
  enabled: boolean;
  /** Override tester model for this task. */
  model?: ModelConfig;
  /** Require at least one test command execution. Defaults to true. */
  requireRunTests?: boolean;
  /** Enforce UI test execution when changed files include UI paths. Defaults to true. */
  enforceUiTestsForUiChanges?: boolean;
  /** Require screenshot evidence when UI tests are required. Defaults to true. */
  requireUiScreenshotsForUiChanges?: boolean;
  /** Minimum screenshots required for UI changes when screenshot evidence is enabled. Defaults to 2. */
  minUiScreenshotCount?: number;
  /** Glob-style patterns used to classify changed files as UI changes. */
  uiChangePatterns?: string[];
  /** Case-insensitive substrings used to detect UI test command execution. */
  uiTestCommandPatterns?: string[];
}

/** A single node in the task graph. */
export interface TaskNode {
  id: string;
  name: string;
  type: TaskType;
  /** The prompt sent to the LLM agent. */
  prompt: string;
  /** IDs of tasks that must complete before this one starts. */
  dependencies: string[];
  /** Override the default model for this specific task. */
  model?: ModelConfig;
  /** Validation/retry configuration. */
  validation?: ValidationConfig;
  /** Optional tester gate configuration. */
  tester?: TesterConfig;
  /** Arbitrary metadata. */
  meta?: Record<string, unknown>;
}

export interface ReplayToolCallRecord {
  time: string;
  toolCallId: string;
  toolName: string;
  status: 'started' | 'result';
  input?: string;
  output?: string;
  isError?: boolean;
  details?: unknown;
}


export interface ReplayValidationCommandRecord {
  command: string;
  passed: boolean;
  output: string;
  durationMs: number;
}

export interface ReplayValidationRecord {
  passed: boolean;
  commandResults: ReplayValidationCommandRecord[];
}

export interface ReplayAttemptRecord {
  phase: 'planning' | 'implementation';
  attempt: number;
  startedAt: string;
  completedAt: string;
  provider: string;
  model: string;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
  stopReason?: string;
  endpoint?: string;
  usage?: { input: number; output: number; cost: number };
  textPreview?: string;
  error?: string;
  failureType?: ReplayFailureType;
  toolCalls: ReplayToolCallRecord[];
  validation?: ReplayValidationRecord;
}

export interface TaskReplayRecord {
  version: 1;
  graphId: string;
  taskId: string;
  promptVersion: string;
  policyVersion: string;
  provider: string;
  model: string;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
  executionMode?: 'planned' | 'direct';
  attempts: ReplayAttemptRecord[];
}

export interface TesterVerdict {
  approved: boolean;
  /** Concrete test plan executed for this change. */
  testPlan: string[];
  /** Areas actually validated by this tester pass (e.g. unit/api/ui). */
  testedAreas: string[];
  /** Concrete commands executed by tester as part of validation. */
  executedTestCommands: string[];
  testsPassed: number;
  testsFailed: number;
  /** Tester summary of coverage impact for this change set. */
  coverageAssessment?: string;
  /** Tester summary of quality/regression risk for this change set. */
  qualityAssessment?: string;
  /** Whether implementer output included UI changes. */
  uiChangesDetected: boolean;
  /** Whether UI tests were required by policy for this verdict. */
  uiTestsRequired: boolean;
  /** Whether UI tests were executed for this verdict. */
  uiTestsRun: boolean;
  /** Screenshot evidence paths collected for UI validation. */
  screenshotPaths: string[];
  /** Collapsed command output evidence from tester-run validations. */
  testOutput: string;
  rejectionReason?: string;
  suggestedFixes?: string[];
}

/** Result produced by a completed task. */
export interface TaskOutput {
  taskId: string;
  status: 'completed' | 'failed';
  /** Generated deep plan for this task. */
  plan?: string;
  /** File path where the generated plan was persisted. */
  planPath?: string;
  /** Directory containing per-agent token dump files for this task. */
  tokenDumpDir?: string;
  /** LLM response text. */
  response?: string;
  /** Files created or modified. */
  filesChanged?: string[];
  /** Validation results. */
  validationResults?: ValidationResult[];
  /** Tester gate verdict when tester phase is enabled. */
  testerVerdict?: TesterVerdict;
  /** Time taken in ms. */
  durationMs: number;
  /** Token usage from the LLM call. */
  usage?: { input: number; output: number; cost: number };
  /** Structured replay metadata for deterministic diagnostics. */
  replay?: TaskReplayRecord;
  /** Optional failure bucket for failed outputs. */
  failureType?: ReplayFailureType;
  /** Error message if failed. */
  error?: string;
  /** Number of retry attempts. */
  retries: number;
}

export interface ValidationResult {
  command: string;
  passed: boolean;
  output: string;
  durationMs: number;
}

/** The full task graph definition. */
export interface TaskGraph {
  id: string;
  name: string;
  nodes: TaskNode[];
}

/** Runtime state for a single task during execution. */
export interface TaskState {
  node: TaskNode;
  status: TaskStatus;
  output?: TaskOutput;
  retryCount: number;
  startedAt?: number;
}

/** Events emitted by the DAG runner. */
export type DagEvent =
  | { type: 'task:planning'; taskId: string }
  | {
      type: 'task:llm-context';
      taskId: string;
      phase: 'planning' | 'implementation';
      attempt: number;
      snapshotId: string;
      provider: string;
      model: string;
      systemPrompt: string;
      prompt: string;
    }
  | { type: 'task:stream-delta'; taskId: string; phase: 'planning' | 'implementation'; attempt: number; delta: string; isReasoning?: boolean }
  | {
      type: 'task:replay-attempt';
      taskId: string;
      phase: 'planning' | 'implementation';
      attempt: number;
      record: ReplayAttemptRecord;
    }
  | {
      type: 'task:tool-call';
      taskId: string;
      phase: 'planning' | 'implementation';
      attempt: number;
      toolCallId: string;
      toolName: string;
      status: 'started' | 'result';
      input?: string;
            output?: string;
      isError?: boolean;
      details?: unknown;
    }

  | { type: 'task:plan-persisted'; taskId: string; path: string }
  | { type: 'task:approval-requested'; taskId: string; path: string }
  | { type: 'task:approved'; taskId: string }
  | { type: 'task:implementation-attempt'; taskId: string; attempt: number; maxAttempts: number }
  | {
      type: 'task:testing';
      taskId: string;
      attempt: number;
      uiChangesDetected?: boolean;
      uiTestsRequired?: boolean;
      screenshotsRequired?: boolean;
    }
  | {
      type: 'task:tester-verdict';
      taskId: string;
      attempt: number;
      approved: boolean;
      testsPassed: number;
      testsFailed: number;
      rejectionReason?: string;
      testPlan?: string[];
      coverageAssessment?: string;
      qualityAssessment?: string;
      testedAreas?: string[];
      executedTestCommands?: string[];
      uiChangesDetected?: boolean;
      uiTestsRequired?: boolean;
      uiTestsRun?: boolean;
      screenshotPaths?: string[];
    }
  | { type: 'task:verification-failed'; taskId: string; attempt: number; error: string }
  | { type: 'task:ready'; taskId: string }
  | { type: 'task:started'; taskId: string }
  | { type: 'task:validating'; taskId: string }
  | { type: 'task:completed'; taskId: string; output: TaskOutput }
  | {
      type: 'task:failed';
      taskId: string;
      error: string;
      retries: number;
      attempt: number;
      maxRetries: number;
      totalDurationMs: number;
      failureType?: ReplayFailureType;
    }
  | { type: 'task:retrying'; taskId: string; attempt: number; maxRetries: number }
  | { type: 'graph:completed'; outputs: Map<string, TaskOutput> }
  | { type: 'graph:failed'; error: string; completedTasks: string[]; failedTasks: string[] };

/** Configuration for the DAG runner. */
export interface RunnerConfig {
  /** Max tasks executing in parallel. Default 4. */
  maxParallel?: number;
  /** Default model when task doesn't specify one. */
  defaultModel?: ModelConfig;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Event handler. */
  onEvent?: (event: DagEvent) => void;
}
