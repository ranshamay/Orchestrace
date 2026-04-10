import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Type, validateToolCall } from '@mariozechner/pi-ai';
import type {
  AgentToolPhase,
  AgentGraphNode,
  AgentToolsetOptions,
  RegisteredAgentTool,
  SubAgentContextPacket,
  SubAgentEvidenceItem,
  SubAgentFileSnippet,
  SubAgentRequest,
  SubAgentResult,
  TodoItem,
} from './types.js';
import { sanitizeForPathSegment } from './path-utils.js';
import type { SessionFileReadCache } from './file-read-cache.js';
import { readFullFileWithCache } from './file-read-cache.js';

const todoStatusSchema = Type.Union([
  Type.Literal('todo'),
  Type.Literal('pending'),
  Type.Literal('backlog'),
  Type.Literal('open'),
  Type.Literal('in_progress'),
  Type.Literal('in-progress'),
  Type.Literal('inprogress'),
  Type.Literal('doing'),
  Type.Literal('active'),
  Type.Literal('wip'),
  Type.Literal('done'),
  Type.Literal('completed'),
  Type.Literal('complete'),
  Type.Literal('finished'),
  Type.Literal('closed'),
  Type.Literal('resolved'),
], { description: 'Task status. Use "todo"/"pending"/"backlog"/"open" for not-started, "in_progress"/"doing"/"active"/"wip" for in-progress, or "done"/"completed"/"finished"/"closed"/"resolved" for complete.' });

const modeSchema = Type.Union([
  Type.Literal('chat'),
  Type.Literal('planning'),
  Type.Literal('implementation'),
], { description: 'Session mode: "chat" for conversational responses, "planning" for creating an execution plan, or "implementation" for executing the plan.' });

const SUBAGENT_CONTEXT_MAX_FILES = 3;
const SUBAGENT_CONTEXT_MAX_CHARS_PER_FILE = 1200;
const SUBAGENT_CONTEXT_MARKER = 'Auto-included file snippets';
const SUBAGENT_SNIPPET_READ_CONCURRENCY = 8;
const SUBAGENT_BATCH_DEFAULT_CONCURRENCY = 8;
const SUBAGENT_BATCH_MAX_CONCURRENCY = 64;
const SUBAGENT_BATCH_MIN_CONCURRENCY = 1;
const SUBAGENT_BATCH_IDENTICAL_FAILURE_CAP = 2;
const SUBAGENT_BATCH_GITHUB_TOKEN_PRECHECK_MIN_TTL_SECONDS = 10 * 60;

const SUBAGENT_PROMPT_SOFT_LIMIT_CHARS = 2200;
const SUBAGENT_PROMPT_PREVIEW_MAX_CHARS = 220;
const SUBAGENT_OUTPUT_PREVIEW_MAX_CHARS = 900;
const SUBAGENT_MERGE_OUTPUT_PREVIEW_MAX_CHARS = 600;
const COORDINATION_PERSIST_RAW_DEBUG_ENV = 'ORCHESTRACE_PERSIST_RAW_DEBUG';
const COORDINATION_PERSIST_PROMPT_MAX_CHARS = 1_600;
const COORDINATION_PERSIST_OUTPUT_MAX_CHARS = 1_000;
const PROMPT_FILE_PATH_PATTERN = /(?:^|[\s`"'])((?:\.?\.?\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.[A-Za-z0-9._-]+)(?=$|[\s`"':),])/g;

const subAgentReasoningSchema = Type.Union([
  Type.Literal('minimal'),
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
], { description: 'LLM reasoning effort: "minimal" for simple tasks, "low"/"medium" for moderate complexity, "high" for complex multi-step reasoning.' });

const subAgentContextPacketSchema = Type.Object({
  objective: Type.String({ minLength: 1 }),
  boundaries: Type.Optional(Type.Object({
    writePolicy: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('read_only'), Type.Literal('scoped'), Type.Literal('full')], { description: 'File write policy: "none" or "read_only" (no writes), "scoped" (write within cwd), or "full" (unrestricted). Defaults to scoped if omitted.' })),
    allowedTools: Type.Optional(Type.Array(Type.String())),
    timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
  })),
  relevantContext: Type.Optional(Type.Array(Type.String())),
  requiredOutputSchema: Type.Optional(Type.String()),
  evidenceRequirements: Type.Optional(Type.Array(Type.String())),
  fileSnippets: Type.Optional(Type.Array(
    Type.Object({
      path: Type.String({ minLength: 1 }),
      content: Type.String(),
    }),
  )),
});

const subAgentSpawnEntrySchema = Type.Object({
  nodeId: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String({ minLength: 1 })),
  contextPacket: Type.Optional(subAgentContextPacketSchema),
  systemPrompt: Type.Optional(Type.String()),
  provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  reasoning: Type.Optional(subAgentReasoningSchema),
}, { additionalProperties: false });

const subAgentSpawnArgsSchema = Type.Object({
  ...subAgentSpawnEntrySchema.properties,
}, { additionalProperties: false });

const subAgentSpawnBatchArgsSchema = Type.Object({
  agents: Type.Array(subAgentSpawnEntrySchema, { minItems: 1 }),
  concurrency: Type.Optional(Type.Number({ minimum: 1, maximum: SUBAGENT_BATCH_MAX_CONCURRENCY })),
  adaptiveConcurrency: Type.Optional(Type.Boolean({ description: 'Automatically tune concurrency based on sub-agent failures while processing the batch.' })),
  minConcurrency: Type.Optional(Type.Number({ minimum: 1, maximum: SUBAGENT_BATCH_MAX_CONCURRENCY })),
  maxRetries: Type.Optional(Type.Number({ minimum: 0 })),
}, { additionalProperties: false });

type SubAgentToolName = 'subagent_spawn' | 'subagent_spawn_batch';

interface CoordinationToolsOptions extends AgentToolsetOptions {
  includeSubAgentTool: boolean;
}

interface CachedSubAgentMergePayload {
  summary: string;
  actions: string[];
  evidence: SubAgentEvidenceItem[];
  risks: string[];
  openQuestions: string[];
  patchIntent: string[];
  artifact?: unknown;
}

interface SubAgentRunRecord {
  id: string;
  nodeId?: string;
  prompt: string;
  status: 'running' | 'completed' | 'failed';
  provider?: string;
  model?: string;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
  startedAt: string;
  finishedAt?: string;
  outputPreview?: string;
  error?: string;
  promptPreview?: string;
  usage?: UsageTotals;
  usageReported?: boolean;
  mergePayload?: CachedSubAgentMergePayload;
}

interface UsageTotals {
  input: number;
  output: number;
  cost: number;
}

interface SubAgentBatchRunResult {
  id: string;
  nodeId?: string;
  status: 'completed' | 'failed';
  promptChars: number;
  promptPreview: string;
  outputPreview?: string;
  mergePayload?: CachedSubAgentMergePayload;
  usage?: UsageTotals;
  usageReported?: boolean;
  error?: string;
  cacheHit?: boolean;
}

const TODO_REPLAN_MAX_COUNT = 3;

interface CoordinationState {
  updatedAt: string;
  todos: TodoItem[];
  agentGraph: { nodes: AgentGraphNode[] };
  subAgents: SubAgentRunRecord[];
  planLocked: boolean;
  replanCount: number;
}


