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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
import type { SessionEventInput, SessionConfig, SessionLlmStatus, LlmSessionState, SessionAgentGraphNode } from '@orchestrace/store';
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
  enforceSafeShellDispatch,
  resolveTaskRouteForSource,
  stripRetryContinuationContext,
} from './task-routing.js';

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
const CHECKPOINT_STASH_PREFIX = 'orchestrace-checkpoint';
const CHECKPOINT_METADATA_FILE = 'checkpoint.json';
const execFileAsync = promisify(execFile);
type PlanningNoToolGuardMode = 'enforce' | 'warn';

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

interface GitHubApiResponse {
  ok: boolean;
  status: number;
  body: unknown;
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
  process.on('SIGTERM', () => {
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
  });

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
  const dispatch = enforceSafeShellDispatch(promptForRoutingAndEffort, resolvedRoute);
  const route = dispatch.route;
  const effortClassification = classifyTaskEffort(promptForRoutingAndEffort);
  const taskEffort: TaskEffort = (process.env.ORCHESTRACE_TASK_EFFORT as TaskEffort) || effortClassification.effort;
  let successfulEditFileResultsSinceCheckpoint = 0;
  const todoDoneCheckpointed = new Set<string>();
  let checkpointInFlight = false;

  // Build single-task graph
  const graph = buildSingleTaskGraph(sessionId, config.prompt, route.category);
  const quickStartMode = config.quickStartMode
    ?? resolveBooleanEnv(process.env.ORCHESTRACE_QUICK_START_MODE, false);
  const quickStartMaxPreDelegationToolCalls = config.quickStartMaxPreDelegationToolCalls
    ?? resolvePositiveIntEnv(process.env.ORCHESTRACE_QUICK_START_MAX_PRE_DELEGATION_TOOL_CALLS, 3);
  const planningNoToolGuardMode = normalizePlanningNoToolGuardMode(config.planningNoToolGuardMode)
    ?? normalizePlanningNoToolGuardMode(process.env.ORCHESTRACE_PLANNING_NO_TOOL_GUARD_MODE)
    ?? 'enforce';
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

