import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Type } from '@mariozechner/pi-ai';
import type {
  AgentToolPhase,
  AgentGraphNode,
  AgentToolsetOptions,
  RegisteredAgentTool,
  SubAgentRequest,
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
]);

const modeSchema = Type.Union([
  Type.Literal('chat'),
  Type.Literal('planning'),
  Type.Literal('implementation'),
]);

const SUBAGENT_CONTEXT_MAX_FILES = 3;
const SUBAGENT_CONTEXT_MAX_CHARS_PER_FILE = 1200;
const SUBAGENT_CONTEXT_MARKER = 'Auto-included file snippets';
const PROMPT_FILE_PATH_PATTERN = /(?:^|[\s`"'])((?:\.?\.?\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.[A-Za-z0-9._-]+)(?=$|[\s`"':),])/g;

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
              name: Type.Optional(Type.String()),
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
          nodeId: Type.Optional(Type.String()),
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
          nodeId: optionalString(toolArgs.nodeId),
          prompt: await enrichDelegationPromptWithFileSnippets(options.cwd, asString(toolArgs.prompt, 'prompt')),
          systemPrompt: optionalString(toolArgs.systemPrompt),
          provider: optionalString(toolArgs.provider),
          model: optionalString(toolArgs.model),
          reasoning: normalizeReasoning(toolArgs.reasoning),
        };

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

    tools.push({
      tool: {
        name: 'subagent_spawn_batch',
        description: 'Spawn multiple focused sub-agents in parallel for independent sub-tasks.',
        parameters: Type.Object({
          agents: Type.Array(
            Type.Object({
              nodeId: Type.Optional(Type.String()),
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
            { minItems: 1 },
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

        const rawAgents = Array.isArray(toolArgs.agents) ? toolArgs.agents : [];
        if (rawAgents.length === 0) {
          return {
            content: 'Missing agents. Provide at least one sub-agent request.',
            isError: true,
          };
        }

        const requests: SubAgentRequest[] = [];
        for (const entry of rawAgents) {
          if (!isRecord(entry)) {
            continue;
          }

          requests.push({
            nodeId: optionalString(entry.nodeId),
            prompt: await enrichDelegationPromptWithFileSnippets(options.cwd, asString(entry.prompt, 'prompt')),
            systemPrompt: optionalString(entry.systemPrompt),
            provider: optionalString(entry.provider),
            model: optionalString(entry.model),
            reasoning: normalizeReasoning(entry.reasoning),
          });
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

        const settled = await Promise.all(records.map(async (record, index) => {
          const request = requests[index];
          try {
            const result = await options.runSubAgent?.(request, signal);
            return {
              id: record.id,
              nodeId: record.nodeId,
              status: 'completed' as const,
              outputPreview: trimText(result?.text ?? '', 1800),
              usage: result?.usage,
            };
          } catch (error) {
            return {
              id: record.id,
              nodeId: record.nodeId,
              status: 'failed' as const,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }));

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
        const summary = {
          total: settled.length,
          completed: settled.length - failedCount,
          failed: failedCount,
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
      name: optionalString(entry.name),
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
  const snippets: Array<{ path: string; content: string }> = [];

  for (const filePath of filePaths) {
    if (snippets.length >= SUBAGENT_CONTEXT_MAX_FILES) {
      break;
    }

    const absolutePath = resolve(cwd, filePath);
    if (!isWithinDirectory(absolutePath, cwd)) {
      continue;
    }

    try {
      const content = await readFile(absolutePath, 'utf-8');
      if (content.includes('\u0000')) {
        continue;
      }

      snippets.push({
        path: toPosixPath(relative(cwd, absolutePath)),
        content: trimText(content.trim(), SUBAGENT_CONTEXT_MAX_CHARS_PER_FILE),
      });
    } catch {
      continue;
    }
  }

  return snippets;
}

function isWithinDirectory(path: string, cwd: string): boolean {
  const root = resolve(cwd);
  const target = resolve(path);
  return target === root || target.startsWith(`${root}${sep}`);
}

function toPosixPath(path: string): string {
  return path.split(sep).join('/');
}

function now(): string {
  return new Date().toISOString();
}