export function createCoordinationTools(options: CoordinationToolsOptions): RegisteredAgentTool[] {
  const statePath = join(
    options.cwd,
    '.orchestrace',
    'coordination',
    sanitizeForPathSegment(options.graphId ?? 'default-graph'),
    sanitizeForPathSegment(options.taskId ?? 'default-task'),
    'state.json',
  );

  const tools: RegisteredAgentTool[] = [
    {
      tool: {
        name: 'todo_get',
        description: 'Read the current task todo list for this agent task context.',
        parameters: Type.Object({}),
      },
            execute: async () => {
        const state = await readCoordinationState(statePath);


        return {
          content: JSON.stringify(state.todos, null, 2),
        };
      },
    },
    {
      tool: {
        name: 'todo_set',
        description: 'Replace the full todo list. Use at the start of planning to set a multi-stage concurrent plan.',
        parameters: Type.Object({
          items: Type.Array(
            Type.Object({
              id: Type.String({ minLength: 1 }),
              title: Type.String({ minLength: 1 }),
              status: todoStatusSchema,
              weight: Type.Optional(Type.Number({ minimum: 0 })),
              details: Type.Optional(Type.String()),
              dependsOn: Type.Optional(Type.Array(Type.String())),
            }),
            { minItems: 1 },
          ),
        }),
      },
            execute: async (toolArgs) => {
        const state = await readCoordinationState(statePath);
        if (state.planLocked) {
          return {
            content: 'Cannot run todo_set: plan is locked (planLocked=true).',
            isError: true,
          };
        }
        const items = normalizeTodoItems(toolArgs.items);
        state.todos = items;
        state.updatedAt = now();
        await writeCoordinationState(statePath, state);

        return {
          content: `Stored ${items.length} todo item(s).`,
        };
      },
    },
    {
      tool: {
        name: 'todo_replan',
        description: 'Replace todo plan during planning, incrementing capped replan counter.',
        parameters: Type.Object({
          items: Type.Array(
            Type.Object({
              id: Type.String({ minLength: 1 }),
              title: Type.String({ minLength: 1 }),
              status: todoStatusSchema,
              weight: Type.Optional(Type.Number({ minimum: 0 })),
              details: Type.Optional(Type.String()),
              dependsOn: Type.Optional(Type.Array(Type.String())),
            }),
            { minItems: 1 },
          ),
        }),
      },
      execute: async (toolArgs) => {
        const state = await readCoordinationState(statePath);
        if (state.planLocked) {
          return {
            content: 'Cannot run todo_replan: plan is locked (planLocked=true).',
            isError: true,
          };
        }

        if (state.replanCount >= TODO_REPLAN_MAX_COUNT) {
          return {
            content: `Cannot run todo_replan: replan limit reached (current=${state.replanCount}, max=${TODO_REPLAN_MAX_COUNT}).`,
            isError: true,
          };
        }

        const items = normalizeTodoItems(toolArgs.items);
        state.todos = items;
        state.replanCount += 1;
        state.updatedAt = now();
        await writeCoordinationState(statePath, state);

        return {
          content: `Replanned todo list with ${items.length} item(s). Replan count is now ${state.replanCount}/${TODO_REPLAN_MAX_COUNT}.`,
        };
      },
    },
    {
      tool: {
        name: 'todo_add',

        description: 'Add one todo item to the current todo list.',
        parameters: Type.Object({
          id: Type.String({ minLength: 1 }),
          title: Type.String({ minLength: 1 }),
          status: Type.Optional(todoStatusSchema),
          weight: Type.Optional(Type.Number({ minimum: 0 })),
          details: Type.Optional(Type.String()),
          dependsOn: Type.Optional(Type.Array(Type.String())),
        }),
      },
      execute: async (toolArgs) => {
        const state = await readCoordinationState(statePath);
        const item: TodoItem = {
          id: asString(toolArgs.id, 'id'),
          title: asString(toolArgs.title, 'title'),
          status: normalizeTodoStatus(toolArgs.status) ?? 'todo',
          weight: optionalWeight(toolArgs.weight),
          details: optionalString(toolArgs.details),
          dependsOn: optionalStringArray(toolArgs.dependsOn),
        };

        state.todos = state.todos.filter((existing) => existing.id !== item.id);
        state.todos.push(item);
        state.updatedAt = now();
        await writeCoordinationState(statePath, state);

        return {
          content: `Added todo ${item.id}.`,
        };
      },
    },
    {
      tool: {
        name: 'todo_update',
        description: 'Update an existing todo item status/details/title while implementing.',
        parameters: Type.Object({
          id: Type.String({ minLength: 1 }),
          status: Type.Optional(todoStatusSchema),
          weight: Type.Optional(Type.Number({ minimum: 0 })),
          title: Type.Optional(Type.String()),
          details: Type.Optional(Type.String()),
          appendDetails: Type.Optional(Type.String()),
          dependsOn: Type.Optional(Type.Array(Type.String())),
        }),
      },
      execute: async (toolArgs) => {
        const state = await readCoordinationState(statePath);
        const id = asString(toolArgs.id, 'id');
        const existing = state.todos.find((item) => item.id === id);

        if (!existing) {
          return {
            content: `Todo ${id} does not exist.`,
            isError: true,
          };
        }

        const status = normalizeTodoStatus(toolArgs.status);
        if (status) {
          existing.status = status;
        }

        if (toolArgs.weight !== undefined) {
          existing.weight = optionalWeight(toolArgs.weight);
        }

        const title = optionalString(toolArgs.title);
        if (title) {
          existing.title = title;
        }

        const details = optionalString(toolArgs.details);
        if (details !== undefined) {
          existing.details = details;
        }

        const appendDetails = optionalString(toolArgs.appendDetails);
        if (appendDetails) {
          existing.details = existing.details
            ? `${existing.details}\n${appendDetails}`
            : appendDetails;
        }

        const dependsOn = optionalStringArray(toolArgs.dependsOn);
        if (dependsOn) {
          existing.dependsOn = dependsOn;
        }

        state.updatedAt = now();
        await writeCoordinationState(statePath, state);

        return {
          content: `Updated todo ${id}.`,
        };
      },
    },
    {
      tool: {
        name: 'agent_graph_get',
        description: 'Read the current dependency graph for sub-agents.',
        parameters: Type.Object({}),
      },
      execute: async () => {
        const state = await readCoordinationState(statePath);
        return {
          content: JSON.stringify(state.agentGraph, null, 2),
        };
      },
    },
    {
      tool: {
        name: 'agent_graph_set',
        description: 'Set the dependency graph of sub-agents to run after implementation succeeds.',
        parameters: Type.Object({
          nodes: Type.Array(
            Type.Object({
              id: Type.String({ minLength: 1 }),
              name: Type.Optional(Type.String()),
              prompt: Type.String({ minLength: 1 }),
              weight: Type.Optional(Type.Number({ minimum: 0 })),
              dependencies: Type.Optional(Type.Array(Type.String())),
              provider: Type.Optional(Type.String()),
              model: Type.Optional(Type.String()),
              reasoning: Type.Optional(
                Type.Union([
                  Type.Literal('minimal'),
                  Type.Literal('low'),
                  Type.Literal('medium'),
                  Type.Literal('high'),
                ], { description: 'LLM reasoning effort: "minimal" for simple tasks, "low"/"medium" for moderate complexity, "high" for complex multi-step reasoning.' }),
              ),
            }),
          ),
        }),
      },
            execute: async (toolArgs) => {
        const state = await readCoordinationState(statePath);
        if (state.planLocked) {
          return {
            content: 'Cannot run agent_graph_set: plan is locked (planLocked=true).',
            isError: true,
          };
        }
        const nodes = normalizeAgentGraphNodes(toolArgs.nodes);
        state.agentGraph = { nodes };
        state.updatedAt = now();
        await writeCoordinationState(statePath, state);

        return {
          content: `Stored agent dependency graph with ${nodes.length} node(s).`,
        };
      },
    },

    {
      tool: {
        name: 'subagent_list',
        description: 'List spawned sub-agent executions and statuses for this task.',
        parameters: Type.Object({}),
      },
      execute: async () => {
        const state = await readCoordinationState(statePath);
        return {
          content: JSON.stringify(state.subAgents, null, 2),
        };
      },
    },
  ];

  if (options.includeSubAgentTool && options.runSubAgent) {
    tools.push({
      tool: {
        name: 'subagent_spawn',
        description: 'Spawn a focused sub-agent for a dependent sub-task and return a concise result.',
        parameters: subAgentSpawnArgsSchema,
      },
      execute: async (toolArgs, signal) => {
        if (!options.runSubAgent) {
          return {
            content: 'Sub-agent runner is not available in this context.',
            isError: true,
          };
        }

        const spawnValidation = validateSubAgentToolArgs('subagent_spawn', subAgentSpawnArgsSchema, toolArgs);
        if (!spawnValidation.ok) {
          return {
            content: spawnValidation.message,
            isError: true,
          };
        }

        let request: SubAgentRequest;
        try {
          request = await buildSubAgentRequestFromToolArgs(options.cwd, toolArgs, {
            fileReadCache: options.fileReadCache,
          });
        } catch (error) {
          return {
            content: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }

        const state = await readCoordinationState(statePath);
        const id = `sub-${state.subAgents.length + 1}`;
        const record: SubAgentRunRecord = {
          id,
          nodeId: request.nodeId,
          prompt: request.prompt,
          status: 'running',
          provider: request.provider,
          model: request.model,
          reasoning: request.reasoning,
          startedAt: now(),
        };
        state.subAgents.push(record);
        state.updatedAt = now();
        await writeCoordinationState(statePath, state);

        try {
          const result = await options.runSubAgent(request, signal);
          const latest = await readCoordinationState(statePath);
          const current = latest.subAgents.find((entry) => entry.id === id);
          const mergePayload = buildSubAgentMergePayload(result, id, request);
          const preview = mergePayload.summary;
          const usage = usageOrZero(result.usage);
          if (current) {
            current.status = 'completed';
            current.finishedAt = now();
            current.outputPreview = preview;
            current.promptPreview = compactPromptPreview(request.prompt);
            current.usage = usage;
            current.usageReported = Boolean(result.usage);
            current.mergePayload = mergePayload;
          }
          latest.updatedAt = now();
          await writeCoordinationState(statePath, latest);

          return {
            content: JSON.stringify({
              id,
              nodeId: request.nodeId,
              status: 'completed',
              promptChars: request.prompt.length,
              usage,
              usageReported: Boolean(result.usage),
              outputPreview: preview,
              mergePayload,
            }, null, 2),
            details: { usage: result.usage, mergePayload },
          };
        } catch (error) {
          const latest = await readCoordinationState(statePath);
          const current = latest.subAgents.find((entry) => entry.id === id);
          const message = error instanceof Error ? error.message : String(error);
          if (current) {
            current.status = 'failed';
            current.finishedAt = now();
            current.outputPreview = undefined;
            current.promptPreview = undefined;
            current.usage = undefined;
            current.usageReported = undefined;
            current.mergePayload = undefined;
            current.error = message;
          }
          latest.updatedAt = now();
          await writeCoordinationState(statePath, latest);

          return {
            content: JSON.stringify({
              id,
              nodeId: request.nodeId,
              status: 'failed',
              promptChars: request.prompt.length,
              error: message,
            }, null, 2),
            isError: true,
          };
        }
      },
    });

    tools.push({
      tool: {
        name: 'subagent_spawn_batch',
        description: 'Spawn multiple focused sub-agents in parallel for independent sub-tasks.',
        parameters: subAgentSpawnBatchArgsSchema,
            },
      execute: async (toolArgs, signal) => {
        if (!options.runSubAgent) {
          return {
            content: 'Sub-agent runner is not available in this context.',
            isError: true,
          };
        }

        const normalizedToolArgs: Record<string, unknown> = { ...toolArgs };
        const requestedMaxRetries = normalizedToolArgs.maxRetries;
        if (
          requestedMaxRetries !== undefined
          && (typeof requestedMaxRetries !== 'number' || !Number.isFinite(requestedMaxRetries) || requestedMaxRetries < 0)
        ) {
          delete normalizedToolArgs.maxRetries;
        }

        const spawnValidation = validateSubAgentToolArgs('subagent_spawn_batch', subAgentSpawnBatchArgsSchema, normalizedToolArgs);
        if (!spawnValidation.ok) {
          return {
            content: spawnValidation.message,
            isError: true,
          };
        }

        const rawAgents = Array.isArray(normalizedToolArgs.agents) ? normalizedToolArgs.agents : [];
        if (rawAgents.length === 0) {
          return {
            content: 'Missing agents. Provide at least one sub-agent request.',
            isError: true,
          };
        }

        const requestedConcurrency = asPositiveInteger(toolArgs.concurrency)
          ?? options.batchConcurrency
          ?? SUBAGENT_BATCH_DEFAULT_CONCURRENCY;
        const concurrency = clampWithMax(requestedConcurrency, SUBAGENT_BATCH_MAX_CONCURRENCY);
        const adaptiveConcurrency = asBoolean(toolArgs.adaptiveConcurrency)
          ?? options.adaptiveConcurrency
          ?? false;
        const minConcurrency = clampWithMax(
          asPositiveInteger(toolArgs.minConcurrency)
            ?? options.batchMinConcurrency
            ?? SUBAGENT_BATCH_MIN_CONCURRENCY,
          SUBAGENT_BATCH_MAX_CONCURRENCY,
        );
        const maxRetries = Math.max(0, Math.floor(asNumber(toolArgs.maxRetries) ?? 2));

        const requestInputs = rawAgents.filter((entry): entry is Record<string, unknown> => isRecord(entry));
        if (requestInputs.length === 0) {
          return {
            content: 'Missing agents. Provide at least one valid sub-agent request.',
            isError: true,
          };
        }

        let requests: SubAgentRequest[];
        try {
          requests = await mapWithConcurrency(
            requestInputs,
            concurrency,
            async (entry) => buildSubAgentRequestFromToolArgs(options.cwd, entry, {
              fileReadCache: options.fileReadCache,
            }),
          );
        } catch (error) {
          return {
            content: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }

                const requiresGithubCopilotPreflight = requests.some((request) => {
          const effectiveProvider = (request.provider ?? options.provider ?? '').trim().toLowerCase();
          return effectiveProvider === 'github-copilot';
        });

        if (requiresGithubCopilotPreflight) {
          if (!options.resolveGithubToken) {
            const message = [
              'subagent_spawn_batch preflight failed: provider=github-copilot requires token resolution, but resolveGithubToken is not configured.',
              'Action required: refresh/re-auth GitHub Copilot credentials and retry.',
            ].join(' ');
            console.warn(`[coordination-tools] ${message}`);
            return {
              content: message,
              isError: true,
            };
          }

          let githubToken: string | undefined;
          try {
            githubToken = await options.resolveGithubToken({
              minimumTtlSeconds: SUBAGENT_BATCH_GITHUB_TOKEN_PRECHECK_MIN_TTL_SECONDS,
            });
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const message = [
              'subagent_spawn_batch preflight failed: provider=github-copilot token refresh/reacquisition threw an error.',
              `reason=${reason.replace(/\s+/g, ' ').trim()}`,
              'Action required: refresh/re-auth GitHub Copilot credentials and retry.',
            ].join(' ');
            console.warn(`[coordination-tools] ${message}`);
            return {
              content: message,
              isError: true,
            };
          }

          if (!githubToken) {
            const message = [
              'subagent_spawn_batch preflight failed: provider=github-copilot token is missing, expired, or below the required TTL threshold.',
              `requiredMinimumTtlSeconds=${SUBAGENT_BATCH_GITHUB_TOKEN_PRECHECK_MIN_TTL_SECONDS}`,
              'Action required: refresh/re-auth GitHub Copilot credentials and retry.',
            ].join(' ');
            console.warn(`[coordination-tools] ${message}`);
            return {
              content: message,
              isError: true,
            };
          }
        }

        const state = await readCoordinationState(statePath);

        const cacheHits = new Map<number, {

          request: SubAgentRequest;
          record: SubAgentRunRecord;
          run: SubAgentBatchRunResult;
        }>();
        const misses: Array<{ request: SubAgentRequest; requestIndex: number }> = [];

        requests.forEach((request, requestIndex) => {
          const nodeId = request.nodeId?.trim();
          if (!nodeId) {
            misses.push({ request, requestIndex });
            return;
          }

          const cachedRecord = findLatestCompletedSubAgentByNodeId(state.subAgents, nodeId);
          if (!cachedRecord || !cachedRecord.mergePayload) {
            misses.push({ request, requestIndex });
            return;
          }

          const promptPreview = cachedRecord.promptPreview ?? compactPromptPreview(request.prompt);
          const usage = usageOrZero(cachedRecord.usage);
          const usageReported = cachedRecord.usageReported ?? Boolean(cachedRecord.usage);

          cacheHits.set(requestIndex, {
            request,
            record: cachedRecord,
            run: {
              id: cachedRecord.id,
              nodeId,
              status: 'completed',
              promptChars: request.prompt.length,
              promptPreview,
              outputPreview: cachedRecord.outputPreview ?? cachedRecord.mergePayload.summary,
              mergePayload: cachedRecord.mergePayload,
              usage,
              usageReported,
              cacheHit: true,
            },
          });
        });

        const startIndex = state.subAgents.length;
        const allRecords = misses.map(({ request }, index) => ({
          id: `sub-${startIndex + index + 1}`,
          nodeId: request.nodeId,
          prompt: request.prompt,
          status: 'running' as const,
          provider: request.provider,
          model: request.model,
          reasoning: request.reasoning,
          startedAt: now(),
        }));

        if (allRecords.length > 0) {
          state.subAgents.push(...allRecords);
          state.updatedAt = now();
          await writeCoordinationState(statePath, state);
        }

        const recordByRequestIndex = new Map<number, SubAgentRunRecord>();
        misses.forEach((miss, index) => {
          recordByRequestIndex.set(miss.requestIndex, allRecords[index]);
        });

        const settledByRequestIndex = new Map<number, SubAgentBatchRunResult>();
        let pending = misses.map((miss, index) => ({
          request: miss.request,
          requestIndex: miss.requestIndex,
          record: allRecords[index],
        }));
        const dispatchedNodeIds: string[] = [];
        let finalConcurrency = allRecords.length > 0 ? concurrency : 0;
        let windows = 0;
        let previousFailureSignature: string | undefined;
        let consecutiveIdenticalFailures = 0;
        let breakerTripped = false;

        for (let attempt = 0; pending.length > 0 && attempt <= maxRetries; attempt += 1) {
          const mapper = async (
            pendingEntry: { request: SubAgentRequest; requestIndex: number; record: SubAgentRunRecord },
          ): Promise<SubAgentBatchRunResult> => {
            const request = pendingEntry.request;
            const record = pendingEntry.record;
            try {
              const result = await options.runSubAgent?.(request, signal);
              const mergePayload = buildSubAgentMergePayload(result ?? { text: '' }, record.id, request);
              return {
                id: record.id,
                nodeId: record.nodeId,
                status: 'completed' as const,
                promptChars: request.prompt.length,
                promptPreview: compactPromptPreview(request.prompt),
                outputPreview: mergePayload.summary,
                mergePayload,
                usage: usageOrZero(result?.usage),
                usageReported: Boolean(result?.usage),
                cacheHit: false as const,
              };
            } catch (error) {
              return {
                id: record.id,
                nodeId: record.nodeId,
                status: 'failed' as const,
                promptChars: request.prompt.length,
                promptPreview: compactPromptPreview(request.prompt),
                error: error instanceof Error ? error.message : String(error),
                cacheHit: false as const,
              };
            }
          };

          const batchRun = adaptiveConcurrency
            ? await mapWithAdaptiveConcurrency(pending, {
                initialConcurrency: concurrency,
                minConcurrency,
                maxConcurrency: SUBAGENT_BATCH_MAX_CONCURRENCY,
              }, mapper, (result) => result.status === 'failed')
            : {
                results: await mapWithConcurrency(pending, concurrency, mapper),
                finalConcurrency: concurrency,
                windows: 1,
              };

          finalConcurrency = batchRun.finalConcurrency;
          windows += batchRun.windows;

          const nextPending: typeof pending = [];
          const failedPendingEntries: Array<{
            pendingEntry: typeof pending[number];
            result: SubAgentBatchRunResult;
          }> = [];
          batchRun.results.forEach((result, pendingIndex) => {
            const pendingEntry = pending[pendingIndex];
            dispatchedNodeIds.push(
              pendingEntry.request.nodeId
                ?? pendingEntry.record.id,
            );

            if (result.status === 'completed') {
              settledByRequestIndex.set(pendingEntry.requestIndex, result);
              return;
            }

            failedPendingEntries.push({ pendingEntry, result });
            if (attempt < maxRetries) {
              nextPending.push(pendingEntry);
            } else {
              settledByRequestIndex.set(pendingEntry.requestIndex, result);
            }
          });

          pending = nextPending;

          if (failedPendingEntries.length > 0) {
            const failureSignature = JSON.stringify({
              failedNodeIds: failedPendingEntries
                .map(({ pendingEntry }) => pendingEntry.request.nodeId ?? pendingEntry.record.id)
                .sort(),
              errors: failedPendingEntries
                .map(({ result }) => `${result.nodeId ?? result.id}:${(result.error ?? 'unknown-error').replace(/\s+/g, ' ').trim()}`)
                .sort(),
            });

            if (failureSignature === previousFailureSignature) {
              consecutiveIdenticalFailures += 1;
            } else {
              previousFailureSignature = failureSignature;
              consecutiveIdenticalFailures = 1;
            }

            if (consecutiveIdenticalFailures > SUBAGENT_BATCH_IDENTICAL_FAILURE_CAP) {
              breakerTripped = true;
              for (const { pendingEntry, result } of failedPendingEntries) {
                settledByRequestIndex.set(pendingEntry.requestIndex, {
                  id: result.id,
                  nodeId: result.nodeId,
                  status: 'failed',
                  promptChars: result.promptChars,
                  promptPreview: result.promptPreview,
                  error: [
                    'Circuit breaker tripped: identical subagent batch failures repeated more than twice consecutively.',
                    'Manual intervention or explicit backoff is required before retrying this batch.',
                    `failedNodeId=${result.nodeId ?? result.id}`,
                  ].join(' '),
                  cacheHit: false,
                });
              }
              pending = [];
              break;
            }
          }

          if (pending.length > 0 && attempt < maxRetries) {
            await sleepWithSignal(200 * (2 ** attempt), signal);
          }
        }

        const settled = requests.map((request, requestIndex) => {
          const cached = cacheHits.get(requestIndex);
          if (cached) {
            return cached.run;
          }

          const executed = settledByRequestIndex.get(requestIndex);
          if (executed) {
            return executed;
          }

          const record = recordByRequestIndex.get(requestIndex);
          return {
            id: record?.id ?? `unknown-${requestIndex + 1}`,
            nodeId: request.nodeId,
            status: 'failed' as const,
            promptChars: request.prompt.length,
            promptPreview: compactPromptPreview(request.prompt),
            error: 'Missing sub-agent execution result.',
            cacheHit: false as const,
          };
        });

        const usageTotals = settled.reduce<UsageTotals>((totals, entry) => {
          if (entry.status !== 'completed' || !entry.usage) {
            return totals;
          }

          totals.input += entry.usage.input;
          totals.output += entry.usage.output;
          totals.cost += entry.usage.cost;
          return totals;
        }, { input: 0, output: 0, cost: 0 });

        const promptSizes = settled.map((entry) => entry.promptChars ?? 0);
        const totalPromptChars = promptSizes.reduce((sum, value) => sum + value, 0);
        const maxPromptChars = promptSizes.length > 0 ? Math.max(...promptSizes) : 0;
        const oversized = settled.filter((entry) => (entry.promptChars ?? 0) > SUBAGENT_PROMPT_SOFT_LIMIT_CHARS);

        if (allRecords.length > 0) {
          const latest = await readCoordinationState(statePath);
          for (const result of settled) {
            const current = latest.subAgents.find((entry) => entry.id === result.id);
            if (!current) {
              continue;
            }

            current.status = result.status;
            current.finishedAt = now();
            current.promptPreview = result.promptPreview;
            current.usage = result.usage;
            current.usageReported = result.usageReported;
            if (result.status === 'completed') {
              current.outputPreview = result.outputPreview;
              current.mergePayload = result.mergePayload;
              current.error = undefined;
            } else {
              current.outputPreview = undefined;
              current.mergePayload = undefined;
              current.usage = undefined;
              current.usageReported = undefined;
              current.error = result.error;
            }
          }

          latest.updatedAt = now();
          await writeCoordinationState(statePath, latest);
        }

        const failedCount = settled.filter((entry) => entry.status === 'failed').length;
        const failedNodeIds = settled
          .filter((entry) => entry.status === 'failed')
          .map((entry) => entry.nodeId ?? entry.id);
        const summary = {
          total: settled.length,
          concurrency,
          adaptiveConcurrency,
          minConcurrency,
          maxRetries,
          status: breakerTripped ? 'escalated_error' : undefined,
          reason: breakerTripped ? 'identical_subagent_batch_failures_repeated' : undefined,
          identicalFailureCap: breakerTripped ? SUBAGENT_BATCH_IDENTICAL_FAILURE_CAP : undefined,
          consecutiveIdenticalFailures: breakerTripped ? consecutiveIdenticalFailures : undefined,
          actionRequired: breakerTripped ? 'manual_intervention_or_backoff_before_retry' : undefined,
          finalConcurrency,
          windows,
          completed: settled.length - failedCount,
          failed: failedCount,
          failedNodeIds,
          usage: usageTotals,
          cacheHitCount: cacheHits.size,
          cacheMissCount: misses.length,
          cachedNodeIds: Array.from(cacheHits.values()).map((entry) => entry.record.nodeId ?? entry.record.id),
          dispatchedNodeIds,
          decomposition: {
            totalPromptChars,
            averagePromptChars: settled.length > 0 ? Math.round(totalPromptChars / settled.length) : 0,
            maxPromptChars,
            promptSoftLimitChars: SUBAGENT_PROMPT_SOFT_LIMIT_CHARS,
            oversizedTasks: oversized.map((entry) => entry.nodeId ?? entry.id),
          },
          runs: settled,
        };

        return {
          content: JSON.stringify(summary, null, 2),
          isError: failedCount > 0,
        };
      },
    });
  }

  const modeController = options.modeController;
  if (modeController) {
    tools.push(
      {
        tool: {
          name: 'mode_get',
          description: 'Get the currently active execution mode for this session context.',
          parameters: Type.Object({}),
        },
        execute: async () => {
          const activeMode = modeController.getMode();
          const available = modeController.availableModes ?? ['chat', 'planning', 'implementation'];
          return {
            content: JSON.stringify({ mode: activeMode, availableModes: available }, null, 2),
          };
        },
      },
      {
        tool: {
          name: 'mode_set',
          description: 'Switch execution mode (chat/planning/implementation) for subsequent actions.',
          parameters: Type.Object({
            mode: modeSchema,
            reason: Type.Optional(Type.String()),
          }),
        },
                execute: async (toolArgs) => {
          const mode = normalizeAgentToolPhase(toolArgs.mode);
          if (!mode) {
            return {
              content: 'Missing mode. Expected one of: chat, planning, implementation.',
              isError: true,
            };
          }

          const reason = optionalString(toolArgs.reason);
          const result = await modeController.setMode(mode, reason);
          const state = await readCoordinationState(statePath);
          if (result.mode === 'implementation' && !state.planLocked) {
            state.planLocked = true;
            state.updatedAt = now();
            await writeCoordinationState(statePath, state);
          }
          return {
            content: result.detail
              ?? (result.changed ? `Mode switched to ${result.mode}.` : `Mode remains ${result.mode}.`),
            details: {
              mode: result.mode,
              changed: result.changed,
            },
          };
        },
      },

    );
  }

  return tools;
}

function usageOrZero(usage: { input: number; output: number; cost: number } | undefined): UsageTotals {
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cost: usage?.cost ?? 0,
  };
}

function normalizeValidationDetails(
  message: string,
  schema: typeof subAgentSpawnArgsSchema | typeof subAgentSpawnBatchArgsSchema,
  args: Record<string, unknown>,
): string {
  const normalized = message
    .replace(/\b([a-zA-Z0-9_]+(?:\/[a-zA-Z0-9_]+)+)\b/g, (match) => match.replace(/\//g, '.'));

  if (!/additional properties/i.test(normalized)) {
    return normalized;
  }

  const additionalPropertyPaths = new Set<string>();
  const pathRegex = /-\s+([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*):\s+[^\n]*additional properties/gi;
  for (const match of normalized.matchAll(pathRegex)) {
    const parentPath = match[1];
    const valueAtPath = getValueAtDottedPath(args, parentPath);
    const schemaAtPath = getSchemaAtDottedPath(schema, parentPath);
    if (!isRecord(valueAtPath) || !isRecord(schemaAtPath) || !isRecord(schemaAtPath.properties)) {
      continue;
    }

    const allowedKeys = new Set(Object.keys(schemaAtPath.properties));
    for (const key of Object.keys(valueAtPath)) {
      if (!allowedKeys.has(key)) {
        additionalPropertyPaths.add(`${parentPath}.${key}`);
      }
    }
  }

  if (additionalPropertyPaths.size === 0) {
    const pathMatch = normalized.match(/\b([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)\b/);
    const keyMatch = normalized.match(/additionalProperty\s+["']([^"']+)["']/i)
      ?? normalized.match(/property\s+["']([^"']+)["']/i);
    if (pathMatch && keyMatch) {
      additionalPropertyPaths.add(`${pathMatch[1]}.${keyMatch[1]}`);
    }
  }

  const missingPaths = [...additionalPropertyPaths].filter((path) => !normalized.includes(path));
  if (missingPaths.length === 0) {
    return normalized;
  }

  // Keep canonical phrase and include explicit offending path(s) for additionalProperties violations.
  return `${normalized} (additional properties at ${missingPaths.join(', ')})`;
}

function getValueAtDottedPath(root: unknown, dottedPath: string): unknown {
  if (!dottedPath) {
    return root;
  }

  const segments = dottedPath.split('.');
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    if (!isRecord(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function getSchemaAtDottedPath(
  root: unknown,
  dottedPath: string,
): Record<string, unknown> | undefined {
  if (!isRecord(root)) {
    return undefined;
  }

  if (!dottedPath) {
    return root;
  }

  const segments = dottedPath.split('.');
  let current: unknown = root;
  for (const segment of segments) {
    if (!isRecord(current)) {
      return undefined;
    }

    if (/^\d+$/.test(segment)) {
      current = current.items;
      continue;
    }

    if (!isRecord(current.properties)) {
      return undefined;
    }

    current = current.properties[segment];
  }

  return isRecord(current) ? current : undefined;
}


function validateSubAgentToolArgs(
  toolName: SubAgentToolName,
  schema: typeof subAgentSpawnArgsSchema | typeof subAgentSpawnBatchArgsSchema,
  args: Record<string, unknown>,
): { ok: true } | { ok: false; message: string } {
  try {
    validateToolCall(
      [{ name: toolName, description: `${toolName} validation`, parameters: schema }],
      { type: 'toolCall', id: `validate-${toolName}`, name: toolName, arguments: args },
    );
    return { ok: true };
  } catch (error) {
        const details = normalizeValidationDetails(
      error instanceof Error ? error.message : String(error),
      schema,
      args,
    );
    const message = `${toolName} argument validation failed before spawn: ${details}`;
    console.warn(`[coordination-tools] ${message}`);
    return { ok: false, message };
  }
}


async function buildSubAgentRequestFromToolArgs(
  cwd: string,
  toolArgs: Record<string, unknown>,
  options?: {
    fileReadCache?: AgentToolsetOptions['fileReadCache'];
  },
): Promise<SubAgentRequest> {
  const packet = normalizeSubAgentContextPacket(toolArgs.contextPacket);
  const legacyPrompt = optionalString(toolArgs.prompt) ?? '';

  if (!legacyPrompt && !packet?.objective) {
    throw new Error('Missing prompt. Provide prompt or contextPacket.objective.');
  }

  const prompt = await enrichDelegationPromptWithFileSnippets(
    cwd,
    buildSubAgentPrompt(legacyPrompt, packet),
    {
      providedSnippets: packet?.fileSnippets,
      fileReadCache: options?.fileReadCache,
    },
  );

  return {
    nodeId: optionalString(toolArgs.nodeId),
    prompt,
    contextPacket: packet,
    systemPrompt: optionalString(toolArgs.systemPrompt),
    provider: optionalString(toolArgs.provider),
    model: optionalString(toolArgs.model),
    reasoning: normalizeReasoning(toolArgs.reasoning),
  };
}

function normalizeSubAgentContextPacket(value: unknown): SubAgentContextPacket | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const objective = optionalString(value.objective);
  if (!objective) {
    return undefined;
  }

  const boundariesRecord = isRecord(value.boundaries) ? value.boundaries : undefined;
  type WritePolicy = NonNullable<NonNullable<SubAgentContextPacket['boundaries']>['writePolicy']>;
  const writePolicy = boundariesRecord?.writePolicy;
  const normalizedWritePolicy: WritePolicy | undefined =
    writePolicy === 'read_only' ? 'none'
    : writePolicy === 'none' || writePolicy === 'scoped' || writePolicy === 'full' ? writePolicy
    : undefined;

  const boundaries = (normalizedWritePolicy
    || optionalStringArray(boundariesRecord?.allowedTools)
    || asPositiveInteger(boundariesRecord?.timeoutMs))
    ? {
      writePolicy: normalizedWritePolicy,
      allowedTools: optionalStringArray(boundariesRecord?.allowedTools),
      timeoutMs: asPositiveInteger(boundariesRecord?.timeoutMs),
    }
    : undefined;

  return {
    objective,
    boundaries,
    relevantContext: optionalStringArray(value.relevantContext),
    requiredOutputSchema: optionalString(value.requiredOutputSchema),
    evidenceRequirements: optionalStringArray(value.evidenceRequirements),
    fileSnippets: normalizeFileSnippets(value.fileSnippets),
  };
}

function buildSubAgentPrompt(prompt: string, packet?: SubAgentContextPacket): string {
  if (!packet) {
    return prompt;
  }

  const lines: string[] = [
    '[SubAgentContextPacket]',
    `Objective: ${packet.objective}`,
  ];

  if (packet.boundaries) {
    lines.push('Boundaries:');
    if (packet.boundaries.writePolicy) {
      lines.push(`- writePolicy: ${packet.boundaries.writePolicy}`);
    }
    if ((packet.boundaries.allowedTools?.length ?? 0) > 0) {
      lines.push(`- allowedTools: ${packet.boundaries.allowedTools?.join(', ')}`);
    }
    if (packet.boundaries.timeoutMs) {
      lines.push(`- timeoutMs: ${packet.boundaries.timeoutMs}`);
    }
  }

  if ((packet.relevantContext?.length ?? 0) > 0) {
    lines.push('Relevant context:');
    for (const item of packet.relevantContext ?? []) {
      lines.push(`- ${item}`);
    }
  }

  if ((packet.evidenceRequirements?.length ?? 0) > 0) {
    lines.push('Evidence requirements:');
    for (const item of packet.evidenceRequirements ?? []) {
      lines.push(`- ${item}`);
    }
  }

  lines.push('Required output contract:');
  if (packet.requiredOutputSchema) {
    lines.push(packet.requiredOutputSchema);
  } else {
    lines.push(
      'Return concise JSON with keys: summary, actions[], evidence[{type,ref,note?}], risks[], openQuestions[], patchIntent[].',
    );
  }

  if (prompt.trim()) {
    lines.push('Legacy prompt:');
    lines.push(prompt.trim());
  }

  return lines.join('\n');
}

function buildSubAgentMergePayload(result: SubAgentResult, id: string, request: SubAgentRequest): {
  id: string;
  nodeId?: string;
  summary: string;
  actions: string[];
  evidence: SubAgentEvidenceItem[];
  risks: string[];
  openQuestions: string[];
  patchIntent: string[];
  artifact: { outputPreview: string; outputChars: number; promptChars: number };
} {
  const summary = optionalString(result.summary)
    ?? trimText(result.text.replace(/\s+/g, ' ').trim(), SUBAGENT_OUTPUT_PREVIEW_MAX_CHARS);

  return {
    id,
    nodeId: request.nodeId,
    summary,
    actions: normalizeStringList(result.actions),
    evidence: normalizeSubAgentEvidence(result.evidence),
    risks: normalizeStringList(result.risks),
    openQuestions: normalizeStringList(result.openQuestions),
    patchIntent: normalizeStringList(result.patchIntent),
    artifact: {
      outputPreview: trimText(result.text, SUBAGENT_MERGE_OUTPUT_PREVIEW_MAX_CHARS),
      outputChars: result.text.length,
      promptChars: request.prompt.length,
    },
  };
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => optionalString(entry))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 12);
}

function normalizeSubAgentEvidence(value: unknown): SubAgentEvidenceItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const entries: SubAgentEvidenceItem[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }

    const type = item.type;
    if (
      type !== 'file'
      && type !== 'command'
      && type !== 'test'
      && type !== 'log'
      && type !== 'url'
      && type !== 'other'
    ) {
      continue;
    }

    const ref = optionalString(item.ref);
    if (!ref) {
      continue;
    }

    entries.push({
      type,
      ref,
      note: optionalString(item.note),
    });
  }

  return entries.slice(0, 16);
}

function compactPromptPreview(prompt: string): string {
  const compact = prompt.replace(/\s+/g, ' ').trim();
  if (compact.length <= SUBAGENT_PROMPT_PREVIEW_MAX_CHARS) {
    return compact;
  }

  return `${compact.slice(0, SUBAGENT_PROMPT_PREVIEW_MAX_CHARS - 3)}...`;
}

function normalizeAgentToolPhase(value: unknown): AgentToolPhase | undefined {
  if (value !== 'chat' && value !== 'planning' && value !== 'implementation') {
    return undefined;
  }

  return value;
}

async function readCoordinationState(path: string): Promise<CoordinationState> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CoordinationState>;
    const todos = normalizeTodoItems(parsed.todos);
    const nodes = normalizeAgentGraphNodes(parsed.agentGraph?.nodes);
    const subAgents = normalizeSubAgentRecords(parsed.subAgents);
    const planLocked = asBoolean(parsed.planLocked) ?? false;
    const replanCount = normalizeReplanCount(parsed.replanCount);

    return {
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now(),
      todos,
      agentGraph: { nodes },
      subAgents,
      planLocked,
      replanCount,
    };
  } catch {
    return {
      updatedAt: now(),
      todos: [],
      agentGraph: { nodes: [] },
      subAgents: [],
      planLocked: false,
      replanCount: 0,
    };
  }
}


async function writeCoordinationState(path: string, state: CoordinationState): Promise<void> {
  const persistRawDebug = shouldPersistRawDebugArtifacts();
  const payload = sanitizeCoordinationStateForPersistence(state);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf-8');

  if (persistRawDebug) {
    await writeFile(resolveRawArtifactPath(path), JSON.stringify(state, null, 2), 'utf-8');
  }
}

function shouldPersistRawDebugArtifacts(): boolean {
  return asBoolean(process.env[COORDINATION_PERSIST_RAW_DEBUG_ENV]) ?? false;
}

function resolveRawArtifactPath(path: string): string {
  if (path.endsWith('.json')) {
    return `${path.slice(0, -5)}.raw.json`;
  }

  return `${path}.raw.json`;
}

function sanitizeCoordinationStateForPersistence(state: CoordinationState): CoordinationState {
  return {
    ...state,
    todos: state.todos.map((todo) => ({
      ...todo,
      title: sanitizePersistedText(todo.title, COORDINATION_PERSIST_PROMPT_MAX_CHARS),
      details: todo.details
        ? sanitizePersistedText(todo.details, COORDINATION_PERSIST_OUTPUT_MAX_CHARS)
        : todo.details,
    })),
    agentGraph: {
      nodes: state.agentGraph.nodes.map((node) => ({
        ...node,
        name: node.name ? sanitizePersistedText(node.name, 240) : node.name,
        prompt: sanitizePersistedText(node.prompt, COORDINATION_PERSIST_PROMPT_MAX_CHARS),
      })),
    },
    subAgents: state.subAgents.map((record) => ({
      ...record,
      prompt: sanitizePersistedText(record.prompt, COORDINATION_PERSIST_PROMPT_MAX_CHARS),
      promptPreview: record.promptPreview
        ? sanitizePersistedText(record.promptPreview, SUBAGENT_PROMPT_PREVIEW_MAX_CHARS)
        : record.promptPreview,
      outputPreview: record.outputPreview
        ? sanitizePersistedText(record.outputPreview, COORDINATION_PERSIST_OUTPUT_MAX_CHARS)
        : record.outputPreview,
      error: record.error
        ? sanitizePersistedText(record.error, COORDINATION_PERSIST_OUTPUT_MAX_CHARS)
        : record.error,
      mergePayload: record.mergePayload
        ? {
            ...record.mergePayload,
            summary: sanitizePersistedText(record.mergePayload.summary, COORDINATION_PERSIST_OUTPUT_MAX_CHARS),
            actions: record.mergePayload.actions.map((item) => sanitizePersistedText(item, 320)).slice(0, 24),
            risks: record.mergePayload.risks.map((item) => sanitizePersistedText(item, 320)).slice(0, 24),
            openQuestions: record.mergePayload.openQuestions.map((item) => sanitizePersistedText(item, 320)).slice(0, 24),
            patchIntent: record.mergePayload.patchIntent
              .map((item) => sanitizePersistedText(item, 320))
              .slice(0, 24),
          }
        : record.mergePayload,
    })),
  };
}

function sanitizePersistedText(value: string, maxChars: number): string {
  const redacted = redactSensitiveText(value.replace(/\s+/g, ' ').trim());
  if (redacted.length <= maxChars) {
    return redacted;
  }

  return `${redacted.slice(0, maxChars)}... [truncated]`;
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s"',;]+/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi, 'Bearer [REDACTED]')
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g, '[REDACTED_IMAGE_DATA]');
}

function normalizeTodoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const items: TodoItem[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const id = optionalString(entry.id);
    const title = optionalString(entry.title);
    if (!id || !title) {
      continue;
    }

    items.push({
      id,
      title,
      status: normalizeTodoStatus(entry.status) ?? 'todo',
      weight: optionalWeight(entry.weight),
      details: optionalString(entry.details),
      dependsOn: optionalStringArray(entry.dependsOn),
    });
  }

  return items;
}

function normalizeAgentGraphNodes(value: unknown): AgentGraphNode[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const nodes: AgentGraphNode[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const id = optionalString(entry.id);
    const prompt = optionalString(entry.prompt);
    if (!id || !prompt) {
      continue;
    }

    nodes.push({
      id,
      name: optionalString(entry.name),
      prompt,
      weight: optionalWeight(entry.weight),
      dependencies: optionalStringArray(entry.dependencies),
      provider: optionalString(entry.provider),
      model: optionalString(entry.model),
      reasoning: normalizeReasoning(entry.reasoning),
    });
  }

  return nodes;
}

function normalizeSubAgentRecords(value: unknown): SubAgentRunRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const records: SubAgentRunRecord[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const id = optionalString(entry.id);
    const prompt = optionalString(entry.prompt);
    if (!id || !prompt) {
      continue;
    }

    const status = normalizeSubAgentStatus(entry.status) ?? 'failed';
    records.push({
      id,
      nodeId: optionalString(entry.nodeId),
      prompt,
      status,
      provider: optionalString(entry.provider),
      model: optionalString(entry.model),
      reasoning: normalizeReasoning(entry.reasoning),
      startedAt: optionalString(entry.startedAt) ?? now(),
      finishedAt: optionalString(entry.finishedAt),
      promptPreview: optionalString(entry.promptPreview),
      outputPreview: optionalString(entry.outputPreview),
      error: optionalString(entry.error),
      usage: normalizeUsageTotals(entry.usage),
      usageReported: asBoolean(entry.usageReported),
      mergePayload: normalizeCachedSubAgentMergePayload(entry.mergePayload),
    });
  }

  return records;
}

