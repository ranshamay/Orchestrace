/**
 * Standalone session runner — executes orchestration in a detached child process.
 *
 * Usage: node --import tsx runner.ts <sessionId> <workspaceRoot>
 *
 * Reads session config from the event store (first session:created event).
 * Writes all orchestration events to the event store.
 * Handles SIGTERM for graceful cancellation.
 * Writes heartbeat events every 5 seconds.
 *
 * Exit codes: 0 = success, 1 = failure, 130 = cancelled
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { orchestrate, PromptSectionName, renderPromptSections } from '@orchestrace/core';
import type { DagEvent, TaskGraph } from '@orchestrace/core';
import { PiAiAdapter, ProviderAuthManager } from '@orchestrace/provider';
import {
  DEFAULT_AGENT_TOOL_POLICY_VERSION,
  createAgentToolset,
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
  const firstEvent = events.find((e) => e.type === 'session:created');
  if (!firstEvent || firstEvent.type !== 'session:created') {
    console.error(`No session:created event found for session ${sessionId}`);
    process.exit(1);
  }

  const config: SessionConfig = firstEvent.payload.config;
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
    const llmStatus = makeLlmStatus('cancelled', 'Cancelled by user.');
    lastLlmStatusEmission = {
      key: llmStatusIdentityKey(llmStatus),
      emittedAt: parseTimestamp(llmStatus.updatedAt),
    };
    void emit({ time: iso(), type: 'session:llm-status-change', payload: { llmStatus } });
    void emit({ time: iso(), type: 'session:status-change', payload: { status: 'cancelled' } });
  });

  // Shared context store for this session
  const sharedContextStore = new InMemorySharedContextStore();
  let lastLlmStatusEmission: LlmStatusEmissionState | undefined;

  // Local state for graph progress tracking
  const agentGraph: SessionAgentGraphNode[] = [];
  const pendingNodeIds = new Map<string, string[]>();

  // Build single-task graph
  const graph = buildSingleTaskGraph(sessionId, config.prompt);

  // Helper to emit events
  async function emit(event: SessionEventInput): Promise<void> {
    try {
      await eventStore.append(sessionId, event);
    } catch (err) {
      console.error(`[runner] Failed to emit event:`, err);
    }
  }

  try {
    const outputs = await orchestrate(graph, {
      llm,
      cwd: config.workspacePath,
      planOutputDir: join(config.workspacePath, '.orchestrace', 'plans'),
      promptVersion: process.env.ORCHESTRACE_PROMPT_VERSION,
      policyVersion: process.env.ORCHESTRACE_POLICY_VERSION ?? DEFAULT_AGENT_TOOL_POLICY_VERSION,
      defaultModel: { provider: config.provider, model: config.model },
      planningSystemPrompt: buildSystemPrompt(config, 'planning'),
      implementationSystemPrompt: buildSystemPrompt(config, 'implementation'),
      maxParallel: 1,
      requirePlanApproval: !config.autoApprove,
      onPlanApproval: async () => config.autoApprove,
      signal: controller.signal,
      resolveApiKey: async (providerId) => authManager.resolveApiKey(providerId),

      createToolset: ({ phase, task, graphId, provider: activeProvider, model: activeModel, reasoning }) => createAgentToolset({
        cwd: config.workspacePath,
        phase,
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
        if (event.type === 'task:tool-call' && event.status === 'started' && event.input) {
          handleToolCallChecklist(event);
          handleToolCallAgentGraph(event);
        }

        // Graph progress from sub-agent tool calls
        if (event.type === 'task:tool-call') {
          handleGraphProgress(event);
        }

        // Task status
        if ('taskId' in event && event.type !== 'task:tool-call') {
          void emit({ time: t, type: 'session:task-status-change', payload: { taskId: event.taskId, taskStatus: event.type } });
        }
      },
    });

    if (cancelled) {
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

    await emit({ time: t, type: 'session:output-set', payload: { output } });

    if (failed) {
      const error = failedOutput?.error ?? 'Execution failed';
      await emit({ time: t, type: 'session:error-change', payload: { error } });
      const llmStatus = makeLlmStatus('failed', failedOutput?.failureType
        ? `${failedOutput.failureType}: ${failedOutput.error || 'Execution failed.'}`
        : (failedOutput?.error || 'Execution failed.'), failedOutput?.failureType);
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

    // Write assistant response as chat message
    if (primaryOutput?.response) {
      await emit({ time: t, type: 'session:chat-message', payload: { message: { role: 'assistant', content: primaryOutput.response, time: t } } });
    }

    clearInterval(heartbeatInterval);
    process.exit(failed ? 1 : 0);
  } catch (error) {
    if (cancelled) {
      clearInterval(heartbeatInterval);
      process.exit(130);
    }

    const t = iso();
    const errorText = errorMsg(error);
    await emit({ time: t, type: 'session:error-change', payload: { error: errorText } });
    const llmStatus = makeLlmStatus('failed', errorText);
    lastLlmStatusEmission = {
      key: llmStatusIdentityKey(llmStatus),
      emittedAt: parseTimestamp(llmStatus.updatedAt),
    };
    await emit({ time: t, type: 'session:llm-status-change', payload: { llmStatus } });
    await emit({ time: t, type: 'session:status-change', payload: { status: 'failed' } });

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

function buildSingleTaskGraph(id: string, prompt: string): TaskGraph {
  const raw = process.env.ORCHESTRACE_VERIFY_COMMANDS;
  const commands = raw
    ? raw.split(';').map((s) => s.trim()).filter(Boolean)
    : ['pnpm typecheck', 'pnpm test'];

  return {
    id: `ui-${id}`,
    name: 'UI Work Session',
    nodes: [{
      id: 'task',
      name: 'Execute UI prompt',
      type: 'code',
      prompt,
      dependencies: [],
      validation: { commands, maxRetries: 2, retryDelayMs: 0 },
    }],
  };
}

function buildSystemPrompt(config: SessionConfig, phase: 'planning' | 'implementation'): string {
  const phaseRules = phase === 'planning'
    ? [
      'Produce a concrete implementation plan with explicit staged execution and validation steps.',
      'Do not perform direct code edits in planning mode.',
      'Planning output must be highly granular and atomic: each task should represent one action and one completion outcome.',
      'Split broad, multi-area, or multi-step tasks into smaller independent tasks before finalizing.',
      'Each planned task must include explicit dependencies, concrete done criteria, and at least one verification command.',
      'Planning must produce and maintain todo_set and agent_graph_set state.',
      'todo_set items must include numeric weight values and the total todo weight must sum to 100.',
      'agent_graph_set nodes must include numeric weight values and the total node weight must sum to 100.',
      'Planning must use subagent_spawn or subagent_spawn_batch for focused parallel research and delegate only relevant context.',
      'For independent nodes, use subagent_spawn_batch so work runs in parallel.',
      'For multi-file inspection, use read_files with concurrency to reduce latency; avoid repeated single-file reads when possible.',
      'Pass nodeId for each sub-agent request so graph status stays current.',
      'Keep todo and dependency graph state synchronized.',
      'Do not ask the user to continue after partial progress; continue autonomously until completion or a concrete blocker is reached.',
      'For transient tool or sub-agent failures (timeouts, aborts, rate limits), retry automatically before surfacing a blocker.',
    ]
    : [
      'Execute approved work with minimal, scoped edits and verify outcomes.',
      'Read before editing, and use tool output to adapt after failures.',
      'Read todo_get and agent_graph_get before coding, then keep todo_update current while implementing.',
      'Use subagent_spawn or subagent_spawn_batch to execute parallelizable slices with minimal relevant context per agent.',
      'For independent nodes, use subagent_spawn_batch so work runs in parallel.',
      'For multi-file inspection, use read_files with concurrency to reduce latency; avoid repeated single-file reads when possible.',
      'Pass nodeId for each sub-agent request so graph status stays current.',
      'Use github_api for GitHub REST/GraphQL operations; do not use gh CLI.',
      'Iterate until validation passes or a true blocker is reached.',
      'After each push or PR update, query remote CI/check status with github_api and keep fixing/re-pushing until checks pass or a true blocker is reached.',
      'Do not stop at green checks alone: verify PR mergeability, required checks, and review state via github_api, then keep iterating until the PR is merge-ready or a true blocker is reached.',
      'Always run `git fetch origin` before checking remote branch state, merge status, or pushing. Never trust local tracking refs without fetching first.',
      'Do not ask the user to continue after partial progress; continue autonomously until completion or a concrete blocker is reached.',
      'For transient tool or sub-agent failures (timeouts, aborts, rate limits), retry automatically before surfacing a blocker.',
    ];

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
      `Provider/Model: ${config.provider}/${config.model}`,
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
    try {
      return await agent.complete(prompt, signal);
    } catch (err) {
      lastError = err;
      if (attempt >= SUBAGENT_RETRY_MAX_ATTEMPTS || !isRetryable(err)) throw err;
      await new Promise<void>((r) => setTimeout(r, SUBAGENT_RETRY_BASE_DELAY_MS * attempt));
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
