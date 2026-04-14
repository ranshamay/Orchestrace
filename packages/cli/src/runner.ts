/**
 * Standalone session runner — executes orchestration in a detached child process.
 *
 * Usage: node --import tsx runner.ts <sessionId> <workspaceRoot>
 *
 * Reads session config from the event store (latest session:created event).
 * Writes all orchestration events to the event store.
 * Handles SIGTERM for graceful cancellation.
 * Writes heartbeat events every 5 seconds.
 *
 * Exit codes: 0 = success, 1 = failure, 130 = cancelled
 */

import { randomUUID } from 'node:crypto';
import { execFile, type ExecFileException } from 'node:child_process';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  orchestrate,
  PromptSectionName,
  renderPromptSections,
  classifyTrivialTaskPrompt,
  classifyTaskEffort,
  extractSingleCommandFromPrompt,
  resolveTrivialTaskGateConfig,
} from '@orchestrace/core';
import type { DagEvent, TaskGraph, TaskOutput, TaskRouteCategory, TaskEffort } from '@orchestrace/core';
import { PiAiAdapter, ProviderAuthManager, type LlmToolCall } from '@orchestrace/provider';
import {
  DEFAULT_AGENT_TOOL_POLICY_VERSION,
  createAgentToolset,
  createFileReadCache,
  type SubAgentRequest,
  type SubAgentResult,
} from '@orchestrace/tools';
import { InMemorySharedContextStore } from '@orchestrace/context';
import { FileEventStore, materializeSession } from '@orchestrace/store';
import type {
  SessionEvent,
  SessionEventInput,
  SessionConfig,
  SessionLlmStatus,
  LlmSessionState,
  SessionAgentGraphNode,
} from '@orchestrace/store';
import {
  llmStatusIdentityKey,
  parseTimestamp,
  shouldEmitLlmStatus,
  type LlmStatusEmissionState,
} from './ui-server/llm-status-emission.js';
import {
  THINKING_CIRCUIT_BREAKER_NUDGE,
  createThinkingCircuitBreakerState,
  isThinkingCycleEvent,
  resetThinkingCircuitBreaker,
  shouldResetThinkingCircuitBreakerOnEvent,
  updateThinkingCircuitBreaker,
} from './thinking-circuit-breaker.js';
import {
    deriveRoutingCoercionAudit,
  enforceSafeShellDispatch,
  formatShellValidationRejection,
  resolveTaskRouteForSource,
  stripRetryContinuationContext,
  type RoutingCoercionAudit,
  validateShellInput,
} from './task-routing.js';
import {
  SessionLifecycle,
  SessionLifecycleError,
  type SessionLifecyclePhase,
} from './session-lifecycle.js';
import {
  appendCleanupErrors,
  formatLifecyclePhaseFailure,
} from './runner-lifecycle-diagnostics.js';
import {
  classifySubAgentFailure,
  isRetryableSubAgentFailure,
  type SubAgentFailureType,
} from './runner-subagent-failure.js';
import {
  resolveRunnerPolicy,
  type ResolutionConflict,
} from './runner-config-resolution.js';
import { parseAndSanitizeVerifyCommands } from './verify-commands.js';
import {
  loadTesterAgentConfig,
  type TesterAgentConfig,
} from './tester-config.js';
import {
  assertWorkspaceRuntimeIsComplete,
  formatMissingSourceDirsWarning,
  validateWorkspaceRuntime,
} from './workspace-runtime.js';
import {
  sanitizeToolPayload,
  stringifySanitizedTracePayload,
} from './runner/log-sanitizer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUBAGENT_RETRY_MAX_ATTEMPTS = 2;
const SUBAGENT_RETRY_BASE_DELAY_MS = 300;
const SUBAGENT_WORKER_PROMPT_PREVIEW_MAX_CHARS = 220;
const SUBAGENT_WORKER_OUTPUT_PREVIEW_MAX_CHARS = 420;
const TOOL_EVENT_PREVIEW_MAX_CHARS = resolvePositiveIntEnv(
  process.env.ORCHESTRACE_TOOL_EVENT_PREVIEW_MAX_CHARS,
  32_000,
);
const TRACE_LOG_STREAM_DELTAS = resolveBooleanEnv(process.env.ORCHESTRACE_TRACE_LOG_STREAM_DELTAS, true);
const AUTO_CHECKPOINT_ENABLED = resolveBooleanEnv(process.env.ORCHESTRACE_AUTO_CHECKPOINT, true);
const AUTO_CHECKPOINT_EVERY_N_EDITS = resolvePositiveIntEnv(process.env.ORCHESTRACE_AUTO_CHECKPOINT_EVERY_N_EDITS, 3);
const AUTO_CHECKPOINT_GIT_TIMEOUT_MS = resolvePositiveIntEnv(process.env.ORCHESTRACE_AUTO_CHECKPOINT_GIT_TIMEOUT_MS, 15_000);
const SESSION_DELIVERY_REQUIRED = resolveBooleanEnv(process.env.ORCHESTRACE_SESSION_DELIVERY_REQUIRED, true);
const SESSION_DELIVERY_GIT_TIMEOUT_MS = resolvePositiveIntEnv(process.env.ORCHESTRACE_SESSION_DELIVERY_GIT_TIMEOUT_MS, 120_000);
const SESSION_DELIVERY_API_TIMEOUT_MS = resolvePositiveIntEnv(process.env.ORCHESTRACE_SESSION_DELIVERY_API_TIMEOUT_MS, 20_000);
const SESSION_DELIVERY_VERIFY_TIMEOUT_MS = resolvePositiveIntEnv(process.env.ORCHESTRACE_SESSION_DELIVERY_VERIFY_TIMEOUT_MS, 15 * 60_000);
const SESSION_DELIVERY_GH_TIMEOUT_MS = resolvePositiveIntEnv(process.env.ORCHESTRACE_SESSION_DELIVERY_GH_TIMEOUT_MS, 20_000);
const SESSION_DELIVERY_CI_TIMEOUT_MS = resolvePositiveIntEnv(process.env.ORCHESTRACE_SESSION_DELIVERY_CI_TIMEOUT_MS, 30 * 60_000);
const SESSION_DELIVERY_CI_POLL_INTERVAL_MS = resolvePositiveIntEnv(process.env.ORCHESTRACE_SESSION_DELIVERY_CI_POLL_INTERVAL_MS, 15_000);
const CHECKPOINT_STASH_PREFIX = 'orchestrace-checkpoint';
const CHECKPOINT_METADATA_FILE = 'checkpoint.json';
const execFileAsync = promisify(execFile);
const TESTER_TOOL_ALLOWLIST = [
  'list_directory',
  'read_file',
  'read_files',
  'search_files',
  'git_diff',
  'git_status',
  'write_file',
  'write_files',
  'edit_file',
  'edit_files',
  'run_command',
  'run_command_batch',
  'playwright_run',
  'url_fetch',
];

type CheckpointLifecycleState = 'idle' | 'active' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

interface CheckpointMetadata {
  sessionId: string;
  workspacePath: string;
  state: CheckpointLifecycleState;
  createdAt: string;
  updatedAt: string;
  headShaBefore?: string;
  stashRef?: string;
  stashMessage?: string;
  checkpointName?: string;
  finalizedAt?: string;
  hasUncommittedChanges?: boolean;
  hasStagedChanges?: boolean;
  hasUntrackedChanges?: boolean;
  dirtySummary?: string[];
  notes?: string;
}

interface PullRequestInfo {
  number: number;
  url: string;
  created: boolean;
}

interface PullRequestMergeInfo {
  sha?: string;
  merged: boolean;
  alreadyMerged: boolean;
}

interface GitHubApiResponse {
  ok: boolean;
  status: number;
  body: unknown;
  retryAfterMs?: number;
}

interface RunnerShellExecutionDependencies {
  execFile: typeof execFileAsync;
  logError: (message: string) => void;
}

const defaultRunnerShellExecutionDependencies: RunnerShellExecutionDependencies = {
  execFile: execFileAsync,
  logError: (message) => console.error(message),
};

// sub-agent failure types are imported from runner-subagent-failure.ts