function normalizeSubAgentStatus(value: unknown): SubAgentRunRecord['status'] | undefined {
  if (value === 'running' || value === 'completed' || value === 'failed') {
    return value;
  }

  return undefined;
}

function normalizeUsageTotals(value: unknown): UsageTotals | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const input = asNumber(value.input);
  const output = asNumber(value.output);
  const cost = asNumber(value.cost);
  if (input === undefined || output === undefined || cost === undefined) {
    return undefined;
  }

  return { input, output, cost };
}

function normalizeCachedSubAgentMergePayload(value: unknown): CachedSubAgentMergePayload | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const summary = optionalString(value.summary);
  if (!summary) {
    return undefined;
  }

  return {
    summary,
    actions: optionalStringArray(value.actions) ?? [],
    evidence: normalizeSubAgentEvidence(value.evidence),
    risks: optionalStringArray(value.risks) ?? [],
    openQuestions: optionalStringArray(value.openQuestions) ?? [],
    patchIntent: Array.isArray(value.patchIntent)
      ? normalizeStringList(value.patchIntent)
      : normalizeStringList([value.patchIntent]),
    artifact: value.artifact,
  };
}

function findLatestCompletedSubAgentByNodeId(records: SubAgentRunRecord[], nodeId: string): SubAgentRunRecord | undefined {
  const normalizedNodeId = nodeId.trim();
  if (!normalizedNodeId) {
    return undefined;
  }

  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.status !== 'completed') {
      continue;
    }

    if ((record.nodeId ?? '').trim() !== normalizedNodeId) {
      continue;
    }

    return record;
  }

  return undefined;
}

