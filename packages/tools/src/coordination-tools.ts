import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Type } from '@mariozechner/pi-ai';
import type {
  AgentGraphNode,
  AgentToolsetOptions,
  RegisteredAgentTool,
  SubAgentRequest,
  TodoItem,
} from './types.js';
import { sanitizeForPathSegment } from './path-utils.js';

const todoStatusSchema = Type.Union([
  Type.Literal('todo'),
  Type.Literal('in_progress'),
  Type.Literal('done'),
]);

interface CoordinationToolsOptions extends AgentToolsetOptions {
  includeSubAgentTool: boolean;
}

interface SubAgentRunRecord {
  id: string;
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
              prompt: Type.String({ minLength: 1 }),
              dependencies: Type.Optional(Type.Array(Type.String())),
              provider: Type.Optional(Type.String()),
              model: Type.Optional(Type.String()),
              reasoning: Type.Optional(
                Type.Union([
                  Type.Literal('minimal'),
                  Type.Literal('low'),
                  Type.Literal('medium'),
                  Type.Literal('high'),
                ]),
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
          prompt: Type.String({ minLength: 1 }),
          systemPrompt: Type.Optional(Type.String()),
          provider: Type.Optional(Type.String()),
          model: Type.Optional(Type.String()),
          reasoning: Type.Optional(
            Type.Union([
              Type.Literal('minimal'),
              Type.Literal('low'),
              Type.Literal('medium'),
              Type.Literal('high'),
            ]),
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

        const request: SubAgentRequest = {
          prompt: asString(toolArgs.prompt, 'prompt'),
          systemPrompt: optionalString(toolArgs.systemPrompt),
          provider: optionalString(toolArgs.provider),
          model: optionalString(toolArgs.model),
          reasoning: normalizeReasoning(toolArgs.reasoning),
        };

        const state = await readCoordinationState(statePath);
        const id = `sub-${state.subAgents.length + 1}`;
        const record: SubAgentRunRecord = {
          id,
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
          const preview = trimText(result.text, 1800);
          if (current) {
            current.status = 'completed';
            current.finishedAt = now();
            current.outputPreview = preview;
          }
          latest.updatedAt = now();
          await writeCoordinationState(statePath, latest);

          return {
            content: `Sub-agent ${id} completed.\n\n${preview}`,
            details: {
              usage: result.usage,
            },
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
            content: `Sub-agent ${id} failed: ${message}`,
            isError: true,
          };
        }
      },
    });
  }

  return tools;
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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), 'utf-8');
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
      prompt,
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
  if (value === 'todo' || value === 'in_progress' || value === 'done') {
    return value;
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

function trimText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n... (truncated)`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function now(): string {
  return new Date().toISOString();
}