// ---------------------------------------------------------------------------
// EPIPE resilience — when the parent UI server restarts, the pipe reader
// disappears. Without this, writes to stdout/stderr would emit uncaught
// errors and crash the runner.
// ---------------------------------------------------------------------------
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return; // swallow
    // Re-throw unexpected errors so they aren't silently swallowed
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const sessionId = process.argv[2];
  const workspaceRoot = process.argv[3];

  if (!sessionId || !workspaceRoot) {
    console.error('Usage: runner <sessionId> <workspaceRoot>');
    process.exit(1);
  }

  const eventStore = new FileEventStore(join(workspaceRoot, '.orchestrace', 'sessions'));
  const authManager = new ProviderAuthManager({
    authFilePath: join(workspaceRoot, 'auth.json'),
  });
  const githubAuthManager = new ProviderAuthManager({
    authFilePath: join(process.env.HOME ?? '~', '.orchestrace', 'github-auth.json'),
  });
  const llm = new PiAiAdapter();

  // Read session config from event store
  const events = await eventStore.read(sessionId);
  const createdEvent = [...events].reverse().find((e) => e.type === 'session:created');
  if (!createdEvent || createdEvent.type !== 'session:created') {
    console.error(`No session:created event found for session ${sessionId}`);
    process.exit(1);
  }

    const config: SessionConfig = createdEvent.payload.config;
  const controller = new AbortController();
  const sessionCommandEnv = buildSessionCommandEnvFromTestingPorts(config.testingPorts);

  try {
        const workspaceCheck = await validateWorkspaceRuntime(config.workspacePath);
    assertWorkspaceRuntimeIsComplete(workspaceCheck);
    config.workspacePath = workspaceCheck.normalizedPath;
    const workspaceWarning = formatMissingSourceDirsWarning(config.workspacePath, workspaceCheck.missingExpectedDirs);
    if (workspaceWarning) {
      console.warn(`[runner] ${workspaceWarning}`);
    }
  } catch (error) {
    const detail = `Workspace runtime validation failed: ${errorMsg(error)}`;
    console.error(`[runner] ${detail}`);
    await emit({ time: iso(), type: 'session:error-change', payload: { error: detail } });
    await emit({ time: iso(), type: 'session:status-change', payload: { status: 'failed' } });
    process.exit(1);
  }

  const sessionTesterConfigPath = join(config.workspacePath, '.orchestrace', 'tester', 'config.json');
  const rootTesterConfigPath = join(workspaceRoot, '.orchestrace', 'tester', 'config.json');

  let testerConfigDir = join(config.workspacePath, '.orchestrace');
  let testerConfigSource: 'session-workspace' | 'workspace-root-fallback' = 'session-workspace';

  const [sessionTesterConfigExists, rootTesterConfigExists] = await Promise.all([
    fileExists(sessionTesterConfigPath),
    fileExists(rootTesterConfigPath),
  ]);

  if (!sessionTesterConfigExists && rootTesterConfigExists) {
    testerConfigDir = join(workspaceRoot, '.orchestrace');
    testerConfigSource = 'workspace-root-fallback';
    console.info(
      `[runner:${sessionId}] tester-config fallback: using ${rootTesterConfigPath} because ${sessionTesterConfigPath} is missing.`,
    );
  }

  const testerAgentConfig = await loadTesterAgentConfig(testerConfigDir);
  console.info(
    `[runner:${sessionId}] tester-config source=${testerConfigSource} enabled=${testerAgentConfig.enabled}`,
  );

  // Write runner metadata (PID)
  await eventStore.setMetadata(sessionId, {
    id: sessionId,
    pid: process.pid,
    createdAt: config.id ? new Date().toISOString() : new Date().toISOString(),
    workspacePath: config.workspacePath,
  });

  // Emit started event
  await emit({ time: iso(), type: 'session:started', payload: { pid: process.pid } });

  // Heartbeat
  const heartbeatInterval = setInterval(() => {
    void emit({ time: iso(), type: 'session:runner-heartbeat', payload: { pid: process.pid } });
  }, 5_000);

  // Handle SIGTERM for gracellation
  let cancelled = false;
  const handleSigterm = () => {
    cancelled = true;
    controller.abort();
    resetThinkingCircuitBreaker(thinkingCircuitBreaker);
    void markCheckpointInterrupted(iso(), 'Received SIGTERM before session completion.');
    const llmStatus = makeLlmStatus('cancelled', 'Cancelled by user.');
    lastLlmStatusEmission = {
      key: llmStatusIdentityKey(llmStatus),
      emittedAt: parseTimestamp(llmStatus.updatedAt),
    };
    void emit({ time: iso(), type: 'session:llm-status-change', payload: { llmStatus } });
    void emit({ time: iso(), type: 'session:status-change', payload: { status: 'cancelled' } });
  };
  process.on('SIGTERM', handleSigterm);

  // Shared context and file-read cache for this session
  const sharedContextStore = new InMemorySharedContextStore();
  const fileReadCache = createFileReadCache();
  let lastLlmStatusEmission: LlmStatusEmissionState | undefined;
  const thinkingCircuitBreaker = createThinkingCircuitBreakerState();

  // Local state for graph progress tracking
  const agentGraph: SessionAgentGraphNode[] = [];
  const pendingNodeIds = new Map<string, string[]>();
  const promptForRoutingAndEffort = stripRetryContinuationContext(config.prompt);
  const resolvedRoute = resolveTaskRouteForSource(
    promptForRoutingAndEffort,
    config.source,
    process.env.ORCHESTRACE_TASK_ROUTE,
  ).result;
  const dispatch = enforceSafeShellDispatch(promptForRoutingAndEffort, resolvedRoute, config.source);
  const route = dispatch.route;
  const effortClassification = classifyTaskEffort(promptForRoutingAndEffort);
  const taskEffort: TaskEffort = (process.env.ORCHESTRACE_TASK_EFFORT as TaskEffort) || effortClassification.effort;
  let successfulEditFileResultsSinceCheckpoint = 0;
  const todoDoneCheckpointed = new Set<string>();
  let checkpointInFlight = false;
  let latestTesterVerdict: TaskOutput['testerVerdict'] | undefined;

  // Build single-task graph
  const graph = buildSingleTaskGraph(sessionId, config.prompt, route.category);

  /**
   * Standardized precedence for runner policy settings:
   * config (if valid) > env (if valid) > default.
   *
   * When config and env are both valid but differ, config wins and we emit warnings.
   */
  const runnerPolicy = resolveRunnerPolicy({
    configQuickStartMode: config.quickStartMode,
    envQuickStartMode: process.env.ORCHESTRACE_QUICK_START_MODE,
    configQuickStartMaxPreDelegationToolCalls: config.quickStartMaxPreDelegationToolCalls,
    envQuickStartMaxPreDelegationToolCalls: process.env.ORCHESTRACE_QUICK_START_MAX_PRE_DELEGATION_TOOL_CALLS,
    configPlanningNoToolGuardMode: config.planningNoToolGuardMode,
    envPlanningNoToolGuardMode: process.env.ORCHESTRACE_PLANNING_NO_TOOL_GUARD_MODE,
  });
  const quickStartMode = runnerPolicy.quickStartMode.value;
  const quickStartMaxPreDelegationToolCalls = runnerPolicy.quickStartMaxPreDelegationToolCalls.value;
  const planningNoToolGuardMode = runnerPolicy.planningNoToolGuardMode.value;
  const checkpointFilePath = join(workspaceRoot, '.orchestrace', 'sessions', sessionId, CHECKPOINT_METADATA_FILE);
  const checkpointName = `${CHECKPOINT_STASH_PREFIX}:${sessionId}:${Date.now()}`;
  const checkpointState = {
    status: 'idle' as CheckpointLifecycleState,
    metadata: undefined as CheckpointMetadata | undefined,
    finalized: false,
  };

  // Helper to emit events
  async function emit(event: SessionEventInput): Promise<void> {
    try {
      await eventStore.append(sessionId, event);
    } catch (err) {
      console.error(`[runner] Failed to emit event:`, err);
    }
  }

  function matchPlanApprovalDecision(
    event: SessionEvent,
    request: { taskId: string; path: string },
  ): { approved: boolean; note?: string } | undefined {
    if (event.type !== 'session:plan-approval-response') {
      return undefined;
    }

    const payload = event.payload as {
      taskId?: string;
      planPath?: string;
      approved?: unknown;
      note?: string;
    };

    if (typeof payload.approved !== 'boolean') {
      return undefined;
    }

    const eventTaskId = typeof payload.taskId === 'string' ? payload.taskId.trim() : '';
    if (eventTaskId && eventTaskId !== request.taskId) {
      return undefined;
    }

    const eventPlanPath = typeof payload.planPath === 'string' ? payload.planPath.trim() : '';
    if (eventPlanPath && eventPlanPath !== request.path) {
      return undefined;
    }

    const note = typeof payload.note === 'string' ? payload.note.trim() : '';
    return {
      approved: payload.approved,
      note: note.length > 0 ? note : undefined,
    };
  }

  async function waitForPlanApprovalDecision(
    request: { taskId: string; path: string },
  ): Promise<{ approved: boolean; note?: string }> {
    const recentEvents = await eventStore.read(sessionId);
    for (let index = recentEvents.length - 1; index >= 0; index -= 1) {
      const matched = matchPlanApprovalDecision(recentEvents[index], request);
      if (matched) {
        return matched;
      }
    }

    const fromSeq = recentEvents[recentEvents.length - 1]?.seq ?? 0;
    const approvalTimeoutMs = resolvePositiveIntEnv(process.env.ORCHESTRACE_PLAN_APPROVAL_TIMEOUT_MS, 0);

    return new Promise<{ approved: boolean; note?: string }>((resolve, reject) => {
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
                        let unwatch: (() => void) | undefined = undefined;

      const finalize = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (unwatch) {
          unwatch();
        }
        controller.signal.removeEventListener('abort', onAbort);
        callback();
      };

      const onAbort = () => {
        finalize(() => reject(new Error('Cancelled while waiting for plan approval input.')));
      };

      if (controller.signal.aborted) {
        reject(new Error('Cancelled while waiting for plan approval input.'));
        return;
      }

      controller.signal.addEventListener('abort', onAbort, { once: true });

      unwatch = eventStore.watch(sessionId, fromSeq, (event) => {
        const matched = matchPlanApprovalDecision(event, request);
        if (!matched) {
          return;
        }
        finalize(() => resolve(matched));
      });

      if (approvalTimeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          finalize(() => reject(new Error(`Timed out waiting for plan approval after ${approvalTimeoutMs}ms.`)));
        }, approvalTimeoutMs);
      }
    });
  }

  function emitRoutingCoercionAudit(input: RoutingCoercionAudit & {
    source?: 'user' | 'observer';
  }): void {
    const source = input.source ?? 'undefined';
    void emit({
      time: iso(),
      type: 'session:dag-event',
      payload: {
        event: {
          time: iso(),
          runId: sessionId,
          type: 'task:routing',
          taskId: 'task',
          message: `Routing coercion audit: type=${input.coercionType}; originalRoute=${input.originalRoute}; finalRoute=${input.finalRoute}; source=${source}; risk=${input.risk}; reason=${input.reason}`,
        },
      },
    });
  }

  const lifecycle = new SessionLifecycle('VALIDATING');

  function lifecycleDetailForPhase(phase: SessionLifecyclePhase): string {
    switch (phase) {
      case 'VALIDATING': return 'Validating prompt/session configuration.';
      case 'SETTING_UP': return 'Setting up runtime resources.';
      case 'DISPATCHING': return 'Dispatching execution strategy.';
      case 'EXECUTING': return 'Executing selected route.';
      case 'COMPLETING': return 'Finalizing outputs and status.';
      case 'CLEANING_UP': return 'Cleaning up runner resources.';
      case 'COMPLETED': return 'Run completed successfully.';
      case 'FAILED': return 'Run failed.';
      case 'CANCELLED': return 'Run cancelled.';
      default: return `Lifecycle phase: ${phase}`;
    }
  }

  async function emitLifecyclePhaseChange(phase: SessionLifecyclePhase): Promise<void> {
    const detail = lifecycleDetailForPhase(phase);
    const state: LlmSessionState = phase === 'FAILED'
      ? 'failed'
      : phase === 'CANCELLED'
        ? 'cancelled'
        : phase === 'COMPLETED'
          ? 'completed'
          : 'thinking';

    const llmStatus = makeLlmStatus(state, detail, undefined, 'task', 'implementation');
    lastLlmStatusEmission = {
      key: llmStatusIdentityKey(llmStatus),
      emittedAt: parseTimestamp(llmStatus.updatedAt),
    };
    await emit({ time: iso(), type: 'session:llm-status-change', payload: { llmStatus } });

    await emit({
      time: iso(),
      type: 'session:dag-event',
      payload: {
        event: {
          time: iso(),
          runId: sessionId,
          type: 'task:started',
          taskId: 'task',
          message: `Lifecycle phase: ${phase}`,
        },
      },
    });
  }

  async function enterLifecyclePhase(
    phase: SessionLifecyclePhase,
    options: { precondition?: () => boolean | Promise<boolean>; preconditionMessage?: string } = {},
  ): Promise<void> {
    await lifecycle.enterPhase(phase, options);
    await emitLifecyclePhaseChange(phase);
  }

  lifecycle.registerCleanup('SETTING_UP', 'remove-sigterm-listener', () => {
    process.off('SIGTERM', handleSigterm);
  });
  lifecycle.registerCleanup('SETTING_UP', 'clear-heartbeat-interval', () => {
    clearInterval(heartbeatInterval);
  });
  lifecycle.registerCleanup('SETTING_UP', 'abort-controller', () => {
    controller.abort();
  });

  void emit({
    time: iso(),
    type: 'session:dag-event',
    payload: {
      event: {
        time: iso(),
        runId: sessionId,
        type: 'task:routing',
        taskId: 'task',
        message: `Route selected: ${route.category} (${route.strategy}, source=${route.source}, confidence=${route.confidence.toFixed(2)})`,
      },
    },
  });

  const routingCoercionAudit = deriveRoutingCoercionAudit(resolvedRoute, dispatch);
  if (routingCoercionAudit) {
    emitRoutingCoercionAudit({
      ...routingCoercionAudit,
      source: config.source,
    });
  }

  void emit({
    time: iso(),
    type: 'session:dag-event',
    payload: {
      event: {
        time: iso(),
        runId: sessionId,
        type: 'task:routing',
        taskId: 'task',
        message: `Effort classified: ${taskEffort} (${effortClassification.reason})`,
      },
    },
  });

  function formatRunnerPolicyConflictWarning(conflict: ResolutionConflict<unknown>): string {
    return [
      `Configuration conflict for ${conflict.settingKey}:`,
      `config value (${String(conflict.configValue)}) differs from`,
      `${conflict.envVarName} (${String(conflict.envValue)}).`,
      'Using config value per precedence policy: config > env > default.',
    ].join(' ');
  }

  async function emitRunnerPolicyConflictWarnings(): Promise<void> {
    const conflicts = [
      runnerPolicy.quickStartMode.conflict,
      runnerPolicy.quickStartMaxPreDelegationToolCalls.conflict,
      runnerPolicy.planningNoToolGuardMode.conflict,
    ];

    for (const conflict of conflicts) {
      if (!conflict) {
        continue;
      }
      const warning = formatRunnerPolicyConflictWarning(conflict);
      console.warn(`[runner] ${warning}`);
      await emit({
        time: iso(),
        type: 'session:dag-event',
        payload: {
          event: {
            time: iso(),
            runId: sessionId,
            type: 'task:routing',
            taskId: 'task',
            message: warning,
          },
        },
      });
    }
  }

  await emitRunnerPolicyConflictWarnings();

  async function runGit(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd: config.workspacePath,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  }

  async function runGitSafe(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd: config.workspacePath,
        timeout: AUTO_CHECKPOINT_GIT_TIMEOUT_MS,
      });
      return { ok: true, stdout, stderr };
    } catch (err) {
      return { ok: false, stdout: '', stderr: '', error: errorMsg(err) };
    }
  }

  async function runGitSafeWithTimeout(
    args: string[],
    timeout: number,
  ): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd: config.workspacePath,
        timeout,
      });
      return { ok: true, stdout, stderr };
    } catch (err) {
      return { ok: false, stdout: '', stderr: '', error: errorMsg(err) };
    }
  }

      async function runShellCommandWithTimeout(
    command: string,
    timeout: number,
  ): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
    return runShellCommandWithTimeoutWithDeps(
      command,
      config.workspacePath,
      timeout,
      defaultRunnerShellExecutionDependencies,
      sessionCommandEnv,
    );
  }



  async function runRequiredValidationBeforeDelivery(): Promise<void> {
    const verifyCommands = parseAndSanitizeVerifyCommands(process.env.ORCHESTRACE_VERIFY_COMMANDS);
    if (verifyCommands.length === 0) {
      throw new Error('Remote delivery requires validation, but no verification commands are configured. Set ORCHESTRACE_VERIFY_COMMANDS.');
    }

    for (const command of verifyCommands) {
      const validationResult = await runShellCommandWithTimeout(command, SESSION_DELIVERY_VERIFY_TIMEOUT_MS);
      if (!validationResult.ok) {
        const details = [validationResult.stdout, validationResult.stderr, validationResult.error]
          .map((line) => (line ?? '').trim())
          .filter(Boolean)
          .join('\n');
        throw new Error(`Validation command failed before push: ${command}${details ? `\n${compact(details, 2000)}` : ''}`);
      }
    }
  }

  async function runGhJson<T extends Record<string, unknown>>(args: string[]): Promise<T> {
    try {
      const { stdout } = await execFileAsync('gh', args, {
        cwd: config.workspacePath,
        timeout: SESSION_DELIVERY_GH_TIMEOUT_MS,
        env: {
          ...process.env,
          GH_PAGER: 'cat',
        },
      });
      return JSON.parse(stdout) as T;
    } catch (error) {
      throw new Error(`gh command failed (${args.join(' ')}): ${errorMsg(error)}`);
    }
  }

  async function waitForGitHubCiChecks(params: {
    owner: string;
    repo: string;
    prNumber: number;
    prUrl: string;
  }): Promise<void> {
    const startedAt = Date.now();
    let observedChecks = false;

    while (true) {
      const prView = await runGhJson<{
        statusCheckRollup?: unknown;
      }>([
        'pr',
        'view',
        String(params.prNumber),
        '--repo',
        `${params.owner}/${params.repo}`,
        '--json',
        'statusCheckRollup',
      ]);

      const summary = assessGitHubStatusCheckRollup(prView.statusCheckRollup);
      if (summary.total > 0) {
        observedChecks = true;
      }

      if (summary.failing > 0) {
        throw new Error(`GitHub CI checks failed for PR #${params.prNumber}: ${params.prUrl}`);
      }

      if (observedChecks && summary.pending === 0) {
        return;
      }

      const elapsed = Date.now() - startedAt;
      if (elapsed >= SESSION_DELIVERY_CI_TIMEOUT_MS) {
        if (!observedChecks) {
          throw new Error(`Timed out waiting for GitHub CI checks to appear for PR #${params.prNumber}: ${params.prUrl}`);
        }
        throw new Error(
          `Timed out waiting for GitHub CI checks to pass for PR #${params.prNumber}: ${summary.pending} pending out of ${summary.total}`,
        );
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, SESSION_DELIVERY_CI_POLL_INTERVAL_MS);
      });
    }
  }

  const sessionHeadAtStart = await getGitHeadSha();
  let deliveryFinalized = false;
  const committedCheckpointShas: string[] = [];
  /** Tracks per-task commit boundaries for structured PR commits. */
  const taskCommitRanges: Array<{
    todoId: string;
    todoTitle: string;
    fromSha: string;
    toSha: string;
  }> = [];

  async function maybeCheckpoint(reason: 'edit-threshold' | 'todo-completed' | 'terminal', opts?: {
    todoId?: string;
    todoTitle?: string;
  }): Promise<void> {
    if (!AUTO_CHECKPOINT_ENABLED) return;
    if (checkpointInFlight) return;
    checkpointInFlight = true;

    const isSemanticBoundary = reason === 'todo-completed' || reason === 'terminal';

    try {
      const add = await runGitSafe(['add', '-A']);
      if (!add.ok) {
        await emit({
          time: iso(),
          type: 'session:checkpoint',
          payload: {
            status: 'failed',
            reason,
            message: 'git add failed',
            trigger: {
              threshold: AUTO_CHECKPOINT_EVERY_N_EDITS,
              editCountSinceLast: successfulEditFileResultsSinceCheckpoint,
              todoId: opts?.todoId,
              todoTitle: opts?.todoTitle,
            },
            error: (add.error ?? add.stderr) || 'git add failed',
          },
        });
        return;
      }

      const hasStaged = await runGitSafe(['diff', '--cached', '--quiet']);
      if (hasStaged.ok) {
        await emit({
          time: iso(),
          type: 'session:checkpoint',
          payload: {
            status: 'skipped',
            reason,
            message: 'no staged changes',
            trigger: {
              threshold: AUTO_CHECKPOINT_EVERY_N_EDITS,
              editCountSinceLast: successfulEditFileResultsSinceCheckpoint,
              todoId: opts?.todoId,
              todoTitle: opts?.todoTitle,
            },
          },
        });
        successfulEditFileResultsSinceCheckpoint = 0;
        return;
      }

      // Generate commit message: semantic for todo-completed/terminal, simple for edit-threshold
      let commitMessage: string;
      if (isSemanticBoundary) {
        // Get diff context for semantic message
        const diffStatRes = await runGitSafe(['diff', '--cached', '--stat']);
        const filesRes = await runGitSafe(['diff', '--cached', '--name-only']);
        const changedFiles = filesRes.ok ? filesRes.stdout.trim().split('\n').filter(Boolean) : [];

        commitMessage = await generateSemanticCommitMessage({
          todoTitle: opts?.todoTitle,
          todoId: opts?.todoId,
          reason,
          diffStat: diffStatRes.ok ? diffStatRes.stdout.trim() : '',
          changedFiles,
        });
      } else {
        const messageContext = opts?.todoTitle?.trim() || opts?.todoId?.trim() || reason;
        commitMessage = `checkpoint: ${compact(messageContext, 120)}`;
      }

      const commit = await runGitSafe(['commit', '-m', commitMessage]);
      if (!commit.ok) {
        await emit({
          time: iso(),
          type: 'session:checkpoint',
          payload: {
            status: 'failed',
            reason,
            message: commitMessage,
            trigger: {
              threshold: AUTO_CHECKPOINT_EVERY_N_EDITS,
              editCountSinceLast: successfulEditFileResultsSinceCheckpoint,
              todoId: opts?.todoId,
              todoTitle: opts?.todoTitle,
            },
            error: (commit.error ?? commit.stderr) || 'git commit failed',
          },
        });
        return;
      }

      const fullHead = await runGitSafe(['rev-parse', 'HEAD']);
      if (fullHead.ok) {
        const fullSha = fullHead.stdout.trim();
        if (fullSha) {
          committedCheckpointShas.push(fullSha);

          // Record per-task boundary when a todo-completed checkpoint succeeds
          if (reason === 'todo-completed' && opts?.todoId) {
            const prevTaskEnd = taskCommitRanges.length > 0
              ? taskCommitRanges[taskCommitRanges.length - 1].toSha
              : sessionHeadAtStart;
            taskCommitRanges.push({
              todoId: opts.todoId,
              todoTitle: opts.todoTitle ?? opts.todoId,
              fromSha: prevTaskEnd ?? fullSha,
              toSha: fullSha,
            });
          }
        }
      }

      const head = await runGitSafe(['rev-parse', '--short', 'HEAD']);
      await emit({
        time: iso(),
        type: 'session:checkpoint',
        payload: {
          status: 'committed',
          reason,
          message: commitMessage,
          trigger: {
            threshold: AUTO_CHECKPOINT_EVERY_N_EDITS,
            editCountSinceLast: successfulEditFileResultsSinceCheckpoint,
            todoId: opts?.todoId,
            todoTitle: opts?.todoTitle,
          },
          commit: {
            hash: head.ok ? head.stdout.trim() : undefined,
            summary: commit.stdout.trim() || commit.stderr.trim() || undefined,
          },
        },
      });
      successfulEditFileResultsSinceCheckpoint = 0;

      // Push after semantic commits to keep remote in sync
      if (isSemanticBoundary) {
        const pushResult = await incrementalPush();
        if (!pushResult.ok) {
          console.warn(`[runner] Incremental push failed after semantic commit: ${pushResult.error}`);
        }
      }
    } finally {
      checkpointInFlight = false;
    }
  }

  async function getGitHeadSha(): Promise<string | undefined> {
    try {
      const stdout = await runGit(['rev-parse', 'HEAD']);
      const sha = stdout.trim();
      return sha ? sha : undefined;
    } catch {
      return undefined;
    }
  }

  // -----------------------------------------------------------------------
  // Semantic commit helpers
  // -----------------------------------------------------------------------

  /** Whether the session branch has ever been pushed to origin. */
  let sessionBranchPushed = false;

  /**
   * Generates a conventional-commit-style message for a logical unit of work
   * by calling the LLM with the staged diff context.
   */
  async function generateSemanticCommitMessage(context: {
    todoTitle?: string;
    todoId?: string;
    reason: string;
    diffStat: string;
    changedFiles: string[];
  }): Promise<string> {
    const taskHint = context.todoTitle || context.todoId || context.reason;
    const fileList = context.changedFiles.slice(0, 20).join(', ');
    const prompt = [
      'Generate a single conventional-commit message (max 72 chars) for the following change.',
      'Respond with ONLY the commit message line, no explanation.',
      '',
      `Task: ${taskHint}`,
      `Original session prompt: ${compact(config.prompt, 200)}`,
      `Files changed (${context.changedFiles.length}): ${fileList}`,
      context.diffStat ? `\nDiff stats:\n${context.diffStat}` : '',
    ].join('\n');

    try {
      const agent = await llm.spawnAgent({
        provider: config.provider,
        model: config.model,
        systemPrompt: 'You generate conventional-commit messages. Output only the single commit message line. Use prefixes like feat:, fix:, refactor:, docs:, chore:, test: as appropriate.',
        timeoutMs: 15_000,
        apiKey: await authManager.resolveApiKey(config.provider),
        refreshApiKey: () => authManager.resolveApiKey(config.provider),
        allowAuthRefreshRetry: true,
      });
      const result = await agent.complete(prompt);
      const msg = result.text.trim().split('\n')[0].trim();
      if (msg && msg.length <= 120) return msg;
    } catch (err) {
      console.warn(`[runner] Semantic commit message generation failed: ${errorMsg(err)}. Using fallback.`);
    }

    // Fallback: use the todo title or reason as-is
    return compact(taskHint, 72);
  }

  /**
   * Push the current branch to origin. On first push, sets upstream.
   * Subsequent pushes are plain `git push`.
   */
  async function incrementalPush(): Promise<{ ok: boolean; error?: string }> {
    const branchRes = await runGitSafeWithTimeout(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      SESSION_DELIVERY_GIT_TIMEOUT_MS,
    );
    if (!branchRes.ok) return { ok: false, error: 'Cannot resolve current branch' };
    const branch = branchRes.stdout.trim();

    const pushArgs = sessionBranchPushed
      ? ['push']
      : ['push', '--set-upstream', 'origin', branch];

    const pushRes = await runGitSafeWithTimeout(pushArgs, SESSION_DELIVERY_GIT_TIMEOUT_MS);
    if (pushRes.ok) {
      sessionBranchPushed = true;
      return { ok: true };
    }
    return { ok: false, error: (pushRes.error ?? pushRes.stderr) || 'git push failed' };
  }

  async function getWorktreeDirtySummary(): Promise<{
    hasUncommittedChanges: boolean;
    hasStagedChanges: boolean;
    hasUntrackedChanges: boolean;
    dirtySummary: string[];
  }> {
    const [unstaged, staged, untracked] = await Promise.all([
      runGit(['diff', '--name-status']).catch(() => ''),
      runGit(['diff', '--cached', '--name-status']).catch(() => ''),
      runGit(['ls-files', '--others', '--exclude-standard']).catch(() => ''),
    ]);
    const unstagedLines = unstaged.split('\n').map((line) => line.trim()).filter(Boolean);
    const stagedLines = staged.split('\n').map((line) => line.trim()).filter(Boolean);
    const untrackedLines = untracked.split('\n').map((line) => line.trim()).filter(Boolean);
    return {
      hasUncommittedChanges: unstagedLines.length > 0,
      hasStagedChanges: stagedLines.length > 0,
      hasUntrackedChanges: untrackedLines.length > 0,
      dirtySummary: [...unstagedLines, ...stagedLines, ...untrackedLines.map((line) => `?? ${line}`)].slice(0, 200),
    };
  }

  /**
   * Deterministic code-change detection: compares session start HEAD against
   * current HEAD and checks for any uncommitted/staged/untracked changes.
   * Returns an authoritative verdict on whether the session produced code changes.
   */
  async function detectSessionCodeChanges(): Promise<{
    hasChanges: boolean;
    commitCount: number;
    diffSummary: string;
    changedFiles: string[];
  }> {
    // First: commit any remaining dirty changes so nothing is lost
    const dirty = await getWorktreeDirtySummary();
    if (dirty.hasUncommittedChanges || dirty.hasStagedChanges || dirty.hasUntrackedChanges) {
      await runGitSafe(['add', '-A']);
      const hasStaged = await runGitSafe(['diff', '--cached', '--quiet']);
      if (!hasStaged.ok) {
        await runGitSafe(['commit', '-m', 'checkpoint: final uncommitted changes']);
        const fullHead = await runGitSafe(['rev-parse', 'HEAD']);
        if (fullHead.ok && fullHead.stdout.trim()) {
          committedCheckpointShas.push(fullHead.stdout.trim());
        }
      }
    }

    const currentHead = await getGitHeadSha();
    if (!currentHead || !sessionHeadAtStart) {
      // Fallback: if we can't determine SHAs, check committed checkpoint tracking
      return {
        hasChanges: committedCheckpointShas.length > 0,
        commitCount: committedCheckpointShas.length,
        diffSummary: '',
        changedFiles: [],
      };
    }

    if (currentHead === sessionHeadAtStart && committedCheckpointShas.length === 0) {
      return { hasChanges: false, commitCount: 0, diffSummary: '', changedFiles: [] };
    }

    // Count commits between start and current HEAD
    let commitCount = 0;
    const countRes = await runGitSafeWithTimeout(
      ['rev-list', '--count', `${sessionHeadAtStart}..${currentHead}`],
      SESSION_DELIVERY_GIT_TIMEOUT_MS,
    );
    if (countRes.ok) {
      const parsed = Number.parseInt(countRes.stdout.trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) commitCount = parsed;
    }
    if (commitCount <= 0 && committedCheckpointShas.length > 0) {
      commitCount = committedCheckpointShas.length;
    }

    if (commitCount <= 0) {
      return { hasChanges: false, commitCount: 0, diffSummary: '', changedFiles: [] };
    }

    // Get diff summary for LLM context
    const diffStatRes = await runGitSafeWithTimeout(
      ['diff', '--stat', `${sessionHeadAtStart}..${currentHead}`],
      SESSION_DELIVERY_GIT_TIMEOUT_MS,
    );
    const diffSummary = diffStatRes.ok ? diffStatRes.stdout.trim() : '';

    const diffNameRes = await runGitSafeWithTimeout(
      ['diff', '--name-only', `${sessionHeadAtStart}..${currentHead}`],
      SESSION_DELIVERY_GIT_TIMEOUT_MS,
    );
    const changedFiles = diffNameRes.ok
      ? diffNameRes.stdout.trim().split('\n').filter(Boolean)
      : [];

    return { hasChanges: true, commitCount, diffSummary, changedFiles };
  }

  /**
   * Uses the LLM to generate meaningful PR metadata: branch name, title,
   * description, and per-task commit messages.
   */
  async function generatePrMetadata(context: {
    prompt: string;
    diffSummary: string;
    changedFiles: string[];
    commitCount: number;
    taskRanges: Array<{ todoId: string; todoTitle: string; changedFiles: string[] }>;
  }): Promise<{
    branchName: string;
    prTitle: string;
    prDescription: string;
    taskCommitMessages: Array<{ todoId: string; message: string }>;
    fallbackCommitMessage: string;
  }> {
    const taskSection = context.taskRanges.length > 0
      ? [
        '',
        '## Tasks Completed',
        ...context.taskRanges.map((t, i) =>
          `${i + 1}. "${t.todoTitle}" (files: ${t.changedFiles.slice(0, 10).join(', ')}${t.changedFiles.length > 10 ? ` +${t.changedFiles.length - 10} more` : ''})`,
        ),
      ].join('\n')
      : '';

    const isObserverSession = config.source === 'observer';
    const observerPrefixNote = isObserverSession
      ? '- IMPORTANT: Prepend "[Observer fix] " to the prTitle (e.g., "[Observer fix] feat: fix linting issue"). This marks the PR as auto-generated by the observer.'
      : '';

    const metadataPrompt = [
      'You are generating metadata for a pull request. Respond ONLY with a valid JSON object, no markdown fences, no extra text.',
      '',
      '## Original Task',
      context.prompt,
      '',
      '## Changes Summary',
      `Files changed (${context.changedFiles.length}): ${context.changedFiles.slice(0, 30).join(', ')}`,
      '',
      context.diffSummary ? `Diff stats:\n${context.diffSummary}` : '',
      '',
      `Total commits: ${context.commitCount}`,
      taskSection,
      '',
      '## Instructions',
      'Generate a JSON object with these exact keys:',
      '- "branchName": a short kebab-case git branch name (no spaces, max 60 chars, no special chars except hyphens). Prefix with "feat/", "fix/", "refactor/", or "chore/" as appropriate.',
      `- "prTitle": a concise, descriptive PR title (max 80 chars). Use conventional commit style (e.g., "feat: add user auth flow"). ${observerPrefixNote}`,
      '- "prDescription": a detailed markdown PR description covering: what changed, why, and key implementation details. Include a brief summary and a bullet list of notable changes.',
      ...(context.taskRanges.length > 0
        ? [
          '- "taskCommitMessages": an array of objects, one per task in the same order, each with:',
          '  - "todoId": the task ID (match exactly from the tasks list above)',
          '  - "message": a conventional-commit-style commit message for that task (max 72 chars). Be specific about what the task accomplished.',
        ]
        : []),
      '- "fallbackCommitMessage": a meaningful single-line commit message for the overall change (max 72 chars). Use conventional commit style.',
      '',
      'Respond with ONLY the JSON object.',
    ].join('\n');

    try {
      const agent = await llm.spawnAgent({
        provider: config.provider,
        model: config.model,
        systemPrompt: 'You are a precise JSON generator. Output only valid JSON, nothing else.',
        timeoutMs: 30_000,
                apiKey: await authManager.resolveApiKey(config.provider),
        refreshApiKey: () => authManager.resolveApiKey(config.provider),
        allowAuthRefreshRetry: true,


      });

      const result = await agent.complete(metadataPrompt);
      const parsed = parsePrMetadataResponse(result.text, context.taskRanges, isObserverSession);
      if (parsed) return parsed;
    } catch (err) {
      console.warn(`[runner] LLM PR metadata generation failed: ${errorMsg(err)}. Using fallback.`);
    }

    // Fallback: generate reasonable defaults from the prompt
    const slug = config.prompt
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .split(/\s+/)
      .slice(0, 5)
      .join('-')
      .slice(0, 50);

    const fallbackPrTitle = compact(config.prompt, 80);
    const prTitle = isObserverSession && !fallbackPrTitle.startsWith('[Observer fix]')
      ? `[Observer fix] ${fallbackPrTitle}`.slice(0, 80)
      : fallbackPrTitle;

    return {
      branchName: `feat/${slug || `session-${sessionId.slice(0, 8)}`}`,
      prTitle,
      prDescription: [
        `## Summary`,
        compact(config.prompt, 200),
        '',
        `## Changes`,
        ...context.changedFiles.slice(0, 20).map((f) => `- \`${f}\``),
        context.changedFiles.length > 20 ? `- ... and ${context.changedFiles.length - 20} more files` : '',
      ].join('\n'),
      taskCommitMessages: context.taskRanges.map((t) => ({
        todoId: t.todoId,
        message: compact(t.todoTitle, 72),
      })),
      fallbackCommitMessage: compact(config.prompt, 72),
    };
  }

  /**
   * Pushes the session branch and creates a PR.
   * Semantic commits are already in place from incremental `maybeCheckpoint`
   * calls – this function just ensures the final push and PR creation.
   */
  async function ensureRemoteDeliveryForCommittedSession(): Promise<void> {
    if (deliveryFinalized) return;

    // Deterministic code-change gate
    const changes = await detectSessionCodeChanges();
    if (!changes.hasChanges) return;

    if (!SESSION_DELIVERY_REQUIRED) {
      throw new Error(
        'Session created committed code changes, but ORCHESTRACE_SESSION_DELIVERY_REQUIRED is disabled. Re-enable delivery to enforce mandatory PR creation.',
      );
    }

    deliveryFinalized = true;

    // Resolve per-task changed files for LLM context
    const taskRangesWithFiles = await Promise.all(
      taskCommitRanges.map(async (range) => {
        const filesRes = await runGitSafeWithTimeout(
          ['diff', '--name-only', `${range.fromSha}..${range.toSha}`],
          SESSION_DELIVERY_GIT_TIMEOUT_MS,
        );
        return {
          todoId: range.todoId,
          todoTitle: range.todoTitle,
          changedFiles: filesRes.ok ? filesRes.stdout.trim().split('\n').filter(Boolean) : [],
        };
      }),
    );

    // Use LLM to generate meaningful PR metadata
    const prMeta = await generatePrMetadata({
      prompt: config.prompt,
      diffSummary: changes.diffSummary,
      changedFiles: changes.changedFiles,
      commitCount: changes.commitCount,
      taskRanges: taskRangesWithFiles,
    });

    if (latestTesterVerdict) {
      prMeta.prDescription = appendTesterEvidenceToPrDescription(prMeta.prDescription, latestTesterVerdict);
    }

    // Squash remaining checkpoint commits (edit-threshold) into semantic ones.
    // Only rewrite if ALL commits are still checkpoint-style (no semantic
    // boundaries were hit during execution, e.g. single-task sessions).
    const hasSemanticCommits = committedCheckpointShas.some((_, i) => {
      // We pushed after semantic boundaries, so if we ever pushed we have semantics
      return sessionBranchPushed;
    });

    if (!hasSemanticCommits && sessionHeadAtStart && changes.commitCount >= 1) {
      // No semantic commits were made — squash all checkpoints into one commit
      if (changes.commitCount > 1) {
        const resetRes = await runGitSafeWithTimeout(
          ['reset', '--soft', sessionHeadAtStart],
          SESSION_DELIVERY_GIT_TIMEOUT_MS,
        );
        if (resetRes.ok) {
          const commitRes = await runGitSafeWithTimeout(
            ['commit', '-m', prMeta.fallbackCommitMessage],
            SESSION_DELIVERY_GIT_TIMEOUT_MS,
          );
          if (!commitRes.ok) {
            throw new Error(`Failed to create squash commit: ${(commitRes.error ?? commitRes.stderr) || 'git commit failed'}`);
          }
        }
      } else {
        await runGitSafeWithTimeout(
          ['commit', '--amend', '-m', prMeta.fallbackCommitMessage],
          SESSION_DELIVERY_GIT_TIMEOUT_MS,
        );
      }
    }

    const baseBranch = await resolveBaseBranch();

    // Use the existing worktree branch for the PR instead of creating a new one.
    // The branch is already `orchestrace/session-<id>` from worktree setup.
    const currentBranchRes = await runGitSafeWithTimeout(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      SESSION_DELIVERY_GIT_TIMEOUT_MS,
    );
    const deliveryBranch = currentBranchRes.ok ? currentBranchRes.stdout.trim() : `orchestrace/session-${sessionId.slice(0, 8)}`;
    prMeta.branchName = deliveryBranch;

    await runRequiredValidationBeforeDelivery();

    const pushRes = await runGitSafeWithTimeout(
      ['push', '--set-upstream', 'origin', prMeta.branchName],
      SESSION_DELIVERY_GIT_TIMEOUT_MS,
    );
    if (!pushRes.ok) {
      throw new Error(`git push failed for ${prMeta.branchName}: ${(pushRes.error ?? pushRes.stderr) || 'unknown error'}`);
    }

    const remoteRes = await runGitSafeWithTimeout(['remote', 'get-url', 'origin'], SESSION_DELIVERY_GIT_TIMEOUT_MS);
    if (!remoteRes.ok) {
      throw new Error(`Unable to resolve origin remote URL: ${(remoteRes.error ?? remoteRes.stderr) || 'origin missing'}`);
    }

    const remote = parseGitHubRemote(remoteRes.stdout.trim());
    if (!remote) {
      throw new Error(`Origin remote is not a supported GitHub remote: ${remoteRes.stdout.trim()}`);
    }

    const token = await githubAuthManager.resolveApiKey('github').catch(() => undefined);
    if (!token) {
      throw new Error('GitHub auth is not configured. Connect GitHub in Settings before finishing a committed session.');
    }

    const pr = await ensurePullRequest({
      host: remote.host,
      owner: remote.owner,
      repo: remote.repo,
      headBranch: prMeta.branchName,
      baseBranch,
      token,
      title: prMeta.prTitle,
      body: prMeta.prDescription,
    });

    await waitForGitHubCiChecks({
      owner: remote.owner,
      repo: remote.repo,
      prNumber: pr.number,
      prUrl: pr.url,
    });

    const deliveryStrategy = resolveSessionDeliveryStrategy(config.deliveryStrategy);
    let mergeInfo: PullRequestMergeInfo | undefined;
    if (deliveryStrategy === 'merge-after-ci') {
      mergeInfo = await mergePullRequest({
        host: remote.host,
        owner: remote.owner,
        repo: remote.repo,
        prNumber: pr.number,
        token,
        title: prMeta.prTitle,
      });
    }

    const deliveryMessage = formatSessionDeliveryMessage({
      branchName: prMeta.branchName,
      prNumber: pr.number,
      prUrl: pr.url,
      prCreated: pr.created,
      deliveryStrategy,
      alreadyMerged: mergeInfo?.alreadyMerged ?? false,
    });

    await emit({
      time: iso(),
      type: 'session:chat-message',
      payload: {
        message: {
          role: 'system',
          content: deliveryMessage,
          time: iso(),
        },
      },
    });
  }

  async function resolveBaseBranch(): Promise<string> {
    const remoteHead = await runGitSafeWithTimeout(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], SESSION_DELIVERY_GIT_TIMEOUT_MS);
    if (remoteHead.ok) {
      const ref = remoteHead.stdout.trim();
      if (ref.startsWith('origin/')) {
        const branch = ref.slice('origin/'.length).trim();
        if (branch) {
          return branch;
        }
      }
    }

    for (const candidate of ['main', 'master']) {
      const head = await runGitSafeWithTimeout(['ls-remote', '--heads', 'origin', candidate], SESSION_DELIVERY_GIT_TIMEOUT_MS);
      if (head.ok && head.stdout.trim()) {
        return candidate;
      }
    }

    return 'main';
  }

  async function ensurePullRequest(params: {
    host: string;
    owner: string;
    repo: string;
    headBranch: string;
    baseBranch: string;
    token: string;
    title: string;
    body: string;
  }): Promise<PullRequestInfo> {
    const createRes = await callGitHubApi(params, 'POST', `/repos/${params.owner}/${params.repo}/pulls`, {
      title: params.title,
      body: params.body,
      head: params.headBranch,
      base: params.baseBranch,
      maintainer_can_modify: true,
    });

    if (createRes.ok) {
      const created = createRes.body as { number?: unknown; html_url?: unknown };
      const number = typeof created.number === 'number' ? created.number : undefined;
      const url = typeof created.html_url === 'string' ? created.html_url : undefined;
      if (!number || !url) {
        throw new Error('GitHub create PR response was missing number or html_url.');
      }
      return { number, url, created: true };
    }

    if (createRes.status === 422) {
      const headQuery = encodeURIComponent(`${params.owner}:${params.headBranch}`);
      const existingRes = await callGitHubApi(
        params,
        'GET',
        `/repos/${params.owner}/${params.repo}/pulls?state=open&head=${headQuery}&base=${encodeURIComponent(params.baseBranch)}`,
      );
      if (existingRes.ok && Array.isArray(existingRes.body) && existingRes.body.length > 0) {
        const existing = existingRes.body[0] as { number?: unknown; html_url?: unknown };
        const number = typeof existing.number === 'number' ? existing.number : undefined;
        const url = typeof existing.html_url === 'string' ? existing.html_url : undefined;
        if (number && url) {
          return { number, url, created: false };
        }
      }
    }

    throw new Error(`Unable to create pull request: ${formatGitHubApiError(createRes)}`);
  }

  async function mergePullRequest(params: {
    host: string;
    owner: string;
    repo: string;
    prNumber: number;
    token: string;
    title: string;
  }): Promise<PullRequestMergeInfo> {
    const mergeRes = await callGitHubApi(
      params,
      'PUT',
      `/repos/${params.owner}/${params.repo}/pulls/${params.prNumber}/merge`,
      {
        merge_method: 'merge',
        commit_title: params.title,
      },
    );

    if (mergeRes.ok) {
      const body = mergeRes.body as { sha?: unknown; merged?: unknown };
      return {
        sha: typeof body.sha === 'string' ? body.sha : undefined,
        merged: body.merged === true,
        alreadyMerged: false,
      };
    }

    // Race-safe fallback: PR may already be merged manually after CI passed.
    const prRes = await callGitHubApi(params, 'GET', `/repos/${params.owner}/${params.repo}/pulls/${params.prNumber}`);
    if (prRes.ok && prRes.body && typeof prRes.body === 'object' && !Array.isArray(prRes.body)) {
      const pr = prRes.body as { merged?: unknown; merge_commit_sha?: unknown };
      if (pr.merged === true) {
        return {
          sha: typeof pr.merge_commit_sha === 'string' ? pr.merge_commit_sha : undefined,
          merged: true,
          alreadyMerged: true,
        };
      }
    }

    throw new Error(`Unable to merge pull request #${params.prNumber}: ${formatGitHubApiError(mergeRes)}`);
  }

  async function callGitHubApi(
    params: { host: string; token: string },
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: Record<string, unknown>,
    _attempt = 0,
  ): Promise<GitHubApiResponse> {
    const apiBase = buildGitHubApiBaseUrl(params.host);
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'orchestrace-runner',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(SESSION_DELIVERY_API_TIMEOUT_MS),
    });

    // Handle primary (403 with x-ratelimit-reset) and secondary (retry-after) rate limits.
    if ((response.status === 403 || response.status === 429) && _attempt === 0) {
      const retryAfterSec = response.headers.get('retry-after');
      const resetEpoch = response.headers.get('x-ratelimit-reset');
      let waitMs: number | undefined;
      if (retryAfterSec) {
        waitMs = Number.parseInt(retryAfterSec, 10) * 1000;
      } else if (resetEpoch) {
        const resetMs = Number.parseInt(resetEpoch, 10) * 1000;
        waitMs = Math.max(0, resetMs - Date.now());
      }
      // Only auto-retry if the wait is 90 s or less to stay within session timeouts.
      if (waitMs !== undefined && waitMs >= 0 && waitMs <= 90_000) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        return callGitHubApi(params, method, path, body, 1);
      }
      // Wait is too long or unknown — surface it with the retryAfterMs hint.
      const contentType = response.headers.get('content-type') ?? '';
      let responseBody: unknown;
      if (contentType.includes('application/json')) {
        responseBody = await response.json().catch(() => undefined);
      } else {
        responseBody = await response.text().catch(() => undefined);
      }
      return {
        ok: false,
        status: response.status,
        body: responseBody,
        retryAfterMs: waitMs,
      };
    }

    const contentType = response.headers.get('content-type') ?? '';
    let responseBody: unknown;
    if (contentType.includes('application/json')) {
      responseBody = await response.json().catch(() => undefined);
    } else {
      responseBody = await response.text().catch(() => undefined);
    }

    return {
      ok: response.ok,
      status: response.status,
      body: responseBody,
    };
  }

  async function writeCheckpointMetadata(metadata: CheckpointMetadata): Promise<void> {
    const dir = join(workspaceRoot, '.orchestrace', 'sessions', sessionId);
    await mkdir(dir, { recursive: true });
    const tempPath = `${checkpointFilePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    await rename(tempPath, checkpointFilePath);
  }

  async function readCheckpointMetadata(): Promise<CheckpointMetadata | undefined> {
    try {
      const raw = await readFile(checkpointFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CheckpointMetadata>;
      if (!parsed || typeof parsed !== 'object') {
        return undefined;
      }
      if (typeof parsed.sessionId !== 'string' || typeof parsed.workspacePath !== 'string' || typeof parsed.state !== 'string') {
        return undefined;
      }
      return parsed as CheckpointMetadata;
    } catch {
      return undefined;
    }
  }

  function isMutatingToolCall(event: Extract<DagEvent, { type: 'task:tool-call' }>): boolean {
    if (event.status !== 'started') return false;
    const tool = event.toolName.trim();
    const mutatingTools = new Set([
      'write_file',
      'write_files',
      'edit_file',
      'edit_files',
      'run_command',
      'run_command_batch',
      'github_api',
    ]);
    if (mutatingTools.has(tool)) return true;
    return tool.startsWith('functions.write_')
      || tool.startsWith('functions.edit_')
      || tool === 'functions.run_command'
      || tool === 'functions.run_command_batch'
      || tool === 'functions.github_api';
  }

  async function ensureCheckpointForMutatingBatch(trigger: Extract<DagEvent, { type: 'task:tool-call' }>, at: string): Promise<void> {
    if (!isMutatingToolCall(trigger)) {
      return;
    }
    if (checkpointState.status !== 'idle') {
      return;
    }

    checkpointState.status = 'active';
    const headShaBefore = await getGitHeadSha();
    const stashMessage = checkpointName;
    let stashRef: string | undefined;
    try {
      // Non-destructive checkpoint: capture current state without altering the worktree.
      const stashCommit = (await runGit(['stash', 'create', stashMessage])).trim();
      if (stashCommit) {
        await runGit(['stash', 'store', '-m', stashMessage, stashCommit]);
        const stashList = await runGit(['stash', 'list']);
        const stashLine = stashList.split('\n').find((line) => line.includes(stashMessage));
        stashRef = stashLine?.split(':', 1)[0]?.trim() ?? stashCommit;
      }
    } catch (error) {
      console.warn(`[runner] Failed to create pre-edit checkpoint for ${sessionId}: ${errorMsg(error)}`);
      checkpointState.status = 'idle';
      return;
    }

    const metadata: CheckpointMetadata = {
      sessionId,
      workspacePath: config.workspacePath,
      state: 'active',
      createdAt: at,
      updatedAt: at,
      headShaBefore,
      stashRef,
      stashMessage,
      checkpointName,
      notes: `Created from tool ${trigger.toolName}.`,
    };

    try {
      await writeCheckpointMetadata(metadata);
      checkpointState.metadata = metadata;
    } catch (error) {
      console.warn(`[runner] Failed to persist checkpoint metadata for ${sessionId}: ${errorMsg(error)}`);
    }
  }

  async function finalizeCheckpoint(state: Extract<CheckpointLifecycleState, 'completed' | 'failed' | 'cancelled'>, at: string): Promise<void> {
    if (checkpointState.finalized) {
      return;
    }
    checkpointState.finalized = true;

    const existing = checkpointState.metadata ?? await readCheckpointMetadata();
    if (!existing) {
      return;
    }

    const dirty = await getWorktreeDirtySummary().catch(() => ({
      hasUncommittedChanges: false,
      hasStagedChanges: false,
      hasUntrackedChanges: false,
      dirtySummary: [] as string[],
    }));

    const next: CheckpointMetadata = {
      ...existing,
      state,
      updatedAt: at,
      finalizedAt: at,
      hasUncommittedChanges: dirty.hasUncommittedChanges,
      hasStagedChanges: dirty.hasStagedChanges,
      hasUntrackedChanges: dirty.hasUntrackedChanges,
      dirtySummary: dirty.dirtySummary,
    };

    checkpointState.status = state;
    checkpointState.metadata = next;
    await writeCheckpointMetadata(next).catch((error) => {
      console.warn(`[runner] Failed to finalize checkpoint metadata for ${sessionId}: ${errorMsg(error)}`);
    });
  }

  async function markCheckpointInterrupted(at: string, detail: string): Promise<void> {
    const existing = checkpointState.metadata ?? await readCheckpointMetadata();
    if (!existing) {
      return;
    }

    const dirty = await getWorktreeDirtySummary().catch(() => ({
      hasUncommittedChanges: false,
      hasStagedChanges: false,
      hasUntrackedChanges: false,
      dirtySummary: [] as string[],
    }));

    const next: CheckpointMetadata = {
      ...existing,
      state: 'interrupted',
      updatedAt: at,
      hasUncommittedChanges: dirty.hasUncommittedChanges,
      hasStagedChanges: dirty.hasStagedChanges,
      hasUntrackedChanges: dirty.hasUntrackedChanges,
      dirtySummary: dirty.dirtySummary,
      notes: detail,
    };

    checkpointState.status = 'interrupted';
    checkpointState.metadata = next;
    await writeCheckpointMetadata(next).catch((error) => {
      console.warn(`[runner] Failed to mark checkpoint interrupted for ${sessionId}: ${errorMsg(error)}`);
    });

    }

  try {
    await emitLifecyclePhaseChange('VALIDATING');
    await enterLifecyclePhase('SETTING_UP', {
      precondition: () => Boolean(config.prompt && config.prompt.trim()) && Boolean(config.workspacePath && config.workspacePath.trim()),
      preconditionMessage: 'Prompt and workspacePath are required before setup.',
    });

    const trivialTaskGate = resolveTrivialTaskGateConfig({
      enabled: config.enableTrivialTaskGate,
      maxPromptLength: config.trivialTaskMaxPromptLength,
    });
    const trivialClassification = classifyTrivialTaskPrompt(promptForRoutingAndEffort, trivialTaskGate);
    console.info(
      `[runner:${sessionId}] trivial-task-gate enabled=${trivialTaskGate.enabled} isTrivial=${trivialClassification.isTrivial} reasons=${trivialClassification.reasons.join(',')}`,
    );

    const trivialCommand = trivialClassification.isTrivial
      ? extractSingleCommandFromPrompt(promptForRoutingAndEffort)
      : undefined;

    if (trivialClassification.isTrivial && trivialCommand) {
      const t = iso();
      const llmStatus = makeLlmStatus('using-tools', 'Executing lightweight trivial command.', undefined, 'task', 'implementation');
      lastLlmStatusEmission = {
        key: llmStatusIdentityKey(llmStatus),
        emittedAt: parseTimestamp(llmStatus.updatedAt),
      };
      await emit({ time: t, type: 'session:llm-status-change', payload: { llmStatus } });

      const lightweightToolset = createAgentToolset({
        cwd: config.workspacePath,
        phase: 'implementation',
        taskType: 'custom',
        graphId: graph.id,
        taskId: 'task',
        provider: config.provider,
        model: config.model,
        adaptiveConcurrency: config.adaptiveConcurrency,
        batchConcurrency: config.batchConcurrency,
        batchMinConcurrency: config.batchMinConcurrency,
        commandEnv: sessionCommandEnv,
                resolveGithubToken: (resolveOptions) => githubAuthManager.resolveApiKey('github', resolveOptions),

      });

      const toolCallId = `lightweight-${randomUUID()}`;
      const toolCall: LlmToolCall = {
        id: toolCallId,
        name: 'run_command',
        arguments: { command: trivialCommand },
      };

      const started: Extract<DagEvent, { type: 'task:tool-call' }> = {
        type: 'task:tool-call',
        taskId: 'task',
        phase: 'implementation',
        attempt: 1,
        toolCallId,
        toolName: 'run_command',
        status: 'started',
        input: JSON.stringify({ command: trivialCommand }),
      };
      const startedUiEvent = toUiEvent(sessionId, started, t);
      if (startedUiEvent) {
        await emit({ time: t, type: 'session:dag-event', payload: { event: startedUiEvent } });
      }

      const toolResult = await lightweightToolset.executeTool(toolCall, controller.signal);
      const resultEvent: Extract<DagEvent, { type: 'task:tool-call' }> = {
        ...started,
        status: 'result',
        output: toolResult.content,
        isError: toolResult.isError,
      };
      const resultUiEvent = toUiEvent(sessionId, resultEvent, iso());
      if (resultUiEvent) {
        await emit({ time: iso(), type: 'session:dag-event', payload: { event: resultUiEvent } });
      }

      const outputText = toolResult.content;
      await emit({
        time: iso(),
        type: 'session:output-set',
        payload: { output: { text: outputText } },
      });

      await maybeCheckpoint('terminal');
      let deliveryError: string | undefined;
      try {
        await ensureRemoteDeliveryForCommittedSession();
      } catch (error) {
        deliveryError = errorMsg(error);
      }

      await enterLifecyclePhase('COMPLETING');

      if (toolResult.isError || deliveryError) {
        const errorLines = [toolResult.isError ? outputText : undefined, deliveryError ? `Remote delivery failed: ${deliveryError}` : undefined]
          .filter((line): line is string => Boolean(line));
        const errorText = errorLines.join('\n');
        await emit({ time: iso(), type: 'session:error-change', payload: { error: errorText } });
        const failedStatus = makeLlmStatus(
          'failed',
          errorText,
          toolResult.isError ? 'tool_runtime' : 'delivery_failure',
          'task',
          'implementation',
        );
        lastLlmStatusEmission = {
          key: llmStatusIdentityKey(failedStatus),
          emittedAt: parseTimestamp(failedStatus.updatedAt),
        };
        await emit({ time: iso(), type: 'session:llm-status-change', payload: { llmStatus: failedStatus } });
        await emit({ time: iso(), type: 'session:status-change', payload: { status: 'failed' } });
        await finalizeCheckpoint('failed', iso());
        await lifecycle.cleanup();
        await lifecycle.complete('FAILED');
        await emitLifecyclePhaseChange('FAILED');
        process.exit(1);
      }

      const completedStatus = makeLlmStatus('completed', 'Lightweight trivial command completed.', undefined, 'task', 'implementation');
      lastLlmStatusEmission = {
        key: llmStatusIdentityKey(completedStatus),
        emittedAt: parseTimestamp(completedStatus.updatedAt),
      };
      await emit({ time: iso(), type: 'session:llm-status-change', payload: { llmStatus: completedStatus } });
      await emit({ time: iso(), type: 'session:status-change', payload: { status: 'completed' } });
      await emit({
        time: iso(),
        type: 'session:chat-message',
        payload: { message: { role: 'assistant', content: outputText, time: iso() } },
      });
      await finalizeCheckpoint('completed', iso());
      await lifecycle.cleanup();
      await lifecycle.complete('COMPLETED');
      await emitLifecyclePhaseChange('COMPLETED');
      process.exit(0);
    }

    await enterLifecyclePhase('DISPATCHING', {
      precondition: () => {
        // Defense-in-depth: shell execution is only reachable when both the
        // source-aware guard and prompt command validation already succeeded.
        if (route.category === 'shell_command') {
          return Boolean(dispatch.shell.ok && dispatch.shell.command);
        }
        return Boolean(config.provider && config.model);
      },
      preconditionMessage: route.category === 'shell_command'
        ? 'Shell dispatch selected but no safe command was resolved.'
        : 'LLM dispatch requires provider/model configuration.',
    });

    await enterLifecyclePhase('EXECUTING');

        let outputs: Map<string, TaskOutput>;
    const planningAgentModel = resolveSessionRoleModel(config, 'planner');
    const implementationAgentModel = resolveSessionRoleModel(config, 'implementer');
        const testerAgentModel = resolveTesterModelConfig(config, testerAgentConfig, implementationAgentModel);
    if (route.category === 'shell_command') {
      const shellCommand = dispatch.shell.command;
      if (!shellCommand) {
        outputs = new Map([
          ['task', {
            taskId: 'task',
            status: 'failed',
            response: dispatch.shell.reason ?? 'Shell dispatch selected but no safe command was resolved.',
            durationMs: 0,
            retries: 0,
            error: 'shell_input_validation_failed',
          }],
        ]);
      } else {
        outputs = await runShellCommandRoute(shellCommand, config.workspacePath, sessionCommandEnv);
      }
    } else {
      outputs = await orchestrate(graph, {

      llm,
      cwd: config.workspacePath,
      planOutputDir: join(config.workspacePath, '.orchestrace', 'plans'),
      promptVersion: process.env.ORCHESTRACE_PROMPT_VERSION,
      policyVersion: process.env.ORCHESTRACE_POLICY_VERSION ?? DEFAULT_AGENT_TOOL_POLICY_VERSION,
      enableTrivialTaskGate: trivialTaskGate.enabled,
      trivialTaskMaxPromptLength: trivialTaskGate.maxPromptLength,
      defaultModel: implementationAgentModel,
      defaultPlanningModel: planningAgentModel,
      defaultImplementationModel: implementationAgentModel,
      defaultTesterModel: testerAgentModel,
      planningSystemPrompt: buildSystemPrompt(config, 'planning', taskEffort),
      implementationSystemPrompt: buildSystemPrompt(config, 'implementation', taskEffort),
      testerConfig: {
        enabled: testerAgentConfig.enabled,
        model: testerAgentModel,
        requireRunTests: testerAgentConfig.requireRunTests,
        enforceUiTestsForUiChanges: testerAgentConfig.enforceUiTestsForUiChanges,
        requireUiScreenshotsForUiChanges: testerAgentConfig.requireUiScreenshotsForUiChanges,
        minUiScreenshotCount: testerAgentConfig.minUiScreenshotCount,
        uiChangePatterns: testerAgentConfig.uiChangePatterns,
        uiTestCommandPatterns: testerAgentConfig.uiTestCommandPatterns,
      },
      quickStartMode,
      quickStartMaxPreDelegationToolCalls,
      planningNoToolGuardMode,
      taskEffort,
      maxParallel: 1,
      requirePlanApproval: !config.autoApprove,
      onPlanApproval: async (request) => {
        if (config.autoApprove) {
          return true;
        }

        const decision = await waitForPlanApprovalDecision({
          taskId: request.task.id,
          path: request.planPath,
        });

        const decisionAt = iso();
        if (decision.approved) {
          const resumedStatus = makeLlmStatus(
            'thinking',
            'Plan approved. Waiting for LLM response.',
            undefined,
            request.task.id,
            'planning',
          );
          if (shouldEmitLlmStatus(resumedStatus, lastLlmStatusEmission, decisionAt)) {
            lastLlmStatusEmission = {
              key: llmStatusIdentityKey(resumedStatus),
              emittedAt: parseTimestamp(decisionAt),
            };
            await emit({ time: decisionAt, type: 'session:llm-status-change', payload: { llmStatus: resumedStatus } });
          }
          await emit({ time: decisionAt, type: 'session:status-change', payload: { status: 'running' } });
          return true;
        }

        const rejectedStatus = makeLlmStatus(
          'idle',
          decision.note ?? 'Plan rejected. Waiting for user input.',
          'validation',
          request.task.id,
          'planning',
        );
        if (shouldEmitLlmStatus(rejectedStatus, lastLlmStatusEmission, decisionAt)) {
          lastLlmStatusEmission = {
            key: llmStatusIdentityKey(rejectedStatus),
            emittedAt: parseTimestamp(decisionAt),
          };
          await emit({ time: decisionAt, type: 'session:llm-status-change', payload: { llmStatus: rejectedStatus } });
        }
        await emit({ time: decisionAt, type: 'session:status-change', payload: { status: 'idle' } });
        return false;
      },
      signal: controller.signal,
      resolveApiKey: async (providerId) => authManager.resolveApiKey(providerId),

      createToolset: ({ role, phase, task, graphId, provider: activeProvider, model: activeModel, reasoning, taskRequiresWrites }) => createAgentToolset({
        cwd: config.workspacePath,
        phase,
        taskRequiresWrites,
        taskType: task.type,
        graphId,
        taskId: task.id,
        provider: activeProvider,
        model: activeModel,
        reasoning,
        adaptiveConcurrency: config.adaptiveConcurrency,
        batchConcurrency: config.batchConcurrency,
        batchMinConcurrency: config.batchMinConcurrency,
        commandEnv: sessionCommandEnv,
                resolveGithubToken: (resolveOptions) => githubAuthManager.resolveApiKey('github', resolveOptions),
        permissions: role === 'tester'
          ? {
              allowWriteTools: true,
              allowRunCommand: true,
              toolAllowlist: TESTER_TOOL_ALLOWLIST,
            }
          : undefined,

        sharedContextStore,
        fileReadCache,
        agentId: `orchestrator::${task.id}`,
        runSubAgent: role === 'tester' ? undefined : async (request, _signal) => {
          const subProvider = request.provider ?? activeProvider;
          const subModel = request.model ?? activeModel;
          const subTimeoutMs = resolveTimeoutMs('ORCHESTRACE_SUBAGENT_TIMEOUT_MS', 120_000);
          // Combine the session abort signal with a per-subagent hard timeout so that
          // a hung LLM connection (no response, no error) cannot block the runner forever.
          const subSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(subTimeoutMs)]);
          const toolCallId = `subagent-worker-${randomUUID()}`;
          const subPhase: 'planning' | 'implementation' = phase === 'planning' ? 'planning' : 'implementation';
          const subSystemPrompt = resolveSubAgentSystemPrompt(request);

          // Emit sub-agent started event
          emitSubAgentEvent(task.id, subPhase, toolCallId, 'started', {
            provider: subProvider, model: subModel, reasoning: request.reasoning ?? reasoning,
            nodeId: request.nodeId, prompt: request.prompt,
          });

          // Update graph node status directly (bypasses truncated DagEvent output)
          if (request.nodeId && agentGraph.length > 0) {
            if (setNodeStatus([request.nodeId], 'running')) {
              void emit({ time: iso(), type: 'session:agent-graph-set', payload: { graph: agentGraph } });
            }
          }

          const subToolset = createAgentToolset({
            cwd: config.workspacePath,
            phase,
            taskRequiresWrites,
            taskId: `${task.id}::subagent::${request.nodeId ?? toolCallId}`,
            taskType: task.type,
            graphId,
            provider: subProvider,
            model: subModel,
            reasoning: request.reasoning ?? reasoning,
            adaptiveConcurrency: config.adaptiveConcurrency,
            batchConcurrency: config.batchConcurrency,
            batchMinConcurrency: config.batchMinConcurrency,
                commandEnv: sessionCommandEnv,
                    resolveGithubToken: (resolveOptions) => githubAuthManager.resolveApiKey('github', resolveOptions),

            sharedContextStore,
            fileReadCache,
            agentId: `subagent::${task.id}::subagent::${request.nodeId ?? toolCallId}`,
          });

          try {
            const subAgent = await llm.spawnAgent({
              provider: subProvider,
              model: subModel,
              reasoning: request.reasoning ?? reasoning,
              timeoutMs: subTimeoutMs,
              systemPrompt: subSystemPrompt,
              signal: subSignal,
              toolset: subToolset,
                            apiKey: await authManager.resolveApiKey(subProvider),
              refreshApiKey: () => authManager.resolveApiKey(subProvider),
              allowAuthRefreshRetry: true,


            });

            const result = await completeWithRetry(subAgent, request.prompt, subSignal, {
              onAttemptStart: (subAttempt) => {
                const snapshotId = randomUUID();
                const promptText = request.prompt;
                const eventTime = iso();
                const llmContextEvent: Extract<DagEvent, { type: 'task:llm-context' }> = {
                  type: 'task:llm-context',
                  taskId: task.id,
                  phase: subPhase,
                  attempt: subAttempt,
                  snapshotId,
                  provider: subProvider,
                  model: subModel,
                  systemPrompt: subSystemPrompt,
                  prompt: promptText,
                };

                void emit({
                  time: eventTime,
                  type: 'session:llm-context',
                  payload: {
                    snapshotId,
                    phase: subPhase,
                    provider: subProvider,
                    model: subModel,
                    textChars: promptText.length,
                    imageCount: 0,
                    systemPrompt: subSystemPrompt,
                    promptText,
                  },
                });

                const uiEvent = toUiEvent(sessionId, llmContextEvent, eventTime);
                if (uiEvent) {
                  void emit({ time: eventTime, type: 'session:dag-event', payload: { event: uiEvent } });
                }
              },
            });
            const structured = buildStructuredResult(result);

            emitSubAgentEvent(task.id, subPhase, toolCallId, 'completed', {
              provider: subProvider, model: subModel, reasoning: request.reasoning ?? reasoning,
              nodeId: request.nodeId, prompt: request.prompt,
              outputText: structured.summary ?? result.text, usage: result.usage,
            });

            // Update graph node status directly (bypasses truncated DagEvent output)
            if (request.nodeId && agentGraph.length > 0) {
              if (setNodeStatus([request.nodeId], 'completed')) {
                void emit({ time: iso(), type: 'session:agent-graph-set', payload: { graph: agentGraph } });
              }
            }

            return structured;
          } catch (error) {
            const message = errorMsg(error);
            const classifiedFailure = classifySubAgentFailure(error);

            emitSubAgentEvent(task.id, subPhase, toolCallId, 'failed', {
              provider: subProvider, model: subModel, reasoning: request.reasoning ?? reasoning,
              nodeId: request.nodeId, prompt: request.prompt,
              error: message,
              failureType: classifiedFailure.failureType,
              recoverable: classifiedFailure.recoverable,
            });

            // Update graph node status directly (bypasses truncated DagEvent output)
            if (request.nodeId && agentGraph.length > 0) {
              if (setNodeStatus([request.nodeId], 'failed')) {
                void emit({ time: iso(), type: 'session:agent-graph-set', payload: { graph: agentGraph } });
              }
            }

            if (classifiedFailure.recoverable) {
              return {
                text: '',
                summary: `Recoverable sub-agent failure (${classifiedFailure.failureType}): ${message}`,
                risks: [
                  `Sub-agent execution ended with recoverable ${classifiedFailure.failureType} failure.`,
                  message,
                ],
              };
            }

            throw error;
          }
        },
      }),

      onEvent: (event) => {
        const t = iso();

        logDagEventTrace(sessionId, event);

        if (isThinkingCycleEvent(event)) {
          const shouldEmitNudge = updateThinkingCircuitBreaker(thinkingCircuitBreaker, event);
          if (shouldEmitNudge) {
            void emit({
              time: t,
              type: 'session:chat-message',
              payload: {
                message: {
                  role: 'system',
                  content: THINKING_CIRCUIT_BREAKER_NUDGE,
                  time: t,
                },
              },
            });
          }
        } else if (shouldResetThinkingCircuitBreakerOnEvent(event)) {
          resetThinkingCircuitBreaker(thinkingCircuitBreaker);
        }

        // LLM status
        const llmStatus = deriveLlmStatus(event, t);
        if (llmStatus && shouldEmitLlmStatus(llmStatus, lastLlmStatusEmission, t)) {
          lastLlmStatusEmission = {
            key: llmStatusIdentityKey(llmStatus),
            emittedAt: parseTimestamp(t),
          };
          void emit({ time: t, type: 'session:llm-status-change', payload: { llmStatus } });
        }

        // Stream deltas
        if (event.type === 'task:stream-delta') {
          void emit({ time: t, type: 'session:stream-delta', payload: { taskId: event.taskId, phase: event.phase, delta: event.delta, isReasoning: event.isReasoning } });
          return;
        }

        if (event.type === 'task:llm-context') {
          const promptText = typeof event.prompt === 'string' ? event.prompt : '';
          void emit({
            time: t,
            type: 'session:llm-context',
            payload: {
              snapshotId: event.snapshotId,
              phase: event.phase,
              provider: event.provider,
              model: event.model,
              textChars: promptText.length,
              imageCount: 0,
              systemPrompt: event.systemPrompt,
              promptText,
            },
          });
        }

        // Dag events
        const uiEvent = toUiEvent(sessionId, event, t);
        if (uiEvent) {
          void emit({ time: t, type: 'session:dag-event', payload: { event: uiEvent } });
        }

        if (event.type === 'task:testing') {
          const requiredSuites = event.uiTestsRequired
            ? 'unit + integration + e2e (Playwright)'
            : 'unit + integration';
          const plannerTestPlanPreview = (event.plannerTestPlan ?? [])
            .slice(0, 8)
            .map((item) => `- ${item}`);
          const changedFilePreview = (event.changedFiles ?? [])
            .slice(0, 8)
            .map((path) => `- ${path}`);
          const markerLines = [
            'Tester started.',
            `Task: ${event.taskId} (attempt ${event.attempt})`,
            `Required suites: ${requiredSuites}`,
            `UI changes detected: ${event.uiChangesDetected ? 'yes' : 'no'}`,
            plannerTestPlanPreview.length > 0
              ? `Planner test plan to execute:\n${plannerTestPlanPreview.join('\n')}`
              : 'Planner test plan to execute: (not explicitly extracted from approved plan)',
            changedFilePreview.length > 0
              ? `Changed files under test:\n${changedFilePreview.join('\n')}`
              : 'Changed files under test: (not provided)',
            event.uiTestsRequired ? 'Playwright and screenshot evidence are required for this attempt.' : '',
          ].filter((line) => line.length > 0);

          void emit({
            time: t,
            type: 'session:chat-message',
            payload: {
              message: {
                role: 'system',
                content: markerLines.join('\n'),
                time: t,
              },
            },
          });
        }

        if (event.type === 'task:tester-verdict') {
          const executedCommands = (event.executedTestCommands ?? [])
            .slice(0, 8)
            .map((command) => `- ${command}`);
          const screenshots = (event.screenshotPaths ?? [])
            .slice(0, 8)
            .map((path) => `- ${path}`);

          const summaryLines = [
            `Tester ${event.approved ? 'approved' : 'rejected'} this attempt.`,
            `Tests: passed=${event.testsPassed} failed=${event.testsFailed}`,
            `UI policy: required=${event.uiTestsRequired ? 'yes' : 'no'} ran=${event.uiTestsRun ? 'yes' : 'no'} screenshots=${event.screenshotPaths?.length ?? 0}`,
            event.coverageAssessment ? `Coverage: ${event.coverageAssessment}` : '',
            event.qualityAssessment ? `Quality: ${event.qualityAssessment}` : '',
            event.rejectionReason ? `Rejection reason: ${event.rejectionReason}` : '',
            executedCommands.length > 0 ? `Executed test commands:\n${executedCommands.join('\n')}` : 'Executed test commands: (none reported)',
            screenshots.length > 0 ? `Screenshot evidence:\n${screenshots.join('\n')}` : '',
          ].filter((line) => line.length > 0);

          void emit({
            time: t,
            type: 'session:chat-message',
            payload: {
              message: {
                role: 'system',
                content: summaryLines.join('\n'),
                time: t,
              },
            },
          });
        }

        // Checklist / graph from tool events (parsed from tool input)
        if (event.type === 'task:tool-call' && event.status === 'started') {
          void ensureCheckpointForMutatingBatch(event, t);
          if (event.input) {
            handleToolCallChecklist(event);
            handleToolCallAgentGraph(event);
          }
        }

        // Graph progress from sub-agent tool calls
        if (event.type === 'task:tool-call') {
          handleGraphProgress(event);

          if (event.status === 'result' && !event.isError && event.toolName === 'edit_file') {
            successfulEditFileResultsSinceCheckpoint += 1;
            if (successfulEditFileResultsSinceCheckpoint >= AUTO_CHECKPOINT_EVERY_N_EDITS) {
              void maybeCheckpoint('edit-threshold');
            }
          }
        }

        if (event.type === 'task:completed') {
          latestTesterVerdict = event.output.testerVerdict;
        }

        // Task status
        if ('taskId' in event && event.type !== 'task:tool-call' && event.type !== 'task:llm-context') {
          void emit({ time: t, type: 'session:task-status-change', payload: { taskId: event.taskId, taskStatus: event.type } });
        }

        if (event.type === 'task:approval-requested') {
          void emit({ time: t, type: 'session:status-change', payload: { status: 'idle' } });
        } else if (event.type === 'task:approved') {
          void emit({ time: t, type: 'session:status-change', payload: { status: 'running' } });
        }
            },
    });
    }

    if (cancelled) {

      await finalizeCheckpoint('cancelled', iso());
      await lifecycle.cleanup();
      await lifecycle.complete('CANCELLED');
      await emitLifecyclePhaseChange('CANCELLED');
      process.exit(130);
    }

    await enterLifecyclePhase('COMPLETING');

    // Completion
    const allOutputs = [...outputs.values()];
    const failedOutput = allOutputs.find((o) => o.status === 'failed');
    const primaryOutput = failedOutput ?? allOutputs[0];
    const failed = Boolean(failedOutput);
    const t = iso();

    const output = {
      text: primaryOutput?.response,
      planPath: primaryOutput?.planPath,
      failureType: failedOutput?.failureType,
    };

    resetThinkingCircuitBreaker(thinkingCircuitBreaker);
    await emit({ time: t, type: 'session:output-set', payload: { output } });
    await maybeCheckpoint('terminal');
    let deliveryError: string | undefined;
    try {
      await ensureRemoteDeliveryForCommittedSession();
    } catch (error) {
      deliveryError = errorMsg(error);
    }

    const terminalFailed = failed || Boolean(deliveryError);

    if (terminalFailed) {
      const error = [failedOutput?.error ?? (failed ? 'Execution failed' : undefined), deliveryError ? `Remote delivery failed: ${deliveryError}` : undefined]
        .filter((line): line is string => Boolean(line))
        .join('\n') || 'Execution failed';
      const failureType = failedOutput?.failureType ?? (deliveryError ? 'delivery_failure' : undefined);
      await emit({ time: t, type: 'session:error-change', payload: { error } });
      const llmStatus = makeLlmStatus(
        'failed',
        failureType ? `${failureType}: ${error}` : error,
        failureType,
      );
      lastLlmStatusEmission = {
        key: llmStatusIdentityKey(llmStatus),
        emittedAt: parseTimestamp(llmStatus.updatedAt),
      };
      await emit({ time: t, type: 'session:llm-status-change', payload: { llmStatus } });
      await emit({ time: t, type: 'session:status-change', payload: { status: 'failed' } });
    } else {
      const llmStatus = makeLlmStatus('completed', 'Run completed successfully.');
      lastLlmStatusEmission = {
        key: llmStatusIdentityKey(llmStatus),
        emittedAt: parseTimestamp(llmStatus.updatedAt),
      };
      await emit({ time: t, type: 'session:llm-status-change', payload: { llmStatus } });
      await emit({ time: t, type: 'session:status-change', payload: { status: 'completed' } });
    }

    await finalizeCheckpoint(terminalFailed ? 'failed' : 'completed', t);

    // Write assistant response as chat message
    if (primaryOutput?.response) {
      await emit({ time: t, type: 'session:chat-message', payload: { message: { role: 'assistant', content: primaryOutput.response, time: t } } });
    }

    await lifecycle.cleanup();
    if (terminalFailed) {
      await lifecycle.complete('FAILED');
      await emitLifecyclePhaseChange('FAILED');
    } else {
      await lifecycle.complete('COMPLETED');
      await emitLifecyclePhaseChange('COMPLETED');
    }

    process.exit(terminalFailed ? 1 : 0);
  } catch (error) {
    if (cancelled) {
      await markCheckpointInterrupted(iso(), 'Interrupted during cancellation path.');
      await lifecycle.cleanup();
      await lifecycle.complete('CANCELLED');
      await emitLifecyclePhaseChange('CANCELLED');
      process.exit(130);
    }

    const t = iso();
    const lifecyclePhase = lifecycle.phase;
    const lifecycleError = error instanceof SessionLifecycleError
      ? error
      : await lifecycle.failAt(lifecyclePhase, errorMsg(error), error);
    const errorText = formatLifecyclePhaseFailure(lifecycleError.phase, errorMsg(error));
    resetThinkingCircuitBreaker(thinkingCircuitBreaker);
    await maybeCheckpoint('terminal');
    let deliveryError: string | undefined;
    try {
      await ensureRemoteDeliveryForCommittedSession();
    } catch (deliveryFailure) {
      deliveryError = errorMsg(deliveryFailure);
    }
    const finalError = deliveryError
      ? `${errorText}\nRemote delivery failed: ${deliveryError}`
      : errorText;

    const cleanupErrors = lifecycle.diagnostics.cleanupErrors;
    const errorWithCleanup = appendCleanupErrors(finalError, cleanupErrors);

    await emit({ time: t, type: 'session:error-change', payload: { error: errorWithCleanup } });
    const llmStatus = makeLlmStatus('failed', errorWithCleanup, deliveryError ? 'delivery_failure' : lifecycleError.type);
    lastLlmStatusEmission = {
      key: llmStatusIdentityKey(llmStatus),
      emittedAt: parseTimestamp(llmStatus.updatedAt),
    };
    await emit({ time: t, type: 'session:llm-status-change', payload: { llmStatus } });
    await emit({ time: t, type: 'session:status-change', payload: { status: 'failed' } });
    await finalizeCheckpoint('failed', t);

    await lifecycle.cleanup();
    await lifecycle.complete('FAILED');
    await emitLifecyclePhaseChange('FAILED');

    process.exit(1);
  }

  // ---- Inline helpers (emit sub-agent events as dag events) ----

  function emitSubAgentEvent(
    taskId: string,
    phase: 'planning' | 'implementation',
    toolCallId: string,
    status: 'started' | 'completed' | 'failed',
    opts: {
      provider: string; model: string; reasoning?: string;
      nodeId?: string; prompt: string;
      outputText?: string; usage?: { input: number; output: number; cost: number };
      error?: string;
      failureType?: SubAgentFailureType;
      recoverable?: boolean;
    },
  ): void {
    const inputPayload = {
      nodeId: opts.nodeId, provider: opts.provider, model: opts.model, reasoning: opts.reasoning,
      promptChars: opts.prompt.length,
      promptPreview: compact(opts.prompt, SUBAGENT_WORKER_PROMPT_PREVIEW_MAX_CHARS),
    };

    const dagEvent: Extract<DagEvent, { type: 'task:tool-call' }> = {
      type: 'task:tool-call',
      taskId,
      phase,
      attempt: 1,
      toolCallId,
      toolName: 'subagent_worker',
      status: status === 'started' ? 'started' : 'result',
      input: status === 'started' ? JSON.stringify(inputPayload) : undefined,
      output: status === 'started' ? undefined : JSON.stringify({
        status, nodeId: opts.nodeId, provider: opts.provider, model: opts.model,
        promptChars: opts.prompt.length,
        usage: opts.usage ?? { input: 0, output: 0, cost: 0 },
        usageReported: Boolean(opts.usage),
        outputPreview: opts.outputText ? compact(opts.outputText, SUBAGENT_WORKER_OUTPUT_PREVIEW_MAX_CHARS) : undefined,
        error: opts.error,
        failureType: opts.failureType,
        recoverable: opts.recoverable,
      }),
      isError: status === 'failed',
    };

    const uiEvent = toUiEvent(sessionId, dagEvent, iso());
    if (uiEvent) {
      void emit({ time: iso(), type: 'session:dag-event', payload: { event: uiEvent } });
    }

    // LLM status
    const detail = status === 'started'
      ? (opts.nodeId ? `Running sub-agent ${opts.nodeId}.` : 'Running sub-agent.')
      : status === 'failed'
        ? (opts.nodeId ? `Sub-agent ${opts.nodeId} failed.` : 'Sub-agent failed.')
        : (opts.nodeId ? `Sub-agent ${opts.nodeId} completed.` : 'Sub-agent completed.');
    const llmStatus = makeLlmStatus('using-tools', detail, undefined, taskId, phase);
    if (shouldEmitLlmStatus(llmStatus, lastLlmStatusEmission, llmStatus.updatedAt)) {
      lastLlmStatusEmission = {
        key: llmStatusIdentityKey(llmStatus),
        emittedAt: parseTimestamp(llmStatus.updatedAt),
      };
      void emit({ time: iso(), type: 'session:llm-status-change', payload: { llmStatus } });
    }
  }

  // ---- Checklist from tool events ----

  function handleToolCallChecklist(event: Extract<DagEvent, { type: 'task:tool-call' }>): void {
    const toolName = event.toolName;
    if (toolName !== 'todo_set' && toolName !== 'todo_add' && toolName !== 'todo_update') return;
    const rawPayload = event.rawInput ?? event.input;
    if (!rawPayload) return;

    try {
      const args = JSON.parse(rawPayload) as Record<string, unknown>;
      if (!args || typeof args !== 'object') return;

      // For set/add, emit todos-set with the parsed items
      if (toolName === 'todo_set') {
        const rawItems = Array.isArray(args.items) ? args.items : [];
        const items = rawItems
          .filter((item: unknown) => item && typeof item === 'object')
          .map((item: unknown) => {
            const rec = item as Record<string, unknown>;
            const id = str(rec.id) || randomUUID();
            const title = str(rec.title) || `Todo ${id}`;
            const status = normalizeTodoStatus(rec.status) ?? 'todo';
            return {
              id, text: title, done: status === 'done', status,
              weight: typeof rec.weight === 'number' ? rec.weight : undefined,
              createdAt: iso(), updatedAt: iso(),
            };
          });
        void emit({ time: iso(), type: 'session:todos-set', payload: { items } });
      } else if (toolName === 'todo_add') {
        const id = str(args.id) || randomUUID();
        const title = str(args.title) || `Todo ${id}`;
        const status = normalizeTodoStatus(args.status) ?? 'todo';
        void emit({ time: iso(), type: 'session:todo-item-added', payload: {
          item: { id, text: title, done: status === 'done', status,
            weight: typeof args.weight === 'number' ? args.weight : undefined,
            createdAt: iso(), updatedAt: iso() },
        } });
      } else if (toolName === 'todo_update') {
        const id = str(args.id);
        if (!id) return;
        const status = normalizeTodoStatus(args.status);
        if (status) {
          void emit({ time: iso(), type: 'session:todo-item-toggled', payload: { itemId: id, done: status === 'done', status } });
          if (status === 'done') {
            if (!todoDoneCheckpointed.has(id)) {
              todoDoneCheckpointed.add(id);
              void maybeCheckpoint('todo-completed', { todoId: id, todoTitle: str(args.title) || undefined });
            }
          } else {
            todoDoneCheckpointed.delete(id);
          }
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  function handleToolCallAgentGraph(event: Extract<DagEvent, { type: 'task:tool-call' }>): void {
    if (event.toolName !== 'agent_graph_set' || (!event.rawInput && !event.input)) return;
    try {
      const args = JSON.parse(event.rawInput ?? event.input!) as Record<string, unknown>;
      if (!args || typeof args !== 'object') return;
      const nodes = normalizeGraphNodes(args.nodes);
      if (nodes.length === 0) return;
      // Update local state and emit
      agentGraph.length = 0;
      agentGraph.push(...nodes.map((n) => ({ ...n, status: 'pending' as const })));
      void emit({ time: iso(), type: 'session:agent-graph-set', payload: { graph: agentGraph } });
    } catch {
      // Ignore parse errors
    }
  }

  function handleGraphProgress(event: Extract<DagEvent, { type: 'task:tool-call' }>): void {
    if (event.toolName !== 'subagent_spawn' && event.toolName !== 'subagent_spawn_batch') return;
    if (agentGraph.length === 0) return;

    if (event.status === 'started' && event.input) {
      try {
        const input = JSON.parse(event.input) as Record<string, unknown>;
        const nodeIds = resolveNodeIds(agentGraph, event.toolName, input);
        if (nodeIds.length === 0) return;
        pendingNodeIds.set(event.toolCallId, nodeIds);
        if (setNodeStatus(nodeIds, 'running')) {
          void emit({ time: iso(), type: 'session:agent-graph-set', payload: { graph: agentGraph } });
        }
      } catch { /* ignore */ }
      return;
    }

    if (event.status !== 'result') return;
    const ids = pendingNodeIds.get(event.toolCallId) ?? [];
    pendingNodeIds.delete(event.toolCallId);

    if (event.toolName === 'subagent_spawn') {
      if (ids.length > 0) {
        const terminal: 'completed' | 'failed' = event.isError ? 'failed' : 'completed';
        if (setNodeStatus(ids, terminal)) {
          void emit({ time: iso(), type: 'session:agent-graph-set', payload: { graph: agentGraph } });
        }
      }
      return;
    }

    // batch
    let batchParsed = false;
    if (event.output) {
      try {
        const parsed = JSON.parse(event.output) as Record<string, unknown>;
        const runs = Array.isArray(parsed.runs) ? parsed.runs : [];
        let changed = false;
        for (const run of runs) {
          if (!run || typeof run !== 'object') continue;
          const r = run as Record<string, unknown>;
          const nid = str(r.nodeId);
          const st = str(r.status);
          if (nid && (st === 'completed' || st === 'failed')) {
            changed = setNodeStatus([nid], st) || changed;
          }
        }
        if (changed) void emit({ time: iso(), type: 'session:agent-graph-set', payload: { graph: agentGraph } });
        batchParsed = runs.length > 0;
      } catch { /* output may be truncated by formatToolPayload — fall through */ }
    }
    if (!batchParsed && ids.length > 0) {
      const terminal: 'completed' | 'failed' = event.isError ? 'failed' : 'completed';
      if (setNodeStatus(ids, terminal)) {
        void emit({ time: iso(), type: 'session:agent-graph-set', payload: { graph: agentGraph } });
      }
    }
  }

  function setNodeStatus(nodeIds: string[], status: 'running' | 'completed' | 'failed'): boolean {
    let changed = false;
    const targets = new Set(nodeIds);
    for (let i = 0; i < agentGraph.length; i++) {
      if (targets.has(agentGraph[i].id) && agentGraph[i].status !== status) {
        agentGraph[i] = { ...agentGraph[i], status };
        changed = true;
      }
    }
    return changed;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function iso(): string {
  return new Date().toISOString();
}

function errorMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  return '';
}

function compact(text: string, maxChars: number): string {
  const c = text.replace(/\s+/g, ' ').trim();
  return c.length <= maxChars ? c : `${c.slice(0, Math.max(0, maxChars - 3))}...`;
}

interface ParsedGitHubRemote {
  host: string;
  owner: string;
  repo: string;
}

function parseGitHubRemote(remoteUrl: string): ParsedGitHubRemote | undefined {
  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return undefined;
  }

  const sshMatch = trimmed.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    return normalizeGitHubRemote(sshMatch[1], sshMatch[2]);
  }

  const sshProtocolMatch = trimmed.match(/^ssh:\/\/git@([^/]+)\/(.+)$/);
  if (sshProtocolMatch) {
    return normalizeGitHubRemote(sshProtocolMatch[1], sshProtocolMatch[2]);
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return normalizeGitHubRemote(parsed.hostname, parsed.pathname.replace(/^\/+/, ''));
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function normalizeGitHubRemote(host: string, path: string): ParsedGitHubRemote | undefined {
  const cleanHost = host.trim().toLowerCase();
  const cleanPath = path.trim().replace(/\.git$/, '').replace(/^\/+/, '');
  const parts = cleanPath.split('/').filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }

  return {
    host: cleanHost,
    owner: parts[0],
    repo: parts[1],
  };
}

function buildGitHubApiBaseUrl(host: string): string {
  const normalizedHost = host.trim().toLowerCase();
  if (normalizedHost === 'github.com') {
    return 'https://api.github.com';
  }
  return `https://${normalizedHost}/api/v3`;
}