function normalizeTodoStatus(value: unknown): TodoItem['status'] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (normalized === 'todo' || normalized === 'pending' || normalized === 'backlog' || normalized === 'open') {
    return 'todo';
  }

  if (
    normalized === 'in_progress'
    || normalized === 'inprogress'
    || normalized === 'doing'
    || normalized === 'active'
    || normalized === 'wip'
  ) {
    return 'in_progress';
  }

  if (
    normalized === 'done'
    || normalized === 'completed'
    || normalized === 'complete'
    || normalized === 'finished'
    || normalized === 'closed'
    || normalized === 'resolved'
  ) {
    return 'done';
  }

  return undefined;
}

function normalizeReasoning(value: unknown): 'minimal' | 'low' | 'medium' | 'high' | undefined {
  if (value === 'minimal' || value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }

  return undefined;
}

function asString(value: unknown, field: string): string {
  const parsed = optionalString(value);
  if (!parsed) {
    throw new Error(`Missing ${field}`);
  }

  return parsed;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return value;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result = value
    .map((entry) => optionalString(entry))
    .filter((entry): entry is string => Boolean(entry));

  return result.length > 0 ? result : undefined;
}

function optionalWeight(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.round(value * 100) / 100;
}

function trimText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n... (truncated)`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function enrichDelegationPromptWithFileSnippets(
  cwd: string,
  prompt: string,
  options?: {
    providedSnippets?: SubAgentFileSnippet[];
    fileReadCache?: AgentToolsetOptions['fileReadCache'];
  },
): Promise<string> {
  const trimmed = prompt.trim();
  if (!trimmed || trimmed.includes(SUBAGENT_CONTEXT_MARKER)) {
    return prompt;
  }

  const providedSnippets = normalizeFileSnippets(options?.providedSnippets) ?? [];
  const snippetByPath = new Map<string, SubAgentFileSnippet>();
  for (const snippet of providedSnippets) {
    const normalizedPath = normalizePromptPath(snippet.path);
    if (!normalizedPath || snippetByPath.has(normalizedPath)) {
      continue;
    }
    snippetByPath.set(normalizedPath, {
      path: normalizedPath,
      content: trimText(snippet.content.trim(), SUBAGENT_CONTEXT_MAX_CHARS_PER_FILE),
    });
  }

  const extractedPaths = extractCandidateFilePaths(trimmed);
  const missingPaths = extractedPaths.filter((filePath) => !snippetByPath.has(filePath));
  if (missingPaths.length > 0 && snippetByPath.size < SUBAGENT_CONTEXT_MAX_FILES) {
    const fallbackSnippets = await collectFileSnippets(cwd, missingPaths, {
      fileReadCache: options?.fileReadCache,
    });
    for (const snippet of fallbackSnippets) {
      if (snippetByPath.size >= SUBAGENT_CONTEXT_MAX_FILES) {
        break;
      }
      if (!snippetByPath.has(snippet.path)) {
        snippetByPath.set(snippet.path, snippet);
      }
    }
  }

  const snippets = [...snippetByPath.values()].slice(0, SUBAGENT_CONTEXT_MAX_FILES);
  if (snippets.length === 0) {
    return prompt;
  }

  const contextLines: string[] = [
    '',
    `[${SUBAGENT_CONTEXT_MARKER}]`,
    'Referenced files were detected in the delegated prompt. Use these exact snippets when planning your answer.',
  ];

  for (const snippet of snippets) {
    contextLines.push(`File: ${snippet.path}`);
    contextLines.push('```');
    contextLines.push(snippet.content);
    contextLines.push('```');
  }

  return `${prompt}\n${contextLines.join('\n')}`;
}

