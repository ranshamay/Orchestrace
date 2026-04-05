import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Type } from '@mariozechner/pi-ai';
import type {
  AgentToolPhase,
  AgentGraphNode,
  AgentToolsetOptions,
  RegisteredAgentTool,
  SubAgentContextPacket,
  SubAgentEvidenceItem,
  SubAgentRequest,
  SubAgentResult,
  TodoItem,
} from './types.js';
import { sanitizeForPathSegment } from './path-utils.js';

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
const SUBAGENT_PROMPT_SOFT_LIMIT_CHARS = 2200;
const SUBAGENT_PROMPT_PREVIEW_MAX_CHARS = 220;
const SUBAGENT_OUTPUT_PREVIEW_MAX_CHARS = 900;
const SUBAGENT_MERGE_OUTPUT_PREVIEW_MAX_CHARS = 600;
const COORDINATION_PERSIST_RAW_DEBUG_ENV = 'ORCHESTRACE_PERSIST_RAW_DEBUG';
const COORDINATION_PERSIST_PROMPT_MAX_CHARS = 1_600;
const COORDINATION_PERSIST_OUTPUT_MAX_CHARS = 1_000;
const PROMPT_FILE_PATH_PATTERN = /(?:^|[\s`"'])((?:\.?\.?\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.[A-Za-z0-9._-]+)(?=$|[\s`"':),])/g;

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
});

interface CoordinationToolsOptions extends AgentToolsetOptions {
  includeSubAgentTool: boolean;
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
}

interface UsageTotals {
  input: number;
  output: number;
  cost: number;
}