function formatGitHubApiError(response: GitHubApiResponse): string {
  const statusPart = `HTTP ${response.status}`;
  if (response.body && typeof response.body === 'object' && !Array.isArray(response.body)) {
    const body = response.body as Record<string, unknown>;
    const message = typeof body.message === 'string' ? body.message : undefined;
    if (message) {
      const hint = response.retryAfterMs !== undefined
        ? ` (rate limited; retry after ${Math.ceil(response.retryAfterMs / 1000)}s)`
        : '';
      return `${statusPart}: ${message}${hint}`;
    }
  }

  if (typeof response.body === 'string' && response.body.trim()) {
    return `${statusPart}: ${response.body.trim()}`;
  }

  return statusPart;
}

function previewToolPayload(value: string | undefined): string {
  return sanitizeToolPayload(value, { maxLength: TOOL_EVENT_PREVIEW_MAX_CHARS });
}

function stringifyTracePayload(value: string): string {
  return stringifySanitizedTracePayload(value);
}

function resolvePositiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function resolveBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return fallback;
}

function resolveSessionDeliveryStrategy(raw: unknown): 'pr-only' | 'merge-after-ci' {
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'merge-after-ci') {
    return 'merge-after-ci';
  }
  return 'pr-only';
}

export function formatSessionDeliveryMessage(params: {
  branchName: string;
  prNumber: number;
  prUrl: string;
  prCreated: boolean;
  deliveryStrategy: 'pr-only' | 'merge-after-ci';
  alreadyMerged?: boolean;
}): string {
  if (params.deliveryStrategy === 'merge-after-ci') {
    return params.prCreated
      ? `Committed session changes were validated, pushed to origin/${params.branchName}, PR #${params.prNumber} was created, GitHub CI checks passed, and PR #${params.prNumber} was merged${params.alreadyMerged ? ' (already merged)' : ''}: ${params.prUrl}`
      : `Committed session changes were validated, pushed to origin/${params.branchName}, existing PR #${params.prNumber} was reused, GitHub CI checks passed, and PR #${params.prNumber} was merged${params.alreadyMerged ? ' (already merged)' : ''}: ${params.prUrl}`;
  }

  return params.prCreated
    ? `Committed session changes were validated, pushed to origin/${params.branchName}, PR #${params.prNumber} was created, and GitHub CI checks passed: ${params.prUrl}`
    : `Committed session changes were validated, pushed to origin/${params.branchName}, existing PR #${params.prNumber} was reused, and GitHub CI checks passed: ${params.prUrl}`;
}