function extractCandidateFilePaths(prompt: string): string[] {
  const matches = prompt.matchAll(PROMPT_FILE_PATH_PATTERN);
  const unique = new Set<string>();

  for (const match of matches) {
    const candidate = match[1]?.trim();
    if (!candidate) {
      continue;
    }

    const normalized = normalizePromptPath(candidate);
    if (normalized) {
      unique.add(normalized);
    }
  }

  return [...unique];
}

function normalizeFileSnippets(value: unknown): SubAgentFileSnippet[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const snippets: SubAgentFileSnippet[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const path = normalizePromptPath(entry.path);
    const content = optionalString(entry.content);
    if (!path || content === undefined) {
      continue;
    }

    snippets.push({ path, content });
  }

  return snippets.length > 0 ? snippets : undefined;
}

async function collectFileSnippets(
  cwd: string,
  filePaths: string[],
  options?: {
    fileReadCache?: AgentToolsetOptions['fileReadCache'];
  },
): Promise<SubAgentFileSnippet[]> {
  const revision = await resolveRevision(cwd);
  const candidates = filePaths.map((filePath, index) => ({ filePath, index }));
  const results = await mapWithConcurrency(candidates, SUBAGENT_SNIPPET_READ_CONCURRENCY, async (candidate) => {
    const absolutePath = resolve(cwd, candidate.filePath);
    if (!isWithinDirectory(absolutePath, cwd)) {
      return undefined;
    }

    const relativePath = toPosixPath(relative(cwd, absolutePath));
    try {
      const cache = options?.fileReadCache;
      if (isSessionFileReadCache(cache)) {
        const fullContent = await readFullFileWithCache(absolutePath, { cache });
        if (fullContent.includes('\u0000')) {
          return undefined;
        }

        return {
          index: candidate.index,
          path: relativePath,
          content: trimText(fullContent.trim(), SUBAGENT_CONTEXT_MAX_CHARS_PER_FILE),
        };
      }

      const cached = cache?.get({
        path: absolutePath,
        revision,
        startLine: 1,
        endLine: undefined,
        maxChars: SUBAGENT_CONTEXT_MAX_CHARS_PER_FILE,
      });
      const content = cached ?? await readFile(absolutePath, 'utf-8');
      if (content.includes('\u0000')) {
        return undefined;
      }

      const trimmedContent = trimText(content.trim(), SUBAGENT_CONTEXT_MAX_CHARS_PER_FILE);
      if (!cached) {
        cache?.set({
          path: absolutePath,
          revision,
          startLine: 1,
          endLine: undefined,
          maxChars: SUBAGENT_CONTEXT_MAX_CHARS_PER_FILE,
        }, trimmedContent);
      }

      return {
        index: candidate.index,
        path: relativePath,
        content: trimmedContent,
      };
    } catch {
      return undefined;
    }
  });

  return results
    .filter((entry): entry is { index: number; path: string; content: string } => Boolean(entry))
    .sort((a, b) => a.index - b.index)
    .slice(0, SUBAGENT_CONTEXT_MAX_FILES)
    .map((entry) => ({ path: entry.path, content: entry.content }));
}

