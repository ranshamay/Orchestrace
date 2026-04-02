/** Task status through the execution lifecycle. */
export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'planning'
  | 'awaiting_approval'
  | 'running'
  | 'implementing'
  | 'validating'
  | 'completed'
  | 'failed'
  | 'retrying';

/** The kind of work a task performs. */
export type TaskType = 'code' | 'review' | 'test' | 'plan' | 'refactor' | 'custom';

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
  /** If true, spawn in an isolated sub-agent (separate worktree). */
  isolated?: boolean;
  /** Arbitrary metadata. */
  meta?: Record<string, unknown>;
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
  /** Time taken in ms. */
  durationMs: number;
  /** Token usage from the LLM call. */
  usage?: { input: number; output: number; cost: number };
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
  | { type: 'task:stream-delta'; taskId: string; phase: 'planning' | 'implementation'; attempt: number; delta: string }
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
    }
  | { type: 'task:plan-persisted'; taskId: string; path: string }
  | { type: 'task:approval-requested'; taskId: string; path: string }
  | { type: 'task:approved'; taskId: string }
  | { type: 'task:implementation-attempt'; taskId: string; attempt: number; maxAttempts: number }
  | { type: 'task:verification-failed'; taskId: string; attempt: number; error: string }
  | { type: 'task:ready'; taskId: string }
  | { type: 'task:started'; taskId: string }
  | { type: 'task:validating'; taskId: string }
  | { type: 'task:completed'; taskId: string; output: TaskOutput }
  | { type: 'task:failed'; taskId: string; error: string; retries: number }
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