function appendTesterEvidenceToPrDescription(
  description: string,
  verdict: NonNullable<TaskOutput['testerVerdict']>,
): string {
  const header = '## Test Validation';
  if (description.includes(header)) {
    return description;
  }

  const lines: string[] = [
    description.trim(),
    '',
    header,
    '',
    verdict.approved
      ? 'Tester agent approved this changeset after executing tests.'
      : 'Tester agent rejected this changeset during test validation.',
    '',
    `- Tests passed: ${verdict.testsPassed}`,
    `- Tests failed: ${verdict.testsFailed}`,
  ];

  if (verdict.rejectionReason) {
    lines.push(`- Rejection reason: ${verdict.rejectionReason}`);
  }

  if (verdict.suggestedFixes && verdict.suggestedFixes.length > 0) {
    lines.push('- Suggested fixes:');
    for (const fix of verdict.suggestedFixes) {
      lines.push(`  - ${fix}`);
    }
  }

  lines.push('', '<details>', '<summary>Tester command output</summary>', '', '```text');
  lines.push(verdict.testOutput || '(no tester output captured)');
  lines.push('```', '', '</details>', '');

  if (verdict.coverageAssessment) {
    lines.push('- Coverage assessment:');
    lines.push(`  ${verdict.coverageAssessment}`);
  }

  if (verdict.qualityAssessment) {
    lines.push('- Quality assessment:');
    lines.push(`  ${verdict.qualityAssessment}`);
  }

  if (verdict.testPlan.length > 0) {
    lines.push('- Test plan executed:');
    for (const planItem of verdict.testPlan) {
      lines.push(`  - ${planItem}`);
    }
  }

  if (verdict.testedAreas.length > 0) {
    lines.push('- Tested areas:');
    lines.push(`  ${verdict.testedAreas.join(', ')}`);
  }

  if (verdict.executedTestCommands.length > 0) {
    lines.push('- Executed test commands:');
    for (const command of verdict.executedTestCommands) {
      lines.push(`  - ${command}`);
    }
  }

  lines.push('- UI validation policy:');
  lines.push(`  uiChangesDetected=${verdict.uiChangesDetected}`);
  lines.push(`  uiTestsRequired=${verdict.uiTestsRequired}`);
  lines.push(`  uiTestsRun=${verdict.uiTestsRun}`);

  if (verdict.screenshotPaths.length > 0) {
    lines.push('- UI screenshots:');
    for (const screenshotPath of verdict.screenshotPaths) {
      lines.push(`  - ${screenshotPath}`);
    }

    lines.push('', '<details>', '<summary>UI Snapshot Evidence</summary>', '');
    verdict.screenshotPaths.forEach((screenshotPath, index) => {
      const normalizedPath = screenshotPath.replace(/\\/g, '/');
      lines.push(`![UI snapshot ${index + 1}](${normalizedPath})`);
      lines.push('');
    });
    lines.push('</details>', '');
  }

  return lines.join('\n').trim();
}