function isSessionFileReadCache(cache: AgentToolsetOptions['fileReadCache'] | undefined): cache is SessionFileReadCache {
  return cache instanceof Map;
}

function normalizePromptPath(path: unknown): string | undefined {
  if (typeof path !== 'string') {
    return undefined;
  }

  const trimmed = path.trim().replace(/^\.\//, '');
  return trimmed.length > 0 ? toPosixPath(trimmed) : undefined;
}

const revisionByCwd = new Map<string, string>();

async function resolveRevision(cwd: string): Promise<string> {
  const existing = revisionByCwd.get(cwd);
  if (existing) {
    return existing;
  }

  try {
    const { runCommand } = await import('./command-tools/command-runner.js');
    const result = await runCommand('git', ['rev-parse', 'HEAD'], {
      cwd,
      timeoutMs: 5_000,
    });
    const revision = result.exitCode === 0
      ? result.stdout.trim()
      : '';
    const normalized = revision || 'no-git-revision';
    revisionByCwd.set(cwd, normalized);
    return normalized;
  } catch {
    revisionByCwd.set(cwd, 'no-git-revision');
    return 'no-git-revision';
  }
}

function isWithinDirectory(path: string, cwd: string): boolean {
  const root = resolve(cwd);
  const target = resolve(path);
  return target === root || target.startsWith(`${root}${sep}`);
}

function toPosixPath(path: string): string {
  return path.split(sep).join('/');
}

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeReplanCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }

  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : 0;
}