interface CoordinationState {
  updatedAt: string;
  todos: TodoItem[];
  agentGraph: { nodes: AgentGraphNode[] };
  subAgents: SubAgentRunRecord[];
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
        parameters: Type.Object({
          nodeId: Type.Optional(Type.String()),
          prompt: Type.Optional(Type.String({ minLength: 1 })),
          contextPacket: Type.Optional(subAgentContextPacketSchema),
          systemPrompt: Type.Optional(Type.String()),
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
      },
      execute: async (toolArgs, signal) => {
        if (!options.runSubAgent) {
          return {
            content: 'Sub-agent runner is not available in this context.',
            isError: true,
          };
        }

        let request: SubAgentRequest;
        try {
          request = await buildSubAgentRequestFromToolArgs(options.cwd, toolArgs);
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
        parameters: Type.Object({
          agents: Type.Array(
            Type.Object({
              nodeId: Type.Optional(Type.String()),
              prompt: Type.Optional(Type.String({ minLength: 1 })),
              contextPacket: Type.Optional(subAgentContextPacketSchema),
              systemPrompt: Type.Optional(Type.String()),
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
            { minItems: 1 },
          ),
          concurrency: Type.Optional(Type.Number({ minimum: 1, maximum: SUBAGENT_BATCH_MAX_CONCURRENCY })),
          adaptiveConcurrency: Type.Optional(Type.Boolean({ description: 'Automatically tune concurrency based on sub-agent failures while processing the batch.' })),
          minConcurrency: Type.Optional(Type.Number({ minimum: 1, maximum: SUBAGENT_BATCH_MAX_CONCURRENCY })),
        }),
      },
      execute: async (toolArgs, signal) => {
        if (!options.runSubAgent) {
          return {
            content: 'Sub-agent runner is not available in this context.',
            isError: true,
          };
        }

        const rawAgents = Array.isArray(toolArgs.agents) ? toolArgs.agents : [];
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
            async (entry) => buildSubAgentRequestFromToolArgs(options.cwd, entry),
          );
        } catch (error) {
          return {
            content: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }

        const state = await readCoordinationState(statePath);
        const startIndex = state.subAgents.length;
        const records: SubAgentRunRecord[] = requests.map((request, index) => ({
          id: `sub-${startIndex + index + 1}`,
          nodeId: request.nodeId,
          prompt: request.prompt,
          status: 'running',
          provider: request.provider,
          model: request.model,
          reasoning: request.reasoning,
          startedAt: now(),
        }));

        state.subAgents.push(...records);
        state.updatedAt = now();
        await writeCoordinationState(statePath, state);

        const mapper = async (record: SubAgentRunRecord, index: number) => {
          const request = requests[index];
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
            };
          } catch (error) {
            return {
              id: record.id,
              nodeId: record.nodeId,
              status: 'failed' as const,
              promptChars: request.prompt.length,
              promptPreview: compactPromptPreview(request.prompt),
              error: error instanceof Error ? error.message : String(error),
            };
          }
        };

        const batchRun = adaptiveConcurrency
          ? await mapWithAdaptiveConcurrency(records, {
              initialConcurrency: concurrency,
              minConcurrency,
              maxConcurrency: SUBAGENT_BATCH_MAX_CONCURRENCY,
            }, mapper, (result) => result.status === 'failed')
          : {
              results: await mapWithConcurrency(records, concurrency, mapper),
              finalConcurrency: concurrency,
              windows: 1,
            };

        const settled = batchRun.results;
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

        const latest = await readCoordinationState(statePath);
        for (const result of settled) {
          const current = latest.subAgents.find((entry) => entry.id === result.id);
          if (!current) {
            continue;
          }

          current.status = result.status;
          current.finishedAt = now();
          if (result.status === 'completed') {
            current.outputPreview = result.outputPreview;
            current.error = undefined;
          } else {
            current.error = result.error;
          }
        }

        latest.updatedAt = now();
        await writeCoordinationState(statePath, latest);

        const failedCount = settled.filter((entry) => entry.status === 'failed').length;
        const failedNodeIds = settled
          .filter((entry) => entry.status === 'failed')
          .map((entry) => entry.nodeId ?? entry.id);
        const summary = {
          total: settled.length,
          concurrency,
          adaptiveConcurrency,
          minConcurrency,
          finalConcurrency: batchRun.finalConcurrency,
          windows: batchRun.windows,
          completed: settled.length - failedCount,
          failed: failedCount,
          failedNodeIds,
          usage: usageTotals,
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

async function buildSubAgentRequestFromToolArgs(
  cwd: string,
  toolArgs: Record<string, unknown>,
): Promise<SubAgentRequest> {
  const packet = normalizeSubAgentContextPacket(toolArgs.contextPacket);
  const legacyPrompt = optionalString(toolArgs.prompt) ?? '';

  if (!legacyPrompt && !packet?.objective) {
    throw new Error('Missing prompt. Provide prompt or contextPacket.objective.');
  }

  const prompt = await enrichDelegationPromptWithFileSnippets(
    cwd,
    buildSubAgentPrompt(legacyPrompt, packet),
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

    return {
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now(),
      todos,
      agentGraph: { nodes },
      subAgents,
    };
  } catch {
    return {
      updatedAt: now(),
      todos: [],
      agentGraph: { nodes: [] },
      subAgents: [],
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
      outputPreview: record.outputPreview
        ? sanitizePersistedText(record.outputPreview, COORDINATION_PERSIST_OUTPUT_MAX_CHARS)
        : record.outputPreview,
      error: record.error
        ? sanitizePersistedText(record.error, COORDINATION_PERSIST_OUTPUT_MAX_CHARS)
        : record.error,
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
      outputPreview: optionalString(entry.outputPreview),
      error: optionalString(entry.error),
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

async function enrichDelegationPromptWithFileSnippets(cwd: string, prompt: string): Promise<string> {
  const trimmed = prompt.trim();
  if (!trimmed || trimmed.includes(SUBAGENT_CONTEXT_MARKER)) {
    return prompt;
  }

  const filePaths = extractCandidateFilePaths(trimmed);
  if (filePaths.length === 0) {
    return prompt;
  }

  const snippets = await collectFileSnippets(cwd, filePaths);
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

    const normalized = candidate.replace(/^\.\//, '');
    if (normalized) {
      unique.add(normalized);
    }
  }

  return [...unique];
}

async function collectFileSnippets(cwd: string, filePaths: string[]): Promise<Array<{ path: string; content: string }>> {
  const candidates = filePaths.map((filePath, index) => ({ filePath, index }));
  const results = await mapWithConcurrency(candidates, SUBAGENT_SNIPPET_READ_CONCURRENCY, async (candidate) => {
    const absolutePath = resolve(cwd, candidate.filePath);
    if (!isWithinDirectory(absolutePath, cwd)) {
      return undefined;
    }

    try {
      const content = await readFile(absolutePath, 'utf-8');
      if (content.includes('\u0000')) {
        return undefined;
      }

      return {
        index: candidate.index,
        path: toPosixPath(relative(cwd, absolutePath)),
        content: trimText(content.trim(), SUBAGENT_CONTEXT_MAX_CHARS_PER_FILE),
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