function logDagEventTrace(sessionId: string, event: DagEvent): void {
  const taskId = 'taskId' in event ? event.taskId : undefined;
  const phase = 'phase' in event ? event.phase : undefined;
  const taskPart = taskId ? ` task=${taskId}` : '';
  const phasePart = phase ? ` phase=${phase}` : '';

  if (event.type === 'task:stream-delta') {
    if (TRACE_LOG_STREAM_DELTAS) {
      const deltaPreview = sanitizeToolPayload(event.delta, { maxLength: 180 });
      console.info(
        `[trace:${sessionId}] stream task=${event.taskId} phase=${event.phase} deltaPreview=${stringifyTracePayload(deltaPreview)}`,
      );
    }
    return;
  }

  if (event.type === 'task:tool-call') {
    const direction = event.status === 'started' ? 'input' : 'output';
    const payload = event.status === 'started' ? event.input : event.output;
    const errorSuffix = event.isError ? ' [error]' : '';
    const payloadPreview = sanitizeToolPayload(payload, { maxLength: 220 });
    console.info(
      `[trace:${sessionId}] tool task=${event.taskId} name=${event.toolName} direction=${direction}${errorSuffix} payloadPreview=${stringifyTracePayload(payloadPreview)}`,
    );
    return;
  }

  console.info(`[trace:${sessionId}] dag type=${event.type}${taskPart}${phasePart}`);
}