  if (resolvedRoute.category === 'shell_command' && route.category !== 'shell_command') {
    void emit({
      time: iso(),
      type: 'session:dag-event',
      payload: {
        event: {
          time: iso(),
          runId: sessionId,
          type: 'task:routing',
          taskId: 'task',
          message: `Shell route fallback applied: ${dispatch.shell.reason ?? 'prompt failed shell validation'}`,
        },
      },
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

    const messageContext = opts?.todoTitle?.trim() || opts?.todoId?.trim() || reason;
    const commitMessage = `checkpoint: ${compact(messageContext, 120)}`;

    try {
      const add = await runGitSafe(['add', '-A']);
      if (!add.ok) {
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
            message: commitMessage,
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
      '- "prTitle": a concise, descriptive PR title (max 80 chars). Use conventional commit style (e.g., "feat: add user auth flow").',
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
      });

      const result = await agent.complete(metadataPrompt);
      const parsed = parsePrMetadataResponse(result.text, context.taskRanges);
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

    return {
      branchName: `feat/${slug || `session-${sessionId.slice(0, 8)}`}`,
      prTitle: compact(config.prompt, 80),
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
   * Rewrites session checkpoint commits into per-task commits, each with an
   * LLM-generated message, then pushes and creates a PR.
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

    // Use LLM to generate meaningful PR metadata + per-task commit messages
    const prMeta = await generatePrMetadata({
      prompt: config.prompt,
      diffSummary: changes.diffSummary,
      changedFiles: changes.changedFiles,
      commitCount: changes.commitCount,
      taskRanges: taskRangesWithFiles,
    });

    // Rewrite history: one commit per task
    if (sessionHeadAtStart && taskCommitRanges.length > 0) {
      // Build message map from LLM output
      const messageMap = new Map<string, string>();
      for (const tcm of prMeta.taskCommitMessages) {
        messageMap.set(tcm.todoId, tcm.message);
      }

      // Reset to session start, then replay per-task ranges
      const resetRes = await runGitSafeWithTimeout(
        ['reset', '--soft', sessionHeadAtStart],
        SESSION_DELIVERY_GIT_TIMEOUT_MS,
      );
      if (resetRes.ok) {
        // Commit once per task range by cherry-picking the diff
        for (const range of taskCommitRanges) {
          const message = messageMap.get(range.todoId) ?? compact(range.todoTitle, 72);

          // Apply all changes from this task's range
          const patchRes = await runGitSafeWithTimeout(
            ['diff', `${range.fromSha}..${range.toSha}`],
            SESSION_DELIVERY_GIT_TIMEOUT_MS,
          );
          if (patchRes.ok && patchRes.stdout.trim()) {
            const applyRes = await runGitSafeWithTimeout(
              ['apply', '--index', '--allow-empty', '-'],
              SESSION_DELIVERY_GIT_TIMEOUT_MS,
            );
            // If apply fails, try checkout-based approach
            if (!applyRes.ok) {
              await runGitSafeWithTimeout(
                ['checkout', range.toSha, '--', '.'],
                SESSION_DELIVERY_GIT_TIMEOUT_MS,
              );
              await runGitSafe(['add', '-A']);
            }
          } else {
            // Fallback: checkout the tree state at toSha
            await runGitSafeWithTimeout(
              ['checkout', range.toSha, '--', '.'],
              SESSION_DELIVERY_GIT_TIMEOUT_MS,
            );
            await runGitSafe(['add', '-A']);
          }

          const hasStaged = await runGitSafe(['diff', '--cached', '--quiet']);
          if (!hasStaged.ok) {
            const commitRes = await runGitSafeWithTimeout(
              ['commit', '-m', message],
              SESSION_DELIVERY_GIT_TIMEOUT_MS,
            );
            if (!commitRes.ok) {
              // If per-task commit fails, bail to single-commit fallback
              console.warn(`[runner] Per-task commit failed for ${range.todoId}, falling back to single commit.`);
              await runGitSafeWithTimeout(['reset', '--soft', sessionHeadAtStart], SESSION_DELIVERY_GIT_TIMEOUT_MS);
              break;
            }
          }
        }

        // Ensure final tree matches the original session end
        const finalHead = await getGitHeadSha();
        const lastRange = taskCommitRanges[taskCommitRanges.length - 1];
        if (finalHead !== lastRange.toSha) {
          // There may be trailing changes after the last task (terminal checkpoint)
          const currentHead = committedCheckpointShas[committedCheckpointShas.length - 1];
          if (currentHead && currentHead !== finalHead) {
            await runGitSafeWithTimeout(['checkout', currentHead, '--', '.'], SESSION_DELIVERY_GIT_TIMEOUT_MS);
            await runGitSafe(['add', '-A']);
            const trailingStaged = await runGitSafe(['diff', '--cached', '--quiet']);
            if (!trailingStaged.ok) {
              await runGitSafeWithTimeout(
                ['commit', '-m', prMeta.fallbackCommitMessage],
                SESSION_DELIVERY_GIT_TIMEOUT_MS,
              );
            }
          }
        }
      }
    } else if (sessionHeadAtStart && changes.commitCount >= 1) {
      // No task ranges: squash all into one commit with LLM message
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

    // Create branch with LLM-generated name
    const branchRes = await runGitSafeWithTimeout(
      ['checkout', '-B', prMeta.branchName],
      SESSION_DELIVERY_GIT_TIMEOUT_MS,
    );
    if (!branchRes.ok) {
      // Fallback to generated branch name if LLM name conflicts
      const fallbackBranch = `orchestrace/session-${sessionId.slice(0, 8)}-${Date.now().toString(36)}`;
      const fallbackRes = await runGitSafeWithTimeout(
        ['checkout', '-B', fallbackBranch],
        SESSION_DELIVERY_GIT_TIMEOUT_MS,
      );
      if (!fallbackRes.ok) {
        throw new Error(`Unable to create delivery branch: ${(fallbackRes.error ?? fallbackRes.stderr) || 'git checkout failed'}`);
      }
      prMeta.branchName = fallbackBranch;
    }

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

    const deliveryMessage = pr.created
      ? `Committed session changes were pushed to origin/${prMeta.branchName} and PR #${pr.number} was created: ${pr.url}`
      : `Committed session changes were pushed to origin/${prMeta.branchName} and existing PR #${pr.number} was reused: ${pr.url}`;

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

  async function callGitHubApi(
    params: { host: string; token: string },
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
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
        resolveGithubToken: () => githubAuthManager.resolveApiKey('github'),
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
        clearInterval(heartbeatInterval);
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
      clearInterval(heartbeatInterval);
      process.exit(0);
    }

    const outputs = route.category === 'shell_command'
      ? await runShellCommandRoute(dispatch.shell.command!, config.workspacePath)
      : await orchestrate(graph, {
      llm,
      cwd: config.workspacePath,
      planOutputDir: join(config.workspacePath, '.orchestrace', 'plans'),
      promptVersion: process.env.ORCHESTRACE_PROMPT_VERSION,
      policyVersion: process.env.ORCHESTRACE_POLICY_VERSION ?? DEFAULT_AGENT_TOOL_POLICY_VERSION,
      enableTrivialTaskGate: trivialTaskGate.enabled,
      trivialTaskMaxPromptLength: trivialTaskGate.maxPromptLength,
      defaultModel: {
        provider: config.implementationProvider ?? config.provider,
        model: config.implementationModel ?? config.model,
      },
      defaultPlanningModel: {
        provider: config.planningProvider ?? config.provider,
        model: config.planningModel ?? config.model,
      },
      defaultImplementationModel: {
        provider: config.implementationProvider ?? config.provider,
        model: config.implementationModel ?? config.model,
      },
      planningSystemPrompt: buildSystemPrompt(config, 'planning', taskEffort),
      implementationSystemPrompt: buildSystemPrompt(config, 'implementation', taskEffort),
      quickStartMode,
      quickStartMaxPreDelegationToolCalls,
      planningNoToolGuardMode,
      taskEffort,
      maxParallel: 1,
      requirePlanApproval: !config.autoApprove,
      onPlanApproval: async () => config.autoApprove,
      signal: controller.signal,
      resolveApiKey: async (providerId) => authManager.resolveApiKey(providerId),

      createToolset: ({ phase, task, graphId, provider: activeProvider, model: activeModel, reasoning, taskRequiresWrites }) => createAgentToolset({
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
        resolveGithubToken: () => githubAuthManager.resolveApiKey('github'),
        sharedContextStore,
        fileReadCache,
        agentId: `orchestrator::${task.id}`,
        runSubAgent: async (request, _signal) => {
          const subProvider = request.provider ?? activeProvider;
          const subModel = request.model ?? activeModel;
          const subTimeoutMs = resolveTimeoutMs('ORCHESTRACE_SUBAGENT_TIMEOUT_MS', 120_000);
          // Combine the session abort signal with a per-subagent hard timeout so that
          // a hung LLM connection (no response, no error) cannot block the runner forever.
          const subSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(subTimeoutMs)]);
          const toolCallId = `subagent-worker-${randomUUID()}`;
          const subPhase: 'planning' | 'implementation' = phase === 'planning' ? 'planning' : 'implementation';

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
            resolveGithubToken: () => githubAuthManager.resolveApiKey('github'),
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
              systemPrompt: resolveSubAgentSystemPrompt(request),
              signal: subSignal,
              toolset: subToolset,
              apiKey: await authManager.resolveApiKey(subProvider),
              refreshApiKey: () => authManager.resolveApiKey(subProvider),
            });

            const result = await completeWithRetry(subAgent, request.prompt, subSignal);
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
            emitSubAgentEvent(task.id, subPhase, toolCallId, 'failed', {
              provider: subProvider, model: subModel, reasoning: request.reasoning ?? reasoning,
              nodeId: request.nodeId, prompt: request.prompt,
              error: errorMsg(error),
            });

            // Update graph node status directly (bypasses truncated DagEvent output)
            if (request.nodeId && agentGraph.length > 0) {
              if (setNodeStatus([request.nodeId], 'failed')) {
                void emit({ time: iso(), type: 'session:agent-graph-set', payload: { graph: agentGraph } });
              }
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
          void emit({ time: t, type: 'session:stream-delta', payload: { taskId: event.taskId, phase: event.phase, delta: event.delta } });
          return;
        }

        // Dag events
        const uiEvent = toUiEvent(sessionId, event, t);
        if (uiEvent) {
          void emit({ time: t, type: 'session:dag-event', payload: { event: uiEvent } });
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

        // Task status
        if ('taskId' in event && event.type !== 'task:tool-call') {
          void emit({ time: t, type: 'session:task-status-change', payload: { taskId: event.taskId, taskStatus: event.type } });
        }
      },
    });

    if (cancelled) {
      await finalizeCheckpoint('cancelled', iso());
      clearInterval(heartbeatInterval);
      process.exit(130);
    }

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

    clearInterval(heartbeatInterval);
    process.exit(terminalFailed ? 1 : 0);
  } catch (error) {
    if (cancelled) {
      await markCheckpointInterrupted(iso(), 'Interrupted during cancellation path.');
      clearInterval(heartbeatInterval);
      process.exit(130);
    }

    const t = iso();
    const errorText = errorMsg(error);
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
    await emit({ time: t, type: 'session:error-change', payload: { error: finalError } });
    const llmStatus = makeLlmStatus('failed', finalError, deliveryError ? 'delivery_failure' : undefined);
    lastLlmStatusEmission = {
      key: llmStatusIdentityKey(llmStatus),
      emittedAt: parseTimestamp(llmStatus.updatedAt),
    };
    await emit({ time: t, type: 'session:llm-status-change', payload: { llmStatus } });
    await emit({ time: t, type: 'session:status-change', payload: { status: 'failed' } });
    await finalizeCheckpoint('failed', t);

    clearInterval(heartbeatInterval);
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
    if (!event.input) return;

    try {
      const args = JSON.parse(event.input) as Record<string, unknown>;
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
    if (event.toolName !== 'agent_graph_set' || !event.input) return;
    try {
      const args = JSON.parse(event.input) as Record<string, unknown>;
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
      return `${statusPart}: ${message}`;
    }
  }

  if (typeof response.body === 'string' && response.body.trim()) {
    return `${statusPart}: ${response.body.trim()}`;
  }

  return statusPart;
}

function previewToolPayload(value: string | undefined): string {
  if (!value) {
    return '(empty)';
  }

  const normalized = value.trim();
  if (!normalized) {
    return '(blank)';
  }

  if (normalized.length <= TOOL_EVENT_PREVIEW_MAX_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, TOOL_EVENT_PREVIEW_MAX_CHARS - 3))}...`;
}

function stringifyTracePayload(value: string): string {
  return JSON.stringify(value);
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

function normalizePlanningNoToolGuardMode(value: unknown): PlanningNoToolGuardMode | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'enforce' || normalized === 'warn') {
    return normalized;
  }

  return undefined;
}

function logDagEventTrace(sessionId: string, event: DagEvent): void {
  const taskId = 'taskId' in event ? event.taskId : undefined;
  const phase = 'phase' in event ? event.phase : undefined;
  const taskPart = taskId ? ` task=${taskId}` : '';
  const phasePart = phase ? ` phase=${phase}` : '';

  if (event.type === 'task:stream-delta') {
    if (TRACE_LOG_STREAM_DELTAS) {
      console.info(
        `[trace:${sessionId}] stream task=${event.taskId} phase=${event.phase} delta=${stringifyTracePayload(event.delta)}`,
      );
    }
    return;
  }

  if (event.type === 'task:tool-call') {
    const direction = event.status === 'started' ? 'input' : 'output';
    const payload = event.status === 'started' ? event.input : event.output;
    const errorSuffix = event.isError ? ' [error]' : '';
    console.info(
      `[trace:${sessionId}] tool task=${event.taskId} name=${event.toolName} direction=${direction}${errorSuffix} payload=${stringifyTracePayload(payload ?? '')}`,
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
  phase?: 'planning' | 'implementation',
): SessionLlmStatus {
  const labels: Record<string, string> = {
    queued: 'Queued', analyzing: 'Analyzing', thinking: 'Thinking', planning: 'Planning',
    'awaiting-approval': 'Awaiting Approval', implementing: 'Implementing',
    'using-tools': 'Using Tools', validating: 'Validating', retrying: 'Retrying',
    completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
  };
  return { state, label: labels[state] ?? 'Queued', detail, failureType, taskId, phase, updatedAt: iso() };
}

function deriveLlmStatus(event: DagEvent, t: string): SessionLlmStatus | undefined {
  switch (event.type) {
    case 'task:ready':
    case 'task:started':
    case 'task:planning':
      return makeLlmStatus('analyzing', 'Reviewing prompt and dependencies.', undefined, event.taskId, 'planning');
    case 'task:stream-delta':
      return makeLlmStatus('thinking', event.phase === 'planning' ? 'Generating plan...' : 'Generating implementation...', undefined, event.taskId, event.phase);
    case 'task:plan-persisted':
      return makeLlmStatus('planning', 'Plan drafted and saved.', undefined, event.taskId, 'planning');
    case 'task:approval-requested':
      return makeLlmStatus('awaiting-approval', 'Waiting for plan approval.', undefined, event.taskId, 'planning');
    case 'task:approved':
      return makeLlmStatus('implementing', 'Plan approved. Starting implementation.', undefined, event.taskId, 'implementation');
    case 'task:implementation-attempt':
      return makeLlmStatus('implementing', `Implementation attempt ${event.attempt}/${event.maxAttempts}.`, undefined, event.taskId, 'implementation');
    case 'task:tool-call':
      return event.status === 'started'
        ? makeLlmStatus('using-tools', `Running tool ${event.toolName}.`, undefined, event.taskId, event.phase)
        : undefined;
    case 'task:validating':
      return makeLlmStatus('validating', 'Running verification checks.', undefined, event.taskId, 'implementation');
    case 'task:verification-failed':
      return makeLlmStatus('retrying', `Verification failed on attempt ${event.attempt}.`, undefined, event.taskId, 'implementation');
    case 'task:retrying':
      return makeLlmStatus('retrying', `Retrying (${event.attempt}/${event.maxRetries}).`, undefined, event.taskId, 'implementation');
    case 'task:completed':
    case 'graph:completed':
      return makeLlmStatus('completed', 'Run completed successfully.', undefined, 'taskId' in event ? event.taskId : undefined, 'implementation');
    case 'task:failed':
    case 'graph:failed':
      return makeLlmStatus('failed',
        event.type === 'task:failed' && event.failureType ? `${event.failureType}: ${event.error}` : event.error,
        event.type === 'task:failed' ? event.failureType : undefined,
        'taskId' in event ? event.taskId : undefined);
    default:
      return undefined;
  }
}

function toUiEvent(runId: string, event: DagEvent, t: string): { time: string; runId: string; type: string; taskId?: string; failureType?: string; message: string } | undefined {
  const base = { time: t, runId, type: event.type, taskId: 'taskId' in event ? event.taskId : undefined, failureType: event.type === 'task:failed' ? event.failureType : undefined };
  const tag = (msg: string) => `[run:${runId}] ${msg}`;

  switch (event.type) {
    case 'task:planning': return { ...base, message: tag(`${event.taskId}: planning`) };
    case 'task:plan-persisted': return { ...base, message: tag(`${event.taskId}: plan persisted at ${event.path}`) };
    case 'task:approval-requested': return { ...base, message: tag(`${event.taskId}: approval requested`) };
    case 'task:approved': return { ...base, message: tag(`${event.taskId}: approved`) };
    case 'task:implementation-attempt': return { ...base, message: tag(`${event.taskId}: implementation attempt ${event.attempt}/${event.maxAttempts}`) };
    case 'task:tool-call': {
      if (event.status === 'started') {
        return { ...base, message: tag(`${event.taskId}: tool ${event.toolName} input ${previewToolPayload(event.input)}`) };
      }
      const err = event.isError ? ' [error]' : '';
      return { ...base, message: tag(`${event.taskId}: tool ${event.toolName} output${err} ${previewToolPayload(event.output)}`) };
    }
    case 'task:verification-failed': return { ...base, message: tag(`${event.taskId}: verification failed`) };
    case 'task:ready': return { ...base, message: tag(`${event.taskId}: ready`) };
    case 'task:started': return { ...base, message: tag(`${event.taskId}: started`) };
    case 'task:validating': return { ...base, message: tag(`${event.taskId}: validating`) };
    case 'task:completed': return { ...base, message: tag(`${event.taskId}: completed`) };
    case 'task:failed': return { ...base, message: tag(`${event.taskId}: failed${event.failureType ? ` [${event.failureType}]` : ''} (${event.error})`) };
    case 'graph:completed': return { ...base, message: tag(`graph completed (${event.outputs.size} outputs)`) };
    case 'graph:failed': return { ...base, message: tag(`graph failed (${event.error})`) };
    case 'task:retrying': return { ...base, message: tag(`${event.taskId}: retrying ${event.attempt}/${event.maxRetries}`) };
    default: return undefined;
  }
}

function buildSingleTaskGraph(id: string, prompt: string, routeCategory: TaskRouteCategory = 'code_change'): TaskGraph {
  const raw = process.env.ORCHESTRACE_VERIFY_COMMANDS;
  const commands = raw
    ? raw.split(';').map((s) => s.trim()).filter(Boolean)
    : ['pnpm typecheck', 'pnpm test'];
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

async function runShellCommandRoute(command: string, cwd: string): Promise<Map<string, TaskOutput>> {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync('sh', ['-lc', command], { cwd });
    const text = `${stdout ?? ''}${stderr ?? ''}`.trim();
    return new Map([
      ['task', {
        taskId: 'task',
        status: 'completed',
        response: text || `Command executed: ${command}`,
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

function buildSystemPrompt(config: SessionConfig, phase: 'planning' | 'implementation', effort: TaskEffort = 'high'): string {
  const isLowEffort = effort === 'trivial' || effort === 'low';

  const phaseRules = phase === 'planning'
    ? [
      'Create an implementation plan scaled to the task complexity.',
      'Do not perform direct code edits in planning mode.',
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
      'Use github_api for GitHub REST/GraphQL operations; do not use gh CLI.',
      'Iterate until validation passes or a true blocker is reached.',
      'After each push or PR update, query remote CI/check status with github_api and keep fixing/re-pushing until checks pass or a true blocker is reached.',
      'Always run `git fetch origin` before checking remote branch state, merge status, or pushing.',
      'Do not ask the user to continue after partial progress; continue autonomously until completion or a concrete blocker is reached.',
      'For transient tool or sub-agent failures (timeouts, aborts, rate limits), retry automatically before surfacing a blocker.',
    ];

  const phaseProvider = phase === 'planning'
    ? (config.planningProvider ?? config.provider)
    : (config.implementationProvider ?? config.provider);
  const phaseModel = phase === 'planning'
    ? (config.planningModel ?? config.model)
    : (config.implementationModel ?? config.model);

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
      `Provider/Model: ${phaseProvider}/${phaseModel}`,
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
): Promise<{ text: string; usage?: { input: number; output: number; cost: number } }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SUBAGENT_RETRY_MAX_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    try {
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
  const msg = errorMsg(err).toLowerCase();
  return msg.includes('aborted') || msg.includes('timeout') || msg.includes('timed out')
    || msg.includes('rate limit') || msg.includes('429') || msg.includes('temporar')
    || msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('network');
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

function parsePrMetadataResponse(
  text: string,
  taskRanges: Array<{ todoId: string; todoTitle: string }>,
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
  const prTitle = typeof parsed.prTitle === 'string' ? parsed.prTitle.trim() : '';
  const prDescription = typeof parsed.prDescription === 'string' ? parsed.prDescription.trim() : '';
  const fallbackCommitMessage = typeof parsed.fallbackCommitMessage === 'string'
    ? parsed.fallbackCommitMessage.trim()
    : (typeof parsed.commitMessage === 'string' ? parsed.commitMessage.trim() : '');

  if (!branchName || !prTitle || !fallbackCommitMessage) return undefined;

  // Sanitize branch name: only allow alphanumeric, hyphens, slashes, dots
  const safeBranch = branchName.replace(/[^a-zA-Z0-9/._-]/g, '-').replace(/-{2,}/g, '-').slice(0, 60);

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

void main().catch((err) => {
  console.error('[runner] Fatal error:', err);
  process.exit(1);
});