function asBoolean(value: unknown): boolean | undefined {

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return undefined;
}

function clampWithMax(value: number, max: number): number {
  return Math.max(1, Math.min(max, value));
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (values.length === 0) {
    return [];
  }

  const results = new Array<U>(values.length);
  const workerCount = Math.min(concurrency, values.length);
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(values[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new Error('Operation aborted'));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal?.aborted) {
      cleanup();
      reject(new Error('Operation aborted'));
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function mapWithAdaptiveConcurrency<T, U>(
  values: readonly T[],
  options: {
    initialConcurrency: number;
    minConcurrency: number;
    maxConcurrency: number;
  },
  mapper: (value: T, index: number) => Promise<U>,
  isFailure: (result: U) => boolean,
): Promise<{ results: U[]; finalConcurrency: number; windows: number }> {
  if (values.length === 0) {
    return { results: [], finalConcurrency: options.initialConcurrency, windows: 0 };
  }

  const results = new Array<U>(values.length);
  let nextIndex = 0;
  let currentConcurrency = clampWithMax(options.initialConcurrency, options.maxConcurrency);
  const minConcurrency = Math.max(1, Math.min(options.maxConcurrency, options.minConcurrency));
  let windows = 0;

  while (nextIndex < values.length) {
    const start = nextIndex;
    const end = Math.min(values.length, start + currentConcurrency);
    const indexes = [] as number[];
    for (let index = start; index < end; index += 1) {
      indexes.push(index);
    }

    const batchResults = await Promise.all(indexes.map(async (index) => mapper(values[index], index)));
    for (let offset = 0; offset < batchResults.length; offset += 1) {
      results[indexes[offset]] = batchResults[offset];
    }

    windows += 1;
    const failures = batchResults.reduce((count, result) => (isFailure(result) ? count + 1 : count), 0);
    currentConcurrency = failures === 0
      ? Math.min(options.maxConcurrency, currentConcurrency * 2)
      : Math.max(minConcurrency, Math.floor(currentConcurrency / 2));
    nextIndex = end;
  }

  return {
    results,
    finalConcurrency: currentConcurrency,
    windows,
  };
}

function now(): string {
  return new Date().toISOString();
}