function makeLlmStatus(
  state: LlmSessionState,
  detail?: string,
  failureType?: string,
  taskId?: string,
  phase?: 'planning' | 'implementation' | 'testing',
): SessionLlmStatus {
  const labels: Record<string, string> = {
    queued: 'Queued', analyzing: 'Analyzing', thinking: 'Waiting for LLM', planning: 'Planning',
    'awaiting-approval': 'Awaiting Approval', idle: 'Idle', implementing: 'Implementing',
    'using-tools': 'Waiting for Tool', validating: 'Validating', retrying: 'Retrying',
    completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
  };
  return { state, label: labels[state] ?? 'Queued', detail, failureType, taskId, phase, updatedAt: iso() };
}

function deriveLlmStatus(event: DagEvent, t: string): SessionLlmStatus | undefined {
  const waitingForLlm = (
    taskId: string,
    phase: 'planning' | 'implementation' | 'testing',
    detail = 'Waiting for LLM response.',
  ) => makeLlmStatus('thinking', detail, undefined, taskId, phase);

  switch (event.type) {
    case 'task:ready':
    case 'task:started':
    case 'task:planning':
      return waitingForLlm(event.taskId, 'planning');
    case 'task:stream-delta':
      return waitingForLlm(event.taskId, event.phase);
    case 'task:plan-persisted':
      return waitingForLlm(event.taskId, 'planning');
    case 'task:approval-requested':
      return makeLlmStatus('idle', 'Waiting for your input: approve or reject the plan.', undefined, event.taskId, 'planning');
    case 'task:approved':
      return waitingForLlm(event.taskId, 'implementation', 'Plan approved. Waiting for LLM response.');
    case 'task:implementation-attempt':
      return waitingForLlm(event.taskId, 'implementation');
    case 'task:testing':
      return waitingForLlm(event.taskId, 'testing');
    case 'task:tester-verdict':
      return event.approved
        ? waitingForLlm(event.taskId, 'testing')
        : waitingForLlm(
          event.taskId,
          'testing',
          `Tester rejected (passed=${event.testsPassed}, failed=${event.testsFailed}). Waiting for LLM response.`,
        );
    case 'task:tool-call':
      return event.status === 'started'
        ? makeLlmStatus('using-tools', `Waiting for tool execution: ${event.toolName}.`, undefined, event.taskId, event.phase)
        : undefined;
    case 'task:validating':
      return waitingForLlm(event.taskId, 'implementation');
    case 'task:verification-failed':
      return waitingForLlm(event.taskId, 'implementation', `Verification failed on attempt ${event.attempt}. Waiting for LLM response.`);
    case 'task:retrying':
      return waitingForLlm(event.taskId, 'implementation', `Retrying (${event.attempt}/${event.maxRetries}). Waiting for LLM response.`);
    case 'task:completed':
    case 'graph:completed':
      return makeLlmStatus('completed', 'Run completed successfully.', undefined, 'taskId' in event ? event.taskId : undefined, 'implementation');
    case 'task:failed':
    case 'graph:failed':
      return makeLlmStatus(
        'failed',
        event.type === 'task:failed'
          ? `${event.failureType ? `${event.failureType}: ` : ''}${event.error} (attempt ${event.attempt}/${event.maxRetries + 1}, ${event.totalDurationMs}ms elapsed)`
          : event.error,
        event.type === 'task:failed' ? event.failureType : undefined,
        'taskId' in event ? event.taskId : undefined,
      );
    default:
      return undefined;
  }
}

function toUiEvent(
  runId: string,
  event: DagEvent,
  t: string,
): {
  time: string;
  runId: string;
  type: string;
  taskId?: string;
  failureType?: string;
  attempt?: number;
  maxRetries?: number;
  totalDurationMs?: number;
  testsPassed?: number;
  testsFailed?: number;
  rejectionReason?: string;
  planPath?: string;
  plannerTestPlan?: string[];
  changedFiles?: string[];
  testPlan?: string[];
  coverageAssessment?: string;
  qualityAssessment?: string;
  testedAreas?: string[];
  executedTestCommands?: string[];
  uiChangesDetected?: boolean;
  uiTestsRequired?: boolean;
  uiTestsRun?: boolean;
  screenshotsRequired?: boolean;
  screenshotPaths?: string[];
  toolName?: string;
  toolStatus?: 'started' | 'result';
  toolCallId?: string;
  toolInput?: string;
  toolOutput?: string;
  toolIsError?: boolean;
  toolDetails?: unknown;
  llmContextSnapshotId?: string;
  llmContextPhase?: 'chat' | 'planning' | 'implementation';
  llmContextProvider?: string;
  llmContextModel?: string;
  llmContextTextChars?: number;
  llmContextImageCount?: number;
  message: string;
} | undefined {

    const base = {
    time: t,
    runId,
    type: event.type,
    taskId: 'taskId' in event ? event.taskId : undefined,
    failureType: event.type === 'task:failed' ? event.failureType : undefined,
    attempt: event.type === 'task:failed' ? event.attempt : undefined,
    maxRetries: event.type === 'task:failed' ? event.maxRetries : undefined,
    totalDurationMs: event.type === 'task:failed' ? event.totalDurationMs : undefined,
    testsPassed: event.type === 'task:tester-verdict' ? event.testsPassed : undefined,
    testsFailed: event.type === 'task:tester-verdict' ? event.testsFailed : undefined,
    rejectionReason: event.type === 'task:tester-verdict' ? event.rejectionReason : undefined,
    planPath: event.type === 'task:plan-persisted' ? event.path : undefined,
    plannerTestPlan: event.type === 'task:testing' ? event.plannerTestPlan : undefined,
    changedFiles: event.type === 'task:testing' ? event.changedFiles : undefined,
    testPlan: event.type === 'task:tester-verdict' ? event.testPlan : undefined,
    coverageAssessment: event.type === 'task:tester-verdict' ? event.coverageAssessment : undefined,
    qualityAssessment: event.type === 'task:tester-verdict' ? event.qualityAssessment : undefined,
    testedAreas: event.type === 'task:tester-verdict' ? event.testedAreas : undefined,
    executedTestCommands: event.type === 'task:tester-verdict' ? event.executedTestCommands : undefined,
    uiChangesDetected:
      event.type === 'task:testing'
      ? event.uiChangesDetected
      : event.type === 'task:tester-verdict'
        ? event.uiChangesDetected
        : undefined,
    uiTestsRequired:
      event.type === 'task:testing'
      ? event.uiTestsRequired
      : event.type === 'task:tester-verdict'
        ? event.uiTestsRequired
        : undefined,
    uiTestsRun: event.type === 'task:tester-verdict' ? event.uiTestsRun : undefined,
    screenshotsRequired: event.type === 'task:testing' ? event.screenshotsRequired : undefined,
    screenshotPaths: event.type === 'task:tester-verdict' ? event.screenshotPaths : undefined,
    toolName: event.type === 'task:tool-call' ? event.toolName : undefined,
    toolStatus: event.type === 'task:tool-call' ? event.status : undefined,
    toolCallId: event.type === 'task:tool-call' ? event.toolCallId : undefined,
    toolInput: event.type === 'task:tool-call' ? event.input : undefined,
    toolOutput: event.type === 'task:tool-call' ? event.output : undefined,
    toolIsError: event.type === 'task:tool-call' ? event.isError : undefined,
    toolDetails: event.type === 'task:tool-call' ? event.details : undefined,
    llmContextSnapshotId: event.type === 'task:llm-context' ? event.snapshotId : undefined,
    llmContextPhase: event.type === 'task:llm-context' ? event.phase : undefined,
    llmContextProvider: event.type === 'task:llm-context' ? event.provider : undefined,
    llmContextModel: event.type === 'task:llm-context' ? event.model : undefined,
    llmContextTextChars: event.type === 'task:llm-context' ? event.prompt.length : undefined,
    llmContextImageCount: event.type === 'task:llm-context' ? 0 : undefined,
  };

  const tag = (msg: string) => `[run:${runId}] ${msg}`;

  switch (event.type) {
    case 'task:planning': return { ...base, message: tag(`${event.taskId}: planning`) };
    case 'task:plan-persisted': return { ...base, message: tag(`${event.taskId}: plan persisted at ${event.path}`) };
    case 'task:approval-requested': return { ...base, message: tag(`${event.taskId}: approval requested`) };
    case 'task:approved': return { ...base, message: tag(`${event.taskId}: approved`) };
    case 'task:implementation-attempt': return { ...base, message: tag(`${event.taskId}: implementation attempt ${event.attempt}/${event.maxAttempts}`) };
    case 'task:testing': {
      const policyNote = event.uiTestsRequired
        ? ' (UI changes detected; UI tests required)'
        : '';
      return { ...base, message: tag(`${event.taskId}: tester gate attempt ${event.attempt}${policyNote}`) };
    }
    case 'task:tester-verdict':
      return {
        ...base,
        message: tag(
          `${event.taskId}: tester ${event.approved ? 'approved' : 'rejected'} `
          + `(passed=${event.testsPassed}, failed=${event.testsFailed})`
          + (event.uiTestsRequired
            ? ` uiTests=${event.uiTestsRun ? 'ran' : 'missing'} screenshots=${event.screenshotPaths?.length ?? 0}`
            : '')
          + (event.rejectionReason ? ` reason=${event.rejectionReason}` : ''),
        ),
      };
    case 'task:tool-call': {
      if (event.status === 'started') {
        return { ...base, message: tag(`${event.taskId}: tool ${event.toolName} input ${previewToolPayload(event.input)}`) };
      }
      const err = event.isError ? ' [error]' : '';
      return { ...base, message: tag(`${event.taskId}: tool ${event.toolName} output${err} ${previewToolPayload(event.output)}`) };
    }
    case 'task:llm-context':
      return {
        ...base,
        type: 'session:llm-context',
        message: tag(
          `${event.taskId}: llm context snapshot ${event.snapshotId} (${event.prompt.length} chars, provider=${event.provider}, model=${event.model}, phase=${event.phase})`,
        ),
      };
    case 'task:verification-failed': return { ...base, message: tag(`${event.taskId}: verification failed`) };
    case 'task:ready': return { ...base, message: tag(`${event.taskId}: ready`) };
    case 'task:started': return { ...base, message: tag(`${event.taskId}: started`) };
    case 'task:validating': return { ...base, message: tag(`${event.taskId}: validating`) };
    case 'task:completed': return { ...base, message: tag(`${event.taskId}: completed`) };
    case 'task:failed': return {
      ...base,
      message: tag(
        `${event.taskId}: failed${event.failureType ? ` [${event.failureType}]` : ''} (${event.error}) attempt ${event.attempt}/${event.maxRetries + 1}, elapsed ${event.totalDurationMs}ms`,
      ),
    };
    case 'graph:completed': return { ...base, message: tag(`graph completed (${event.outputs.size} outputs)`) };
    case 'graph:failed': return { ...base, message: tag(`graph failed (${event.error})`) };
    case 'task:retrying': return { ...base, message: tag(`${event.taskId}: retrying ${event.attempt}/${event.maxRetries}`) };
    default: return undefined;
  }
}

function buildSingleTaskGraph(id: string, prompt: string, routeCategory: TaskRouteCategory = 'code_change'): TaskGraph {
  const commands = parseAndSanitizeVerifyCommands(process.env.ORCHESTRACE_VERIFY_COMMANDS);
  const nodeType = routeCategory === 'refactor' ? 'refactor' : 'code';
  const validationCommands = routeCategory === 'investigation' ? [] : commands;

  return {
    id: `ui-${id}`,
    name: 'UI Work Session',
    nodes: [{
      id: 'task',
      name: 'Execute UI prompt',
      type: nodeType,
      prompt,
      dependencies: [],
      validation: { commands: validationCommands, maxRetries: 2, retryDelayMs: 0 },
      meta: { routeCategory },
    }],
  };
}

export async function runShellCommandWithTimeoutWithDeps(
  command: string,
  cwd: string,
  timeout: number,
  deps: RunnerShellExecutionDependencies,
  commandEnv?: Record<string, string>,
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  const validation = validateShellInput(command);
  if (!validation.ok || !validation.parsed) {
    deps.logError(formatShellValidationRejection('runner.runShellCommandWithTimeout', validation.reason));
    return {
      ok: false,
      stdout: '',
      stderr: '',
      error: validation.reason ?? 'shell_input_validation_failed',
    };
  }

  try {
    const { stdout, stderr } = await deps.execFile(validation.parsed.program, validation.parsed.args, {
      cwd,
      timeout,
      maxBuffer: 5 * 1024 * 1024,
      env: commandEnv ? { ...process.env, ...commandEnv } : undefined,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const typed = err as ExecFileException;
    return {
      ok: false,
      stdout: typeof typed.stdout === 'string' ? typed.stdout : '',
      stderr: typeof typed.stderr === 'string' ? typed.stderr : '',
      error: errorMsg(err),
    };
  }
}

export async function runShellCommandRouteWithDeps(
  command: string,
  cwd: string,
  deps: RunnerShellExecutionDependencies,
  commandEnv?: Record<string, string>,
): Promise<Map<string, TaskOutput>> {
  const startedAt = Date.now();
  const validation = validateShellInput(command);

  if (!validation.ok || !validation.parsed) {
    deps.logError(formatShellValidationRejection('runner.runShellCommandRoute', validation.reason));
    return new Map([
      ['task', {
        taskId: 'task',
        status: 'failed',
        response: validation.reason,
        durationMs: Date.now() - startedAt,
        retries: 0,
        error: 'shell_input_validation_failed',
      }],
    ]);
  }

  try {
    const { stdout, stderr } = await deps.execFile(validation.parsed.program, validation.parsed.args, {
      cwd,
      env: commandEnv ? { ...process.env, ...commandEnv } : undefined,
    });
    const text = `${stdout ?? ''}${stderr ?? ''}`.trim();
    return new Map([
      ['task', {
        taskId: 'task',
        status: 'completed',
        response: text || `Command executed: ${validation.command}`,
        durationMs: Date.now() - startedAt,
        retries: 0,
      }],
    ]);
  } catch (error) {
    const err = error as ExecFileException;
    const details = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    return new Map([
      ['task', {
        taskId: 'task',
        status: 'failed',
        response: details || undefined,
        durationMs: Date.now() - startedAt,
        retries: 0,
        error: err.message,
      }],
    ]);
  }
}

async function runShellCommandRoute(
  command: string,
  cwd: string,
  commandEnv?: Record<string, string>,
): Promise<Map<string, TaskOutput>> {
  return runShellCommandRouteWithDeps(command, cwd, defaultRunnerShellExecutionDependencies, commandEnv);
}


export function assessGitHubStatusCheckRollup(rollup: unknown): {
  total: number;
  passing: number;
  pending: number;
  failing: number;
} {
  if (!Array.isArray(rollup)) {
    return { total: 0, passing: 0, pending: 0, failing: 0 };
  }

  let passing = 0;
  let pending = 0;
  let failing = 0;
  const passingConclusions = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
  const failingConclusions = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'STALE', 'ACTION_REQUIRED']);

  for (const entry of rollup) {
    if (!entry || typeof entry !== 'object') {
      pending += 1;
      continue;
    }

    const record = entry as Record<string, unknown>;
    const typeName = typeof record.__typename === 'string' ? record.__typename : '';

    if (typeName === 'CheckRun') {
      const status = typeof record.status === 'string' ? record.status.toUpperCase() : '';
      const conclusion = typeof record.conclusion === 'string' ? record.conclusion.toUpperCase() : '';
      if (status && status !== 'COMPLETED') {
        pending += 1;
      } else if (passingConclusions.has(conclusion)) {
        passing += 1;
      } else if (failingConclusions.has(conclusion)) {
        failing += 1;
      } else {
        pending += 1;
      }
      continue;
    }

    if (typeName === 'StatusContext') {
      const state = typeof record.state === 'string' ? record.state.toUpperCase() : '';
      if (state === 'SUCCESS') {
        passing += 1;
      } else if (state === 'FAILURE' || state === 'ERROR') {
        failing += 1;
      } else {
        pending += 1;
      }
      continue;
    }

    pending += 1;
  }

  return {
    total: rollup.length,
    passing,
    pending,
    failing,
  };
}

function buildSessionCommandEnvFromTestingPorts(
  ports: SessionConfig['testingPorts'],
): Record<string, string> | undefined {
  if (!ports) {
    return undefined;
  }

  const basePort = Number.isFinite(ports.basePort) ? Math.floor(ports.basePort) : NaN;
  const apiPort = Number.isFinite(ports.apiPort) ? Math.floor(ports.apiPort) : NaN;
  const uiPort = Number.isFinite(ports.uiPort) ? Math.floor(ports.uiPort) : NaN;
  if (basePort <= 0 || apiPort <= 0 || uiPort <= 0) {
    return undefined;
  }

  return {
    ORCHESTRACE_PORT_BASE: String(basePort),
    ORCHESTRACE_API_PORT: String(apiPort),
    ORCHESTRACE_UI_PORT: String(uiPort),
    PORT: String(apiPort),
    VITE_PORT: String(uiPort),
    PLAYWRIGHT_BASE_URL: `http://127.0.0.1:${uiPort}`,
  };
}

function resolveSessionRoleModel(config: SessionConfig, role: 'planner' | 'implementer'): {
  provider: string;
  model: string;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
} {
  const roleConfig = role === 'planner' ? config.agentModels?.planner : config.agentModels?.implementer;
  const legacyProvider = role === 'planner' ? config.planningProvider : config.implementationProvider;
  const legacyModel = role === 'planner' ? config.planningModel : config.implementationModel;

  const provider = roleConfig?.provider?.trim() || legacyProvider?.trim() || config.provider;
  const model = roleConfig?.model?.trim() || legacyModel?.trim() || config.model;

  return {
    provider,
    model,
    ...(roleConfig?.reasoning ? { reasoning: roleConfig.reasoning } : {}),
  };
}

function resolveTesterModelConfig(
  config: SessionConfig,
  testerConfig: TesterAgentConfig,
  fallback: {
    provider: string;
    model: string;
    reasoning?: 'minimal' | 'low' | 'medium' | 'high';
  },
): {
  provider: string;
  model: string;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
} {
  const provider = testerConfig.provider.trim() || fallback.provider || config.provider;
  const model = testerConfig.model.trim() || fallback.model || config.model;

  return {
    provider,
    model,
    ...(testerConfig.reasoning ? { reasoning: testerConfig.reasoning } : {}),
  };
}

function buildSystemPrompt(config: SessionConfig, phase: 'planning' | 'implementation', effort: TaskEffort = 'high'): string {
  const isLowEffort = effort === 'trivial' || effort === 'low';

  const phaseRules = phase === 'planning'
    ? [
      'Create an implementation plan scaled to the task complexity.',
      'Do not perform direct code edits in planning mode.',
      'While thinking, stream concise rationale updates explaining what you are deciding and why.',
      'Rationale updates must be user-facing, factual, and short.',
      'Each planned task must include explicit done criteria and a verification command.',
      'Planning must produce todo_set and agent_graph_set state.',
      'todo_set items must include numeric weight values and the total todo weight must sum to 100.',
      'agent_graph_set nodes must include numeric weight values and the total node weight must sum to 100.',
      '',
      '## Sub-agent delegation (your choice)',
      'subagent_spawn / subagent_spawn_batch are available for delegating focused research and investigation.',
      'YOU decide whether and how many sub-agents to use based on the task scope:',
      '- Simple tasks: skip sub-agents, do the investigation yourself',
      '- Moderate tasks: 1-2 sub-agents for focused parallel research if it helps',
      '- Complex tasks: spawn as many sub-agents as needed to cover independent investigation areas',
      'When using sub-agents, prefer subagent_spawn_batch for independent parallel work.',
      'When using sub-agents, pass nodeId referencing agent_graph_set nodes so progress tracking works.',
      'Keep parent orientation lightweight and push detailed file reading/search into sub-agent scopes when you do delegate.',
      '',
      `Task effort: ${effort}. Scale planning depth accordingly.`,
      'Do not ask the user to continue after partial progress; continue autonomously until completion or a concrete blocker is reached.',
      'For transient tool or sub-agent failures (timeouts, aborts, rate limits), retry automatically before surfacing a blocker.',
    ]
    : [
            'Execute approved work with minimal, scoped edits and verify outcomes.',
      'Read before editing, and use tool output to adapt after failures.',
            'Always apply relevant guidance from best-practices/ when implementing (you must consult matching guide(s) before edits when relevant).',
      'Before making edits, read best-practices/README.md and the relevant guide file(s) under best-practices/*.md for the technologies you touch.',
      'While thinking, stream concise rationale updates explaining what you are doing and why.',
      'Rationale updates must be user-facing, factual, and short.',
      ...(isLowEffort
        ? []
        : [
          'Read todo_get and agent_graph_get before coding, then keep todo_update current while implementing.',
        ]),
      '',
      '## Sub-agent delegation (your choice)',
      'subagent_spawn / subagent_spawn_batch are available for parallel implementation.',
      'YOU decide whether to use sub-agents based on the remaining work:',
      '- Simple tasks: implement directly, no sub-agents needed',
      '- Multi-file changes: spawn sub-agents to parallelize independent slices',
      'When using sub-agents, prefer subagent_spawn_batch for independent parallel work.',
      'When using sub-agents, pass nodeId so progress tracking stays current.',
      'For multi-file inspection, use read_files with concurrency to reduce latency.',
      '',
      `Task effort: ${effort}. Scale coordination overhead accordingly.`,
      'Use gh tools/CLI for GitHub operations when available; fallback to github_api only when needed.',
      'Iterate until validation passes or a true blocker is reached.',
      'After each push or PR update, query remote CI/check status via gh and keep fixing/re-pushing until checks pass or a true blocker is reached.',
      'Always run `git fetch origin` before checking remote branch state, merge status, or pushing.',
      'Do not ask the user to continue after partial progress; continue autonomously until completion or a concrete blocker is reached.',
      'For transient tool or sub-agent failures (timeouts, aborts, rate limits), retry automatically before surfacing a blocker.',
    ];

  const phaseModelConfig = phase === 'planning'
    ? resolveSessionRoleModel(config, 'planner')
    : resolveSessionRoleModel(config, 'implementer');

  return renderPromptSections([
    { name: PromptSectionName.Identity, lines: [
      `You are continuing an existing Orchestrace ${phase} session.`,
      'Operate as an autonomous engineering agent with reliable, verifiable execution.',
    ] },
    { name: PromptSectionName.AutonomyContract, lines: [
      'Never claim actions completed unless confirmed by tool output.',
      'If context is missing, gather it with available tools before deciding.',
      'Prefer deterministic steps and explicit validation over speculation.',
    ] },
    { name: PromptSectionName.PhaseRules, lines: phaseRules },
    { name: PromptSectionName.SessionContext, lines: [
      `Workspace: ${config.workspacePath}`,
      `Provider/Model: ${phaseModelConfig.provider}/${phaseModelConfig.model}`,
      `Original task prompt: ${config.prompt}`,
    ] },
  ]);
}

function resolveSubAgentSystemPrompt(request: SubAgentRequest): string {
  if (request.systemPrompt) return request.systemPrompt;
  if (request.contextPacket) {
    return [
      'You are a focused sub-agent. Use only delegated context and avoid unrelated history.',
      'Respect boundaries in the provided SubAgentContextPacket.',
      'Respond concisely with machine-readable structure when possible.',
      'Preferred output contract: JSON object with keys summary, actions[], evidence[{type,ref,note?}], risks[], openQuestions[], patchIntent[].',
    ].join('\n');
  }
  return 'You are a focused sub-agent. Use only the provided task-relevant context, avoid unrelated history, and return concise actionable output.';
}

function resolveTimeoutMs(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

async function completeWithRetry(
  agent: { complete: (prompt: string, signal?: AbortSignal) => Promise<{ text: string; usage?: { input: number; output: number; cost: number } }> },
  prompt: string,
  signal?: AbortSignal,
  options?: {
    onAttemptStart?: (attempt: number) => void | Promise<void>;
  },
): Promise<{ text: string; usage?: { input: number; output: number; cost: number } }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SUBAGENT_RETRY_MAX_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    try {
      await options?.onAttemptStart?.(attempt);
      return await agent.complete(prompt, signal);
    } catch (err) {
      lastError = err;
      const elapsedMs = Date.now() - startedAt;
      const retryable = isRetryable(err);
      const exhausted = attempt >= SUBAGENT_RETRY_MAX_ATTEMPTS;
      const retryDelayMs = retryable && !exhausted ? SUBAGENT_RETRY_BASE_DELAY_MS * attempt : 0;

      console.warn(
        `[runner] Sub-agent LLM attempt failed (attempt=${attempt}/${SUBAGENT_RETRY_MAX_ATTEMPTS}, elapsedMs=${elapsedMs}, retryable=${retryable}, retryDelayMs=${retryDelayMs}): ${errorMsg(err)}`,
      );

      if (exhausted || !retryable) throw err;
      await new Promise<void>((r) => setTimeout(r, retryDelayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(errorMsg(lastError));
}

function isRetryable(err: unknown): boolean {
  return isRetryableSubAgentFailure(err);
}

function buildStructuredResult(result: { text: string; usage?: { input: number; output: number; cost: number } }): SubAgentResult {
  const parsed = parseResultJson(result.text);
  const summary = typeof parsed?.summary === 'string' && parsed.summary.trim()
    ? parsed.summary.trim().slice(0, 900)
    : result.text.replace(/\s+/g, ' ').trim().slice(0, 900);

  return {
    text: result.text, usage: result.usage, summary,
    actions: strList(parsed?.actions),
    evidence: normalizeEvidence(parsed?.evidence),
    risks: strList(parsed?.risks),
    openQuestions: strList(parsed?.openQuestions),
    patchIntent: strList(parsed?.patchIntent),
  };
}

function parseResultJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  for (const candidate of [trimmed, fenced].filter(Boolean) as string[]) {
    try {
      const p = JSON.parse(candidate);
      if (p && typeof p === 'object') return p as Record<string, unknown>;
    } catch { /* next */ }
  }
  return undefined;
}

export function parsePrMetadataResponse(
  text: string,
  taskRanges: Array<{ todoId: string; todoTitle: string }>,
  isObserverSession?: boolean,
): {
  branchName: string;
  prTitle: string;
  prDescription: string;
  taskCommitMessages: Array<{ todoId: string; message: string }>;
  fallbackCommitMessage: string;
} | undefined {
  const parsed = parseResultJson(text);
  if (!parsed) return undefined;

  const branchName = typeof parsed.branchName === 'string' ? parsed.branchName.trim() : '';
  let prTitle = typeof parsed.prTitle === 'string' ? parsed.prTitle.trim() : '';
  const prDescription = typeof parsed.prDescription === 'string' ? parsed.prDescription.trim() : '';
  const fallbackCommitMessage = typeof parsed.fallbackCommitMessage === 'string'
    ? parsed.fallbackCommitMessage.trim()
    : (typeof parsed.commitMessage === 'string' ? parsed.commitMessage.trim() : '');

  if (!branchName || !prTitle || !fallbackCommitMessage) return undefined;

  // Sanitize branch name: only allow alphanumeric, hyphens, slashes, dots
  const safeBranch = branchName.replace(/[^a-zA-Z0-9/._-]/g, '-').replace(/-{2,}/g, '-').slice(0, 60);

  // Add [Observer fix] prefix if this is an observer session and the prefix is not already present
  if (isObserverSession && !prTitle.startsWith('[Observer fix]')) {
    prTitle = `[Observer fix] ${prTitle}`.slice(0, 80);
  }

  // Parse per-task commit messages
  const rawTaskMessages = Array.isArray(parsed.taskCommitMessages) ? parsed.taskCommitMessages : [];
  const taskCommitMessages: Array<{ todoId: string; message: string }> = [];
  const parsedMap = new Map<string, string>();
  for (const item of rawTaskMessages) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const todoId = typeof r.todoId === 'string' ? r.todoId.trim() : '';
    const message = typeof r.message === 'string' ? r.message.trim() : '';
    if (todoId && message) parsedMap.set(todoId, message.slice(0, 120));
  }

  // Ensure one message per task range, falling back to todoTitle
  for (const range of taskRanges) {
    taskCommitMessages.push({
      todoId: range.todoId,
      message: parsedMap.get(range.todoId) ?? compact(range.todoTitle, 72),
    });
  }

  return {
    branchName: safeBranch,
    prTitle: prTitle.slice(0, 120),
    prDescription: prDescription || prTitle,
    taskCommitMessages,
    fallbackCommitMessage: fallbackCommitMessage.slice(0, 120),
  };
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((e) => (typeof e === 'string' ? e.trim() : '')).filter(Boolean).slice(0, 12);
}

function normalizeEvidence(value: unknown): NonNullable<SubAgentResult['evidence']> {
  if (!Array.isArray(value)) return [];
  const entries: NonNullable<SubAgentResult['evidence']> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const type = r.type;
    if (type !== 'file' && type !== 'command' && type !== 'test' && type !== 'log' && type !== 'url' && type !== 'other') continue;
    const ref = typeof r.ref === 'string' ? r.ref.trim() : '';
    if (!ref) continue;
    entries.push({ type, ref, note: typeof r.note === 'string' && r.note.trim() ? r.note.trim() : undefined });
  }
  return entries.slice(0, 16);
}

function normalizeGraphNodes(rawNodes: unknown): SessionAgentGraphNode[] {
  if (!Array.isArray(rawNodes)) return [];
  const nodes: SessionAgentGraphNode[] = [];
  const seen = new Set<string>();
  for (const raw of rawNodes) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = str(r.id);
    const prompt = str(r.prompt);
    if (!id || !prompt || seen.has(id)) continue;
    seen.add(id);
    nodes.push({
      id, prompt,
      name: str(r.name) || undefined,
      weight: typeof r.weight === 'number' ? r.weight : undefined,
      dependencies: Array.isArray(r.dependencies) ? (r.dependencies as unknown[]).map(String) : [],
      status: undefined,
      provider: str(r.provider) || undefined,
      model: str(r.model) || undefined,
      reasoning: (['minimal', 'low', 'medium', 'high'] as const).includes(r.reasoning as 'minimal') ? r.reasoning as 'minimal' | 'low' | 'medium' | 'high' : undefined,
    });
  }
  return nodes;
}

function resolveNodeIds(nodes: SessionAgentGraphNode[], toolName: string, input: Record<string, unknown>): string[] {
  if (toolName === 'subagent_spawn') {
    const nodeId = str(input.nodeId);
    if (nodeId && nodes.some((n) => n.id === nodeId)) return [nodeId];
    const prompt = str(input.prompt);
    if (!prompt) return [];
    const exact = nodes.find((n) => n.prompt.trim() === prompt.trim());
    if (exact) return [exact.id];
    const overlap = nodes.find((n) => prompt.includes(n.prompt) || n.prompt.includes(prompt));
    return overlap ? [overlap.id] : [];
  }

  const rawAgents = Array.isArray(input.agents) ? input.agents : [];
  const resolved = rawAgents
    .filter((e: unknown) => e && typeof e === 'object')
    .map((e: unknown) => {
      const a = e as Record<string, unknown>;
      const nid = str(a.nodeId);
      if (nid && nodes.some((n) => n.id === nid)) return nid;
      const p = str(a.prompt);
      if (!p) return undefined;
      const em = nodes.find((n) => n.prompt.trim() === p.trim());
      if (em) return em.id;
      const om = nodes.find((n) => p.includes(n.prompt) || n.prompt.includes(p));
      return om?.id;
    })
    .filter((e): e is string => Boolean(e));
  return [...new Set(resolved)];
}

function normalizeTodoStatus(value: unknown): 'todo' | 'in_progress' | 'done' | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  const n = raw.toLowerCase().replace(/[-\s]+/g, '_');
  if (n === 'todo' || n === 'pending' || n === 'backlog' || n === 'open') return 'todo';
  if (n === 'in_progress' || n === 'inprogress' || n === 'doing' || n === 'active' || n === 'wip') return 'in_progress';
  if (n === 'done' || n === 'completed' || n === 'complete' || n === 'finished' || n === 'closed' || n === 'resolved') return 'done';
  return undefined;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

// Only run main if this is the actual CLI entry point, not when imported as a module (e.g., for testing)
if (process.argv[2] && process.argv[3]) {
  void main().catch((err) => {
    console.error('[runner] Fatal error:', err);
    process.exit(1);
  });
}
