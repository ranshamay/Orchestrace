import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';
import { Activity, CheckCircle2, MessageSquare, Moon, Play, Settings, Sun, Trash2, Wrench } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  addTodo,
  cancelWork,
  type ChatContentPart,
  deleteWork,
  fetchModels,
  fetchProviders,
  fetchSessions,
  fetchWorkAgent,
  fetchWorkTools,
  fetchWorkspaces,
  retryWork,
  sendChatMessage,
  startWork,
  toggleTodo,
  type AgentTodo,
  type ChatMessage,
  type ProviderInfo,
  type WorkSession,
  type Workspace,
} from './lib/api';

type Tab = 'graph' | 'settings';
type ThemeMode = 'light' | 'dark';

type GraphNodeView = {
  id: string;
  label: string;
  prompt: string;
  x: number;
  y: number;
  status: string;
  dependencies: string[];
};

type TimelineItem = {
  key: string;
  time: string;
  kind: 'chat' | 'event';
  role?: string;
  title?: string;
  subtitle?: string;
  failureType?: string;
  tone?: 'neutral' | 'tool' | 'success' | 'error';
  content: string;
  contentParts?: ChatContentPart[];
};

type ComposerImageAttachment = {
  id: string;
  name: string;
  mime: string;
  dataUrl: string;
};

type SessionLlmControls = {
  provider: string;
  model: string;
  workspaceId: string;
  autoApprove: boolean;
  useWorktree: boolean;
};

type SessionStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'pending' | 'unknown';
type LlmSessionPhase = 'planning' | 'implementation';
type ComposerMode = 'run' | 'chat' | 'planning' | 'implementation';
type LlmSessionState =
  | 'queued'
  | 'analyzing'
  | 'thinking'
  | 'planning'
  | 'awaiting-approval'
  | 'implementing'
  | 'using-tools'
  | 'validating'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'cancelled';

type LlmSessionStatus = {
  state: LlmSessionState;
  label: string;
  detail?: string;
  failureType?: string;
  phase?: LlmSessionPhase;
};

type FailureType =
  | 'timeout'
  | 'auth'
  | 'rate_limit'
  | 'tool_schema'
  | 'tool_runtime'
  | 'validation'
  | 'empty_response'
  | 'unknown';

const RUN_QUERY_PARAM = 'run';

function readRunIdFromUrl(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  return new URL(window.location.href).searchParams.get(RUN_QUERY_PARAM)?.trim() ?? '';
}

function updateRunIdInUrl(runId: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  const url = new URL(window.location.href);
  const current = url.searchParams.get(RUN_QUERY_PARAM)?.trim() ?? '';
  const next = runId.trim();

  if (current === next) {
    return;
  }

  if (next) {
    url.searchParams.set(RUN_QUERY_PARAM, next);
  } else {
    url.searchParams.delete(RUN_QUERY_PARAM);
  }

  window.history.replaceState({}, '', url);
}

function buildRunDeepLink(runId: string): string {
  if (typeof window === 'undefined') {
    return `?${RUN_QUERY_PARAM}=${encodeURIComponent(runId)}`;
  }

  const url = new URL(window.location.href);
  url.searchParams.set(RUN_QUERY_PARAM, runId);
  return url.toString();
}

function compactRunId(runId: string): string {
  const id = runId.trim();
  if (id.length <= 12) {
    return id;
  }

  return `${id.slice(0, 8)}...${id.slice(-4)}`;
}

function stripRunTag(input: string): string {
  return input.replace(/^\[run:[^\]]+\]\s*/, '').trim();
}

function stripTaskPrefix(input: string): string {
  return input.replace(/^[^:]+:\s*/, '').trim();
}

function compactInline(input: string, maxChars = 220): string {
  const compact = input.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) {
    return compact;
  }

  return `${compact.slice(0, maxChars - 3)}...`;
}

function parseJsonObject(input: string): Record<string, unknown> | undefined {
  const value = input.trim();
  if (!value.startsWith('{') && !value.startsWith('[')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function toolInputSummary(toolName: string, payload: string): string {
  const parsed = parseJsonObject(payload);
  if (toolName === 'read_file') {
    const path = parsed && typeof parsed.path === 'string' ? parsed.path : '';
    return path ? `Reading ${path}` : 'Reading file';
  }

  if (toolName === 'list_directory') {
    const path = parsed && typeof parsed.path === 'string' ? parsed.path : '.';
    return `Listing ${path}`;
  }

  if (toolName === 'search_files') {
    const query = parsed && typeof parsed.query === 'string' ? parsed.query : '';
    return query ? `Searching for: ${query}` : 'Searching files';
  }

  if (toolName === 'run_command') {
    const command = parsed && typeof parsed.command === 'string' ? parsed.command : '';
    return command ? `Running: ${compactInline(command, 160)}` : 'Running command';
  }

  if (toolName.startsWith('todo_')) {
    return 'Updating checklist';
  }

  if (toolName === 'agent_graph_set') {
    return 'Updating execution graph';
  }

  if (toolName === 'subagent_spawn') {
    return 'Spawning sub-agent';
  }

  return `Calling ${toolName}`;
}

function toolOutputSummary(payload: string, isError: boolean): string {
  if (isError) {
    return compactInline(payload || 'Tool returned an error.', 260);
  }

  if (!payload.trim()) {
    return 'Completed with empty output.';
  }

  return compactInline(payload, 260);
}

function formatToolPayloadForDisplay(payload: string, maxChars = 6000): string {
  const raw = payload.trim();
  if (!raw) {
    return '(empty)';
  }

  let formatted = raw;
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      formatted = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      formatted = raw;
    }
  }

  return formatted.length > maxChars ? `${formatted.slice(0, maxChars)}\n... (truncated)` : formatted;
}

function renderToolEventContent(params: {
  direction: 'input' | 'output';
  toolName: string;
  payload: string;
  isError: boolean;
}): string {
  const summary = params.direction === 'input'
    ? toolInputSummary(params.toolName, params.payload)
    : toolOutputSummary(params.payload, params.isError);
  const displayPayload = formatToolPayloadForDisplay(params.payload);
  const codeLanguage = displayPayload.startsWith('{') || displayPayload.startsWith('[') ? 'json' : 'text';

  return `${summary}\n\n\`\`\`${codeLanguage}\n${displayPayload}\n\`\`\``;
}

function formatTimelineEvent(event: { type: string; message: string; taskId?: string; failureType?: string }): Pick<TimelineItem, 'title' | 'subtitle' | 'content' | 'tone' | 'failureType'> {
  const clean = stripRunTag(event.message);

  if (event.type === 'task:tool-call') {
    const toolMatch = clean.match(/^([^:]+):\s+tool\s+([a-zA-Z0-9_.-]+)\s+(input|output)(\s+\[error\])?\s*([\s\S]*)$/);
    if (toolMatch) {
      const toolName = toolMatch[2];
      const direction = toolMatch[3];
      const isError = Boolean(toolMatch[4]);
      const payload = toolMatch[5] ?? '';

      if (direction === 'input') {
        return {
          title: `Using ${toolName}`,
          subtitle: 'Tool input',
          tone: 'tool',
          content: renderToolEventContent({
            direction: 'input',
            toolName,
            payload,
            isError,
          }),
        };
      }

      return {
        title: `${toolName} result`,
        subtitle: isError ? 'Tool error' : 'Tool output',
        tone: isError ? 'error' : 'tool',
        content: renderToolEventContent({
          direction: 'output',
          toolName,
          payload,
          isError,
        }),
      };
    }
  }

  const detail = stripTaskPrefix(clean);
  switch (event.type) {
    case 'task:planning':
      return { title: 'Planning', subtitle: event.taskId, tone: 'neutral', content: detail || 'Drafting implementation plan.' };
    case 'task:approval-requested':
      return { title: 'Awaiting approval', subtitle: event.taskId, tone: 'neutral', content: detail || 'Waiting for plan approval.' };
    case 'task:implementation-attempt':
      return { title: 'Implementing', subtitle: event.taskId, tone: 'neutral', content: detail || 'Starting implementation attempt.' };
    case 'task:validating':
      return { title: 'Validating', subtitle: event.taskId, tone: 'neutral', content: detail || 'Running verification checks.' };
    case 'task:completed':
    case 'graph:completed':
      return { title: 'Completed', subtitle: event.taskId, tone: 'success', content: detail || 'Run completed successfully.' };
    case 'task:failed':
    case 'graph:failed':
      return {
        title: 'Failed',
        subtitle: event.taskId,
        tone: 'error',
        failureType: normalizeFailureType(event.failureType),
        content: detail || 'Execution failed.',
      };
    default:
      return {
        title: event.type.replace('task:', '').replace('graph:', '').replace(/-/g, ' '),
        subtitle: event.taskId,
        tone: 'neutral',
        content: compactInline(detail || clean, 260),
      };
  }
}

function normalizeFailureType(raw?: string): FailureType | undefined {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) {
    return undefined;
  }

  if (value === 'timeout'
    || value === 'auth'
    || value === 'rate_limit'
    || value === 'tool_schema'
    || value === 'tool_runtime'
    || value === 'validation'
    || value === 'empty_response'
    || value === 'unknown') {
    return value;
  }

  return undefined;
}

function formatFailureTypeLabel(failureType?: string): string {
  const normalized = normalizeFailureType(failureType);
  if (!normalized) {
    return '';
  }

  return normalized.replace(/_/g, ' ');
}

function failureTypeBadgeClass(failureType?: string, selected = false): string {
  if (selected) {
    return 'bg-white/20 text-white';
  }

  const normalized = normalizeFailureType(failureType);
  switch (normalized) {
    case 'timeout':
      return 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300';
    case 'auth':
      return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
    case 'rate_limit':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
    case 'tool_schema':
    case 'tool_runtime':
      return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300';
    case 'validation':
      return 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300';
    case 'empty_response':
      return 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300';
    case 'unknown':
      return 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
    default:
      return 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
  }
}

function resolveSessionFailureType(session?: WorkSession): FailureType | undefined {
  if (!session) {
    return undefined;
  }

  const fromStatus = normalizeFailureType(session.llmStatus?.failureType);
  if (fromStatus) {
    return fromStatus;
  }

  const fromOutput = normalizeFailureType(session.output?.failureType);
  if (fromOutput) {
    return fromOutput;
  }

  const lastFailedEvent = [...session.events]
    .reverse()
    .find((event) => event.type === 'task:failed' && normalizeFailureType(event.failureType));

  return normalizeFailureType(lastFailedEvent?.failureType);
}

function normalizeTaskStatus(raw?: string): string {
  const value = (raw ?? '').toLowerCase();
  if (value.includes('failed') || value.includes('error')) {
    return 'failed';
  }
  if (value.includes('completed') || value.includes('output') || value.includes('done')) {
    return 'completed';
  }
  if (value.includes('started') || value.includes('stream') || value.includes('tool-call')) {
    return 'running';
  }
  return 'pending';
}

function statusColor(status: string): string {
  switch (status) {
    case 'running':
      return '#2563eb';
    case 'completed':
      return '#059669';
    case 'failed':
      return '#dc2626';
    default:
      return '#94a3b8';
  }
}

function normalizeSessionStatus(raw?: string): SessionStatus {
  const value = (raw ?? '').toLowerCase();
  if (!value) {
    return 'pending';
  }
  if (value.includes('fail') || value.includes('error')) {
    return 'failed';
  }
  if (value.includes('cancel') || value.includes('abort')) {
    return 'cancelled';
  }
  if (value.includes('complete') || value.includes('done') || value.includes('success')) {
    return 'completed';
  }
  if (value.includes('run') || value.includes('progress') || value.includes('start') || value.includes('stream')) {
    return 'running';
  }
  if (value.includes('pending') || value.includes('queue') || value.includes('wait')) {
    return 'pending';
  }
  return 'unknown';
}

function formatSessionStatus(raw?: string): string {
  const normalized = normalizeSessionStatus(raw);
  if (normalized === 'unknown') {
    const fallback = (raw ?? '').trim().toLowerCase();
    return fallback || 'unknown';
  }
  return normalized;
}

function sessionStatusBadgeClass(raw?: string, selected = false): string {
  if (selected) {
    return 'bg-white/20 text-white';
  }
  switch (normalizeSessionStatus(raw)) {
    case 'running':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
    case 'completed':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
    case 'failed':
      return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
    case 'cancelled':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
    case 'pending':
      return 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
    default:
      return 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
  }
}

function normalizeLlmSessionState(raw?: string): LlmSessionState {
  const value = (raw ?? '').trim().toLowerCase();
  switch (value) {
    case 'queued':
      return 'queued';
    case 'analyzing':
      return 'analyzing';
    case 'thinking':
      return 'thinking';
    case 'planning':
      return 'planning';
    case 'awaiting_approval':
    case 'awaiting-approval':
      return 'awaiting-approval';
    case 'implementing':
      return 'implementing';
    case 'using_tools':
    case 'using-tools':
      return 'using-tools';
    case 'validating':
      return 'validating';
    case 'retrying':
      return 'retrying';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'queued';
  }
}

function llmStatusLabel(state: LlmSessionState): string {
  switch (state) {
    case 'queued':
      return 'Queued';
    case 'analyzing':
      return 'Analyzing';
    case 'thinking':
      return 'Thinking';
    case 'planning':
      return 'Planning';
    case 'awaiting-approval':
      return 'Awaiting Approval';
    case 'implementing':
      return 'Implementing';
    case 'using-tools':
      return 'Using Tools';
    case 'validating':
      return 'Validating';
    case 'retrying':
      return 'Retrying';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Queued';
  }
}

function fallbackLlmState(sessionStatus?: string): LlmSessionState {
  switch (normalizeSessionStatus(sessionStatus)) {
    case 'running':
      return 'analyzing';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'queued';
  }
}

function normalizeLlmPhase(raw?: string): LlmSessionPhase | undefined {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'planning') {
    return 'planning';
  }
  if (value === 'implementation' || value === 'implementing') {
    return 'implementation';
  }

  return undefined;
}

function fallbackLlmPhase(state: LlmSessionState): LlmSessionPhase | undefined {
  switch (state) {
    case 'planning':
    case 'awaiting-approval':
      return 'planning';
    case 'implementing':
    case 'using-tools':
    case 'validating':
    case 'retrying':
      return 'implementation';
    default:
      return undefined;
  }
}

function llmPhaseLabel(phase?: LlmSessionPhase): string {
  if (!phase) {
    return 'Unknown';
  }

  return phase === 'planning' ? 'Planning' : 'Implementation';
}

function llmPhaseBadgeClass(phase?: LlmSessionPhase, selected = false): string {
  if (selected) {
    return 'bg-white/20 text-white';
  }

  if (phase === 'planning') {
    return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300';
  }

  if (phase === 'implementation') {
    return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
  }

  return 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
}

function composerModeBadgeClass(mode: ComposerMode): string {
  switch (mode) {
    case 'chat':
      return 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300';
    case 'planning':
      return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300';
    case 'implementation':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
    default:
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
  }
}

function composerModeDescription(mode: ComposerMode): string {
  switch (mode) {
    case 'chat':
      return 'Conversational mode for clarification and context.';
    case 'planning':
      return 'Planning mode for architecture and execution plans.';
    case 'implementation':
      return 'Implementation mode with edit-capable tools.';
    default:
      return 'Start a new run (plan + implement).';
  }
}

function resolveLlmStatus(session?: WorkSession): LlmSessionStatus {
  const raw = session?.llmStatus;
  const sessionFailureType = resolveSessionFailureType(session);
  if (raw) {
    const state = normalizeLlmSessionState(raw.state);
    const phase = normalizeLlmPhase(raw.phase) ?? fallbackLlmPhase(state);
    return {
      state,
      label: raw.label?.trim() || llmStatusLabel(state),
      detail: raw.detail?.trim() || undefined,
      failureType: normalizeFailureType(raw.failureType) ?? sessionFailureType,
      phase,
    };
  }

  const fallbackState = fallbackLlmState(session?.status);
  const phase = fallbackLlmPhase(fallbackState);
  return {
    state: fallbackState,
    label: llmStatusLabel(fallbackState),
    failureType: sessionFailureType,
    phase,
  };
}

function llmStatusBadgeClass(status: LlmSessionStatus, selected = false): string {
  if (selected) {
    return 'bg-white/20 text-white';
  }

  switch (status.state) {
    case 'analyzing':
    case 'thinking':
    case 'planning':
      return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300';
    case 'awaiting-approval':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
    case 'implementing':
    case 'using-tools':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
    case 'validating':
      return 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300';
    case 'retrying':
      return 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300';
    case 'completed':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
    case 'failed':
      return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
    case 'cancelled':
      return 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
    default:
      return 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
  }
}

function summarizeChatPartsForTrace(parts?: ChatContentPart[]): string[] {
  if (!parts || parts.length === 0) {
    return [];
  }

  return parts.map((part, index) => {
    if (part.type === 'text') {
      return `part ${index + 1}: text ${compactInline(part.text, 280)}`;
    }

    const name = part.name?.trim() || `image-${index + 1}`;
    return `part ${index + 1}: image ${name} (${part.mimeType}, base64 length ${part.data.length})`;
  });
}

function indentBlock(text: string, prefix = '    '): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function buildSessionTraceExport(
  session: WorkSession,
  chatMessages: ChatMessage[],
  todos: AgentTodo[],
): string {
  const llmStatus = resolveLlmStatus(session);
  const sessionFailureType = resolveSessionFailureType(session);
  const lines: string[] = [];

  lines.push('Orchestrace Chat Trace');
  lines.push(`Exported at: ${new Date().toISOString()}`);
  lines.push(`Run ID: ${session.id}`);
  lines.push(`Workspace: ${session.workspaceName} (${session.workspacePath})`);
  lines.push(`Provider/Model: ${session.provider}/${session.model}`);
  lines.push(`Status: ${session.status}`);
  if (sessionFailureType) {
    lines.push(`Failure type: ${sessionFailureType}`);
  }
  lines.push(`LLM status: ${llmStatus.label}${llmStatus.detail ? ` - ${llmStatus.detail}` : ''}`);
  lines.push(`Created: ${session.createdAt}`);
  lines.push(`Updated: ${session.updatedAt}`);
  lines.push(`Worktree enabled: ${session.useWorktree ? 'yes' : 'no'}`);
  if (session.worktreePath) {
    lines.push(`Worktree path: ${session.worktreePath}`);
  }
  if (session.worktreeBranch) {
    lines.push(`Worktree branch: ${session.worktreeBranch}`);
  }
  lines.push('');

  lines.push('Prompt:');
  lines.push(indentBlock(session.prompt || '(empty prompt)'));
  lines.push('');

  lines.push(`Todos (${todos.length}):`);
  if (todos.length === 0) {
    lines.push('  - (none)');
  } else {
    for (const todo of todos) {
      lines.push(`  - [${todo.done ? 'x' : ' '}] ${todo.text}`);
    }
  }
  lines.push('');

  lines.push(`Events (${session.events.length}):`);
  if (session.events.length === 0) {
    lines.push('  - (none)');
  } else {
    for (const event of session.events) {
      lines.push(`  - [${event.time}] ${event.type}${event.taskId ? ` (${event.taskId})` : ''}${event.failureType ? ` [${event.failureType}]` : ''}`);
      lines.push(indentBlock(stripRunTag(event.message), '      '));
    }
  }
  lines.push('');

  lines.push(`Chat Messages (${chatMessages.length}):`);
  if (chatMessages.length === 0) {
    lines.push('  - (none)');
  } else {
    for (const message of chatMessages) {
      lines.push(`  - [${message.time}] ${message.role.toUpperCase()}`);
      lines.push(indentBlock(message.content || '(empty message)', '      '));
      const parts = summarizeChatPartsForTrace(message.contentParts);
      if (parts.length > 0) {
        lines.push('      Parts:');
        for (const part of parts) {
          lines.push(`        - ${part}`);
        }
      }
    }
  }

  return lines.join('\n');
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document !== 'undefined') {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (copied) {
      return;
    }
  }

  throw new Error('Clipboard is not available in this browser context.');
}

function buildGraphLayout(session?: WorkSession): { nodes: GraphNodeView[]; width: number; height: number } {
  if (!session) {
    return { nodes: [], width: 900, height: 520 };
  }

  const baseNodes = session.agentGraph && session.agentGraph.length > 0
    ? session.agentGraph
    : [{ id: session.id, prompt: session.prompt, dependencies: [] }];

  const nodeById = new Map(baseNodes.map((node) => [node.id, node]));
  const levelById = new Map<string, number>();

  const computeLevel = (id: string, trail = new Set<string>()): number => {
    if (levelById.has(id)) {
      return levelById.get(id) ?? 0;
    }
    if (trail.has(id)) {
      return 0;
    }
    trail.add(id);
    const node = nodeById.get(id);
    if (!node || node.dependencies.length === 0) {
      levelById.set(id, 0);
      trail.delete(id);
      return 0;
    }
    const level = Math.max(...node.dependencies.map((dep) => computeLevel(dep, trail) + 1));
    levelById.set(id, level);
    trail.delete(id);
    return level;
  };

  for (const node of baseNodes) {
    computeLevel(node.id);
  }

  const levelGroups = new Map<number, typeof baseNodes>();
  for (const node of baseNodes) {
    const level = levelById.get(node.id) ?? 0;
    const group = levelGroups.get(level) ?? [];
    group.push(node);
    levelGroups.set(level, group);
  }

  const levels = [...levelGroups.keys()].sort((a, b) => a - b);
  const maxPerLevel = Math.max(1, ...[...levelGroups.values()].map((group) => group.length));
  const width = Math.max(900, levels.length * 280 + 180);
  const height = Math.max(520, maxPerLevel * 140 + 180);

  const nodes: GraphNodeView[] = [];
  for (const level of levels) {
    const group = levelGroups.get(level) ?? [];
    const stepY = height / (group.length + 1);
    group.forEach((node, index) => {
      const status = normalizeTaskStatus(session.taskStatus[node.id]);
      nodes.push({
        id: node.id,
        label: node.id,
        prompt: node.prompt,
        x: 130 + level * 260,
        y: stepY * (index + 1),
        status,
        dependencies: node.dependencies,
      });
    });
  }

  return { nodes, width, height };
}

function MarkdownMessage({ content, dark }: { content: string; dark: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="my-1 leading-relaxed">{children}</p>,
        ul: ({ children }) => <ul className="my-2 list-disc pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal pl-5">{children}</ol>,
        li: ({ children }) => <li className="my-0.5">{children}</li>,
        a: ({ href, children }) => (
          <a className="text-blue-600 underline decoration-blue-300 underline-offset-2 dark:text-blue-300" href={href} rel="noreferrer" target="_blank">
            {children}
          </a>
        ),
        code: ({ children, className }) => {
          const inline = !String(className ?? '').includes('language-');
          if (inline) {
            return (
              <code className={`rounded px-1 py-0.5 font-mono text-[12px] ${dark ? 'bg-slate-800 text-slate-100' : 'bg-slate-100 text-slate-800'}`}>
                {children}
              </code>
            );
          }
          return (
            <code className="block overflow-x-auto whitespace-pre rounded-lg bg-slate-900 p-3 font-mono text-[12px] leading-relaxed text-slate-100">
              {children}
            </code>
          );
        },
        pre: ({ children }) => <pre className="my-2">{children}</pre>,
        blockquote: ({ children }) => (
          <blockquote className={`my-2 border-l-2 pl-3 italic ${dark ? 'border-slate-600 text-slate-300' : 'border-slate-300 text-slate-600'}`}>
            {children}
          </blockquote>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function sanitizeAttachmentName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return 'pasted-image.png';
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function attachmentMarkdown(attachments: ComposerImageAttachment[]): string {
  return attachments
    .map((attachment, index) => `![${sanitizeAttachmentName(attachment.name || `pasted-image-${index + 1}.png`)}](${attachment.dataUrl})`)
    .join('\n\n');
}

function composePrompt(text: string, attachments: ComposerImageAttachment[]): string {
  const base = text.trim();
  if (attachments.length === 0) {
    return base;
  }

  const images = attachmentMarkdown(attachments);
  if (!base) {
    return images;
  }
  return `${base}\n\n${images}`;
}

function composeRunPromptWithContext(originalPrompt: string, followUpPrompt: string): string {
  const base = originalPrompt.trim();
  const followUp = followUpPrompt.trim();

  if (!base) {
    return followUp;
  }

  if (!followUp) {
    return base;
  }

  return `${base}\n\nFollow-up request:\n${followUp}`;
}

function dataUrlToImagePart(dataUrl: string): { data: string; mimeType: string } | undefined {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    return undefined;
  }

  return {
    mimeType: match[1],
    data: match[2],
  };
}

function toComposerContentParts(text: string, attachments: ComposerImageAttachment[]): ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  const trimmed = text.trim();
  if (trimmed) {
    parts.push({ type: 'text', text: trimmed });
  }

  for (const attachment of attachments) {
    const parsed = dataUrlToImagePart(attachment.dataUrl);
    if (!parsed) {
      continue;
    }

    parts.push({
      type: 'image',
      data: parsed.data,
      mimeType: parsed.mimeType,
      name: attachment.name,
    });
  }

  return parts;
}

function compactPromptDisplay(prompt: string): string {
  return prompt
    .replace(/!\[[^\]]*\]\(data:image\/[a-zA-Z0-9.+-]+;base64,[^)]+\)/g, '[pasted-image]')
    .replace(/\s+/g, ' ')
    .trim();
}

function UserMessageContent({
  content,
  contentParts,
}: {
  content: string;
  contentParts?: ChatContentPart[];
}) {
  if (!contentParts || contentParts.length === 0) {
    return <div className="whitespace-pre-wrap break-words">{content}</div>;
  }

  const textParts = contentParts.filter((part): part is Extract<ChatContentPart, { type: 'text' }> => part.type === 'text');
  const imageParts = contentParts.filter((part): part is Extract<ChatContentPart, { type: 'image' }> => part.type === 'image');

  return (
    <div className="space-y-2">
      {textParts.length > 0 && (
        <div className="whitespace-pre-wrap break-words">{textParts.map((part) => part.text).join('\n\n')}</div>
      )}
      {imageParts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {imageParts.map((part, index) => (
            <a
              key={`${part.name ?? 'image'}-${index}`}
              className="block overflow-hidden rounded border border-blue-200 bg-white dark:border-blue-800 dark:bg-slate-900"
              href={`data:${part.mimeType};base64,${part.data}`}
              rel="noreferrer"
              target="_blank"
            >
              <img
                alt={part.name ?? `image-${index + 1}`}
                className="h-24 w-24 object-cover"
                src={`data:${part.mimeType};base64,${part.data}`}
              />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

async function readClipboardImage(item: DataTransferItem): Promise<ComposerImageAttachment | null> {
  const file = item.getAsFile();
  if (!file) {
    return null;
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Failed to read pasted image'));
    reader.readAsDataURL(file);
  });

  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    name: file.name || 'pasted-image.png',
    mime: file.type || 'image/png',
    dataUrl,
  };
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('graph');
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') {
      return 'dark';
    }
    const stored = window.localStorage.getItem('orchestrace-theme');
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerStatuses, setProviderStatuses] = useState<Array<{ provider: string; source: string }>>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('');
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});

  const [sessions, setSessions] = useState<WorkSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>(() => readRunIdFromUrl());
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [todos, setTodos] = useState<AgentTodo[]>([]);

  const [workProvider, setWorkProvider] = useState('');
  const [workModel, setWorkModel] = useState('');
  const [workWorkspaceId, setWorkWorkspaceId] = useState('');
  const [autoApprove, setAutoApprove] = useState(true);
  const [useWorktree, setUseWorktree] = useState(false);
  const [llmControlsBySessionId, setLlmControlsBySessionId] = useState<Record<string, SessionLlmControls>>({});
  const [defaultLlmControls, setDefaultLlmControls] = useState<SessionLlmControls>({
    provider: '',
    model: '',
    workspaceId: '',
    autoApprove: true,
    useWorktree: false,
  });

  const [composerText, setComposerText] = useState('');
  const [composerImages, setComposerImages] = useState<ComposerImageAttachment[]>([]);
  const [isLlmControlsModalOpen, setIsLlmControlsModalOpen] = useState(false);
  const [copyTraceState, setCopyTraceState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [showToolsPanel, setShowToolsPanel] = useState(false);
  const [availableTools, setAvailableTools] = useState<Array<{ name: string; description: string }>>([]);
  const [toolsMode, setToolsMode] = useState<'chat' | 'planning' | 'implementation' | ''>('');
  const [isToolsLoading, setIsToolsLoading] = useState(false);
  const [toolsLoadError, setToolsLoadError] = useState('');
  const [todoInput, setTodoInput] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const timelineContainerRef = useRef<HTMLDivElement | null>(null);
  const [followTimelineTail, setFollowTimelineTail] = useState(true);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId),
    [sessions, selectedSessionId],
  );

  const selectedLlmStatus = useMemo(() => resolveLlmStatus(selectedSession), [selectedSession]);
  const selectedFailureType = useMemo(() => resolveSessionFailureType(selectedSession), [selectedSession]);
  const composerMode: ComposerMode = selectedSession
    ? (selectedSession.mode ?? 'chat')
    : 'run';

  const applyWorkingControls = (controls: SessionLlmControls) => {
    if (workProvider !== controls.provider) {
      setWorkProvider(controls.provider);
    }
    if (workModel !== controls.model) {
      setWorkModel(controls.model);
    }
    if (workWorkspaceId !== controls.workspaceId) {
      setWorkWorkspaceId(controls.workspaceId);
    }
    if (autoApprove !== controls.autoApprove) {
      setAutoApprove(controls.autoApprove);
    }
    if (useWorktree !== controls.useWorktree) {
      setUseWorktree(controls.useWorktree);
    }
  };

  const updateActiveLlmControls = (patch: Partial<SessionLlmControls>) => {
    const nextControls: SessionLlmControls = {
      provider: patch.provider ?? workProvider,
      model: patch.model ?? workModel,
      workspaceId: patch.workspaceId ?? workWorkspaceId,
      autoApprove: patch.autoApprove ?? autoApprove,
      useWorktree: patch.useWorktree ?? useWorktree,
    };

    applyWorkingControls(nextControls);

    if (selectedSessionId) {
      setLlmControlsBySessionId((current) => ({
        ...current,
        [selectedSessionId]: nextControls,
      }));
      return;
    }

    setDefaultLlmControls(nextControls);
  };

  const sessionStatusSummary = useMemo(() => {
    const summary = {
      total: sessions.length,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      pending: 0,
      unknown: 0,
    };

    for (const session of sessions) {
      switch (normalizeSessionStatus(session.status)) {
        case 'running':
          summary.running += 1;
          break;
        case 'completed':
          summary.completed += 1;
          break;
        case 'failed':
          summary.failed += 1;
          break;
        case 'cancelled':
          summary.cancelled += 1;
          break;
        case 'pending':
          summary.pending += 1;
          break;
        default:
          summary.unknown += 1;
          break;
      }
    }

    const overall = summary.total === 0
      ? 'empty'
      : summary.running > 0
        ? 'running'
        : summary.failed > 0
          ? 'attention'
          : 'idle';

    return {
      ...summary,
      overall,
    };
  }, [sessions]);

  const graphLayout = useMemo(() => buildGraphLayout(selectedSession), [selectedSession]);

  const timelineItems = useMemo<TimelineItem[]>(() => {
    const eventItems: TimelineItem[] = (selectedSession?.events ?? []).slice(-120).map((event, index) => {
      const formatted = formatTimelineEvent(event);
      return {
        key: `event-${event.time}-${index}`,
        time: event.time,
        kind: 'event',
        title: formatted.title,
        subtitle: formatted.subtitle,
        failureType: formatted.failureType,
        tone: formatted.tone,
        content: formatted.content,
      };
    });
    const chatItems: TimelineItem[] = chatMessages.map((message, index) => ({
      key: `chat-${message.time}-${index}`,
      time: message.time,
      kind: 'chat',
      role: message.role,
      content: message.content,
      contentParts: message.contentParts,
    }));

    return [...eventItems, ...chatItems].sort((a, b) => a.time.localeCompare(b.time));
  }, [chatMessages, selectedSession]);

  const latestTimelineKey = timelineItems[timelineItems.length - 1]?.key ?? '';

  useEffect(() => {
    const bootstrap = async () => {
      try {
        const [providersState, workspacesState, sessionsState] = await Promise.all([
          fetchProviders(),
          fetchWorkspaces(),
          fetchSessions(),
        ]);

        setProviders(providersState.providers);
        setProviderStatuses(providersState.statuses);
        setWorkspaces(workspacesState.workspaces);
        setActiveWorkspaceId(workspacesState.activeWorkspaceId ?? '');
        setSessions(sessionsState.sessions);

        const runIdFromUrl = readRunIdFromUrl();
        const hasRunIdInResults = Boolean(
          runIdFromUrl && sessionsState.sessions.some((session) => session.id === runIdFromUrl),
        );
        const initialSessionId = hasRunIdInResults
          ? runIdFromUrl
          : sessionsState.sessions[0]?.id ?? '';

        setSelectedSessionId(initialSessionId);
        updateRunIdInUrl(initialSessionId);

        const connectedProvider = providersState.statuses.find((status) => status.source !== 'none')?.provider || '';
        const defaultProvider = connectedProvider || providersState.defaults.provider || providersState.providers[0]?.id || '';
        const defaultWorkspace = workspacesState.activeWorkspaceId || workspacesState.workspaces[0]?.id || '';
        const initialControls: SessionLlmControls = {
          provider: defaultProvider,
          model: providersState.defaults.model || '',
          workspaceId: defaultWorkspace,
          autoApprove: true,
          useWorktree: window.localStorage.getItem('orchestrace-use-worktree') === 'true',
        };

        setDefaultLlmControls(initialControls);
        setWorkProvider(initialControls.provider);
        setWorkModel(initialControls.model);
        setWorkWorkspaceId(initialControls.workspaceId);
        setAutoApprove(initialControls.autoApprove);
        setUseWorktree(initialControls.useWorktree);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    };

    void bootstrap();
  }, []);

  useEffect(() => {
    const loadModels = async () => {
      if (!workProvider) {
        return;
      }

      try {
        const response = await fetchModels(workProvider);
        setProviderModels((previous) => ({
          ...previous,
          [workProvider]: response.models,
        }));

        if (!workModel && response.models.length > 0) {
          setWorkModel(response.models[0]);
        }
      } catch {
        setProviderModels((previous) => ({
          ...previous,
          [workProvider]: [],
        }));
      }
    };

    void loadModels();
  }, [workProvider, workModel]);

  useEffect(() => {
    if (!selectedSessionId) {
      setChatMessages([]);
      setTodos([]);
      return;
    }

    let cancelled = false;

    const refreshSessionState = async () => {
      try {
        const sessionsState = await fetchSessions();

        if (cancelled) {
          return;
        }

        setSessions(sessionsState.sessions);

        const selectedExists = sessionsState.sessions.some((session) => session.id === selectedSessionId);
        if (!selectedExists) {
          const fallbackSessionId = sessionsState.sessions[0]?.id ?? '';
          if (fallbackSessionId !== selectedSessionId) {
            setSelectedSessionId(fallbackSessionId);
          }
          if (!fallbackSessionId) {
            setChatMessages([]);
            setTodos([]);
          }
          return;
        }

        const agentState = await fetchWorkAgent(selectedSessionId);
        if (cancelled) {
          return;
        }

        setChatMessages(agentState.messages);
        setTodos(agentState.todos);
      } catch {
        // Keep existing UI state if polling fails temporarily.
      }
    };

    void refreshSessionState();
    const interval = setInterval(() => {
      void refreshSessionState();
    }, 2500);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedSessionId]);

  useEffect(() => {
    updateRunIdInUrl(selectedSessionId);
  }, [selectedSessionId]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handlePopState = () => {
      setSelectedSessionId(readRunIdFromUrl());
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    if (!selectedSessionId) {
      applyWorkingControls(defaultLlmControls);
      return;
    }

    const existingControls = llmControlsBySessionId[selectedSessionId];
    if (existingControls) {
      applyWorkingControls(existingControls);
      return;
    }

    if (!selectedSession) {
      return;
    }

    const sessionControls: SessionLlmControls = {
      provider: selectedSession.provider || defaultLlmControls.provider,
      model: selectedSession.model || defaultLlmControls.model,
      workspaceId: selectedSession.workspaceId || defaultLlmControls.workspaceId,
      autoApprove: selectedSession.autoApprove,
      useWorktree: selectedSession.useWorktree ?? defaultLlmControls.useWorktree,
    };

    setLlmControlsBySessionId((current) => ({
      ...current,
      [selectedSessionId]: sessionControls,
    }));
    applyWorkingControls(sessionControls);
  }, [
    autoApprove,
    defaultLlmControls,
    llmControlsBySessionId,
    selectedSession,
    selectedSessionId,
    workModel,
    workProvider,
    useWorktree,
    workWorkspaceId,
  ]);

  useEffect(() => {
    window.localStorage.setItem('orchestrace-use-worktree', useWorktree ? 'true' : 'false');
  }, [useWorktree]);

  useEffect(() => {
    if (sessions.length === 0) {
      if (selectedSessionId) {
        setSelectedSessionId('');
      }
      return;
    }

    if (!selectedSessionId || sessions.some((session) => session.id === selectedSessionId)) {
      return;
    }

    setSelectedSessionId(sessions[0].id);
  }, [selectedSessionId, sessions]);

  useEffect(() => {
    setFollowTimelineTail(true);
  }, [selectedSessionId]);

  useEffect(() => {
    setCopyTraceState('idle');
  }, [selectedSessionId]);

  useEffect(() => {
    if (!showToolsPanel) {
      return;
    }

    if (!selectedSessionId) {
      setAvailableTools([]);
      setToolsMode('');
      setToolsLoadError('Select a run to inspect tools.');
      return;
    }

    let cancelled = false;
    setIsToolsLoading(true);
    setToolsLoadError('');

    const loadTools = async () => {
      try {
        const toolsState = await fetchWorkTools(selectedSessionId);
        if (cancelled) {
          return;
        }

        setToolsMode(toolsState.mode);
        setAvailableTools(toolsState.tools);
      } catch (error) {
        if (cancelled) {
          return;
        }

        setToolsLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) {
          setIsToolsLoading(false);
        }
      }
    };

    void loadTools();

    return () => {
      cancelled = true;
    };
  }, [selectedSession?.mode, selectedSessionId, showToolsPanel]);

  useEffect(() => {
    if (copyTraceState !== 'copied') {
      return;
    }

    const timer = setTimeout(() => {
      setCopyTraceState('idle');
    }, 2200);

    return () => {
      clearTimeout(timer);
    };
  }, [copyTraceState]);

  useEffect(() => {
    if (!followTimelineTail) {
      return;
    }

    const timelineContainer = timelineContainerRef.current;
    if (!timelineContainer) {
      return;
    }

    timelineContainer.scrollTop = timelineContainer.scrollHeight;
  }, [followTimelineTail, latestTimelineKey, selectedSessionId]);

  const handleTimelineScroll = () => {
    const timelineContainer = timelineContainerRef.current;
    if (!timelineContainer) {
      return;
    }

    const distanceFromBottom = timelineContainer.scrollHeight - timelineContainer.scrollTop - timelineContainer.clientHeight;
    setFollowTimelineTail(distanceFromBottom <= 36);
  };

  const composerPayload = useMemo(() => composePrompt(composerText, composerImages), [composerImages, composerText]);
  const composerContentParts = useMemo(() => toComposerContentParts(composerText, composerImages), [composerImages, composerText]);
  const hasComposerContent = composerText.trim().length > 0 || composerImages.length > 0;

  const handleStartFromComposer = async () => {
    if (!hasComposerContent || !workProvider || !workModel || !workWorkspaceId) {
      return;
    }

    const runPrompt = selectedSession
      ? composeRunPromptWithContext(selectedSession.prompt, composerPayload)
      : composerPayload;

    setErrorMessage('');
    try {
      const result = await startWork({
        workspaceId: workWorkspaceId,
        prompt: runPrompt,
        provider: workProvider,
        model: workModel,
        autoApprove,
        useWorktree,
        promptParts: composerImages.length > 0 ? composerContentParts : undefined,
      });

      const sessionsState = await fetchSessions();
      setSessions(sessionsState.sessions);
      setSelectedSessionId(result.id);
      setComposerText('');
      setComposerImages([]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDelete = async () => {
    if (!selectedSessionId) {
      return;
    }

    setErrorMessage('');
    try {
      await deleteWork(selectedSessionId);
      setLlmControlsBySessionId((current) => {
        const { [selectedSessionId]: _removed, ...rest } = current;
        return rest;
      });
      const sessionsState = await fetchSessions();
      setSessions(sessionsState.sessions);
      const nextId = sessionsState.sessions[0]?.id ?? '';
      setSelectedSessionId(nextId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleStop = async () => {
    if (!selectedSessionId) {
      return;
    }

    setErrorMessage('');
    try {
      await cancelWork(selectedSessionId);
      const sessionsState = await fetchSessions();
      setSessions(sessionsState.sessions);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleRetry = async () => {
    if (!selectedSession || normalizeSessionStatus(selectedSession.status) === 'running') {
      return;
    }

    setErrorMessage('');
    try {
      const result = await retryWork(selectedSession.id);
      const sessionsState = await fetchSessions();
      setSessions(sessionsState.sessions);
      setSelectedSessionId(result.id);

      try {
        const agentState = await fetchWorkAgent(result.id);
        setChatMessages(agentState.messages);
        setTodos(agentState.todos);
      } catch {
        // Polling will synchronize chat and todo state shortly.
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleCopyTrace = async () => {
    if (!selectedSession) {
      return;
    }

    const payload = buildSessionTraceExport(selectedSession, chatMessages, todos);
    try {
      await copyTextToClipboard(payload);
      setCopyTraceState('copied');
    } catch (error) {
      setCopyTraceState('failed');
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSendChat = async () => {
    if (!selectedSessionId || !hasComposerContent) {
      return;
    }

    const previousText = composerText;
    const previousImages = composerImages;
    const message = previousText.trim();
    const messageParts = previousImages.length > 0 ? composerContentParts : undefined;

    setComposerText('');
    setComposerImages([]);
    setErrorMessage('');

    try {
      const response = await sendChatMessage(selectedSessionId, {
        message,
        messageParts,
      });
      setChatMessages(response.messages);
    } catch (error) {
      setComposerText(previousText);
      setComposerImages(previousImages);
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleComposerPaste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData?.items ?? []).filter((item) => item.type.startsWith('image/'));
    if (items.length === 0) {
      return;
    }

    event.preventDefault();
    setErrorMessage('');

    try {
      const nextAttachments = (await Promise.all(items.map((item) => readClipboardImage(item)))).filter(
        (item): item is ComposerImageAttachment => item !== null,
      );

      if (nextAttachments.length === 0) {
        return;
      }

      setComposerImages((current) => [...current, ...nextAttachments]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const removeComposerAttachment = (id: string) => {
    setComposerImages((current) => current.filter((item) => item.id !== id));
  };

  const handleAddTodo = async () => {
    if (!selectedSessionId || !todoInput.trim()) {
      return;
    }

    const text = todoInput;
    setTodoInput('');
    setErrorMessage('');

    try {
      const response = await addTodo(selectedSessionId, text);
      setTodos(response.todos);
    } catch (error) {
      setTodoInput(text);
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleToggleTodo = async (todo: AgentTodo) => {
    if (!selectedSessionId) {
      return;
    }

    setErrorMessage('');
    try {
      const response = await toggleTodo(selectedSessionId, todo.id, !todo.done);
      setTodos(response.todos);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const currentModels = providerModels[workProvider] ?? [];
  const isDark = theme === 'dark';

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    window.localStorage.setItem('orchestrace-theme', theme);
  }, [isDark, theme]);

  useEffect(() => {
    if (!isLlmControlsModalOpen || typeof window === 'undefined') {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsLlmControlsModalOpen(false);
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isLlmControlsModalOpen]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 md:flex-row">
      <aside className="w-full border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 md:w-64 md:border-b-0 md:border-r">
        <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-blue-600" />
            <h1 className="text-lg font-bold tracking-tight">Orchestrace</h1>
            <button
              aria-label="Toggle theme"
              className="ml-auto inline-flex items-center justify-center rounded border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
              type="button"
            >
              {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div className="max-h-56 overflow-y-auto p-3 md:max-h-none md:h-[calc(100vh-65px)] md:overflow-y-auto">
          <button
            className={`mb-1 w-full rounded-md px-3 py-2 text-left text-sm font-medium ${activeTab === 'graph' ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
            onClick={() => setActiveTab('graph')}
          >
            Graph & Flow
          </button>
          <button
            className={`mb-4 w-full rounded-md px-3 py-2 text-left text-sm font-medium ${activeTab === 'settings' ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
            onClick={() => setActiveTab('settings')}
          >
            Settings
          </button>

          <div className="mb-2 border-t border-slate-100 pt-3 text-xs font-bold uppercase tracking-widest text-slate-400 dark:border-slate-800 dark:text-slate-500">
            Sessions
          </div>

          <div className="mb-2 flex items-center justify-between px-1 text-[11px] text-slate-500 dark:text-slate-400">
            <span>Overall</span>
            <span
              className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${sessionStatusSummary.overall === 'running'
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                : sessionStatusSummary.overall === 'attention'
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                  : sessionStatusSummary.overall === 'idle'
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                    : 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}
            >
              {sessionStatusSummary.overall}
            </span>
          </div>

          {sessions.length > 0 && (
            <div className="mb-2 px-1 text-[11px] text-slate-500 dark:text-slate-400">
              {sessionStatusSummary.running} running / {sessionStatusSummary.total} total
            </div>
          )}

          {sessions.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1 px-1">
              <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                completed {sessionStatusSummary.completed}
              </span>
              <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                running {sessionStatusSummary.running}
              </span>
              <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-700 dark:bg-red-900/40 dark:text-red-300">
                failed {sessionStatusSummary.failed}
              </span>
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                cancelled {sessionStatusSummary.cancelled}
              </span>
            </div>
          )}

          {sessions.length === 0 && <div className="px-1 text-xs italic text-slate-400 dark:text-slate-500">No sessions</div>}

          {sessions.map((session) => {
            const isSelected = selectedSessionId === session.id;
            const llmStatus = resolveLlmStatus(session);
            const sessionFailureType = resolveSessionFailureType(session);

            return (
              <button
                key={session.id}
                className={`mb-1 w-full rounded px-2 py-1.5 text-left text-xs ${isSelected ? 'bg-blue-600 text-white' : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                onClick={() => setSelectedSessionId(session.id)}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{compactPromptDisplay(session.prompt)}</span>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${sessionStatusBadgeClass(
                      session.status,
                      isSelected,
                    )}`}
                  >
                    {formatSessionStatus(session.status)}
                  </span>
                </div>
                <div className={`mt-1 flex items-center justify-between gap-2 font-mono text-[10px] ${isSelected ? 'text-blue-100' : 'text-slate-500 dark:text-slate-400'}`}>
                  <span>run {compactRunId(session.id)}</span>
                  <div className="flex items-center gap-1">
                    {sessionFailureType && (
                      <span className={`rounded px-1.5 py-0.5 font-sans font-semibold uppercase tracking-wide ${failureTypeBadgeClass(sessionFailureType, isSelected)}`}>
                        {formatFailureTypeLabel(sessionFailureType)}
                      </span>
                    )}
                    {llmStatus.phase && (
                      <span className={`rounded px-1.5 py-0.5 font-sans font-semibold uppercase tracking-wide ${llmPhaseBadgeClass(llmStatus.phase, isSelected)}`}>
                        {llmPhaseLabel(llmStatus.phase)}
                      </span>
                    )}
                    <span className={`rounded px-1.5 py-0.5 font-sans font-semibold uppercase tracking-wide ${llmStatusBadgeClass(llmStatus, isSelected)}`}>
                      {llmStatus.label}
                    </span>
                  </div>
                </div>
                {llmStatus.detail && (
                  <div className={`mt-1 truncate text-[10px] ${isSelected ? 'text-blue-100/90' : 'text-slate-500 dark:text-slate-400'}`}>
                    {llmStatus.detail}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        {activeTab === 'graph' ? (
          <div className="flex h-full flex-col lg:flex-row">
            <section className="flex min-w-0 flex-1 flex-col border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 lg:border-b-0 lg:border-r">
              <header className="border-b border-slate-200 p-4 dark:border-slate-800">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Center graph is the execution control plane. Edit LLM controls here, then use the right panel composer to start a run or chat with the selected run.
                  </div>
                  <button
                    className="shrink-0 rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                    onClick={() => setIsLlmControlsModalOpen(true)}
                    type="button"
                  >
                    LLM Controls
                  </button>
                </div>
              </header>

              <div className="min-h-0 flex-1 overflow-auto bg-slate-50 p-4 dark:bg-slate-950">
                {!selectedSession && (
                  <div className="text-center text-sm italic text-slate-400 dark:text-slate-500">Select a session to inspect its flow.</div>
                )}

                {selectedSession && (
                  <div className="space-y-4">
                    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
                      <div className="mb-3 flex items-start justify-between gap-2">
                        <div>
                          <div className="text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">Entity Graph</div>
                          <div className="mt-1 text-sm font-semibold text-slate-700 dark:text-slate-200">{compactPromptDisplay(selectedSession.prompt)}</div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className={`rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${sessionStatusBadgeClass(selectedSession.status)}`}>
                            {formatSessionStatus(selectedSession.status)}
                          </span>
                          {selectedFailureType && (
                            <span className={`rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${failureTypeBadgeClass(selectedFailureType)}`}>
                              {formatFailureTypeLabel(selectedFailureType)}
                            </span>
                          )}
                          {selectedLlmStatus.phase && (
                            <span className={`rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${llmPhaseBadgeClass(selectedLlmStatus.phase)}`}>
                              {llmPhaseLabel(selectedLlmStatus.phase)}
                            </span>
                          )}
                          <span className={`rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${llmStatusBadgeClass(selectedLlmStatus)}`}>
                            {selectedLlmStatus.label}
                          </span>
                        </div>
                      </div>
                      <div className="overflow-auto rounded border border-slate-100 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
                        <svg
                          aria-label="Entity graph"
                          className="block"
                          height={graphLayout.height}
                          role="img"
                          width={graphLayout.width}
                        >
                          {graphLayout.nodes.flatMap((node) => node.dependencies.map((dep) => {
                            const fromNode = graphLayout.nodes.find((candidate) => candidate.id === dep);
                            if (!fromNode) {
                              return null;
                            }
                            return (
                              <line
                                key={`edge-${dep}-${node.id}`}
                                stroke={isDark ? '#475569' : '#94a3b8'}
                                strokeWidth={2}
                                x1={fromNode.x + 90}
                                x2={node.x - 90}
                                y1={fromNode.y}
                                y2={node.y}
                              />
                            );
                          }))}

                          {graphLayout.nodes.map((node) => (
                            <g key={node.id}>
                              <rect
                                fill={isDark ? '#0f172a' : 'white'}
                                height={72}
                                rx={12}
                                stroke={statusColor(node.status)}
                                strokeWidth={2}
                                width={180}
                                x={node.x - 90}
                                y={node.y - 36}
                              />
                              <text
                                fill={isDark ? '#e2e8f0' : '#0f172a'}
                                fontSize={12}
                                fontWeight={700}
                                textAnchor="middle"
                                x={node.x}
                                y={node.y - 8}
                              >
                                {node.label}
                              </text>
                              <text
                                fill={isDark ? '#94a3b8' : '#475569'}
                                fontSize={10}
                                textAnchor="middle"
                                x={node.x}
                                y={node.y + 10}
                              >
                                {node.status}
                              </text>
                            </g>
                          ))}
                        </svg>
                      </div>
                    </div>

                    <div className="rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
                      <header className="border-b border-slate-200 px-4 py-3 text-xs font-bold uppercase tracking-widest text-slate-500 dark:border-slate-800 dark:text-slate-400">
                        Todo Checklist
                      </header>
                      <div className="flex gap-2 border-b border-slate-100 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950">
                        <input
                          className="flex-1 rounded border border-slate-200 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                          disabled={!selectedSessionId}
                          onChange={(event) => setTodoInput(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              void handleAddTodo();
                            }
                          }}
                          placeholder="Add todo item..."
                          value={todoInput}
                        />
                        <button
                          className="rounded border border-slate-200 bg-white px-3 text-sm disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900"
                          disabled={!selectedSessionId || !todoInput.trim()}
                          onClick={() => {
                            void handleAddTodo();
                          }}
                        >
                          Add
                        </button>
                      </div>
                      <div className="max-h-72 space-y-1 overflow-auto p-4">
                        {todos.length === 0 && <div className="text-center text-xs italic text-slate-400 dark:text-slate-500">No todos yet.</div>}
                        {todos.map((todo) => (
                          <button
                            key={todo.id}
                            className="flex w-full items-center gap-2 rounded border border-slate-100 bg-white p-2 text-left text-sm dark:border-slate-700 dark:bg-slate-900"
                            onClick={() => {
                              void handleToggleTodo(todo);
                            }}
                          >
                            <CheckCircle2 className={`h-4 w-4 ${todo.done ? 'text-emerald-500' : 'text-slate-300'}`} />
                            <span className={todo.done ? 'line-through text-slate-400 dark:text-slate-500' : 'text-slate-700 dark:text-slate-200'}>{todo.text}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>

            <aside className="flex w-full flex-col bg-white dark:bg-slate-900 lg:w-[420px]">
              <section className="flex min-h-0 flex-1 flex-col">
                <header className="border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">LLM Work</div>
                    <div className="flex items-center gap-1.5">
                      <button
                        aria-label="Toggle tool list"
                        className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] disabled:opacity-50 ${showToolsPanel ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300' : 'border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'}`}
                        disabled={!selectedSessionId}
                        onClick={() => {
                          setShowToolsPanel((current) => !current);
                        }}
                        title="Show currently available tools"
                        type="button"
                      >
                        <Wrench className="h-3 w-3" />
                        Tools
                      </button>
                      <button
                        className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] disabled:opacity-50 ${copyTraceState === 'copied' ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300' : copyTraceState === 'failed' ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300' : 'border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'}`}
                        disabled={!selectedSessionId}
                        onClick={() => {
                          void handleCopyTrace();
                        }}
                        type="button"
                      >
                        {copyTraceState === 'copied' ? 'Copied' : copyTraceState === 'failed' ? 'Copy failed' : 'Copy Trace'}
                      </button>
                      <button
                        className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-[10px] text-blue-700 disabled:opacity-50 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300"
                        disabled={!selectedSession || normalizeSessionStatus(selectedSession.status) === 'running'}
                        onClick={() => {
                          void handleRetry();
                        }}
                        title="Retry this run with the same prompt and controls"
                        type="button"
                      >
                        <Play className="h-3 w-3" />
                        Retry
                      </button>
                      <button
                        className="inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-2 py-1 text-[10px] text-red-700 disabled:opacity-50 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
                        disabled={!selectedSessionId}
                        onClick={() => {
                          void handleDelete();
                        }}
                        type="button"
                      >
                        <Trash2 className="h-3 w-3" />
                        Delete
                      </button>
                    </div>
                  </div>

                  {showToolsPanel && (
                    <div className="mb-2 rounded border border-slate-200 bg-slate-50 p-2.5 text-xs dark:border-slate-700 dark:bg-slate-950">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">Available Tools</div>
                        <span className="rounded bg-slate-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                          mode {toolsMode || selectedSession?.mode || 'unknown'}
                        </span>
                      </div>
                      {isToolsLoading && (
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">Loading tools...</div>
                      )}
                      {!isToolsLoading && toolsLoadError && (
                        <div className="text-[11px] text-red-600 dark:text-red-300">{toolsLoadError}</div>
                      )}
                      {!isToolsLoading && !toolsLoadError && availableTools.length === 0 && (
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">No tools available in this mode.</div>
                      )}
                      {!isToolsLoading && !toolsLoadError && availableTools.length > 0 && (
                        <div className="max-h-48 space-y-1 overflow-auto pr-1">
                          {availableTools.map((tool) => (
                            <div key={tool.name} className="rounded border border-slate-200 bg-white p-1.5 dark:border-slate-700 dark:bg-slate-900">
                              <div className="font-mono text-[11px] font-semibold text-slate-800 dark:text-slate-100">{tool.name}</div>
                              <div className="mt-0.5 text-[11px] text-slate-600 dark:text-slate-300">{tool.description}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {!selectedSession && (
                    <div className="rounded border border-dashed border-slate-200 bg-slate-50 p-3 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-400">
                      Select a run to inspect provider, model, and timeline details.
                    </div>
                  )}

                  {selectedSession && (
                    <div className="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-400">
                      <div className="mb-2 flex items-start justify-between gap-2">
                        <div className="line-clamp-2 text-sm font-semibold text-slate-800 dark:text-slate-100">{compactPromptDisplay(selectedSession.prompt)}</div>
                        <div className="flex items-center gap-1.5">
                          <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${sessionStatusBadgeClass(selectedSession.status)}`}>
                            {formatSessionStatus(selectedSession.status)}
                          </span>
                          {selectedFailureType && (
                            <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${failureTypeBadgeClass(selectedFailureType)}`}>
                              {formatFailureTypeLabel(selectedFailureType)}
                            </span>
                          )}
                          {selectedLlmStatus.phase && (
                            <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${llmPhaseBadgeClass(selectedLlmStatus.phase)}`}>
                              {llmPhaseLabel(selectedLlmStatus.phase)}
                            </span>
                          )}
                          <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${llmStatusBadgeClass(selectedLlmStatus)}`}>
                            {selectedLlmStatus.label}
                          </span>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
                        <div>
                          Provider: <span className="font-mono text-slate-700 dark:text-slate-200">{selectedSession.provider}</span>
                        </div>
                        <div>
                          Model: <span className="font-mono text-slate-700 dark:text-slate-200">{selectedSession.model}</span>
                        </div>
                        <div className="md:col-span-2">
                          Run ID: <span className="font-mono text-slate-700 dark:text-slate-200">{selectedSession.id}</span>
                        </div>
                        <div className="md:col-span-2">
                          LLM status: <span className="font-semibold text-slate-700 dark:text-slate-200">{selectedLlmStatus.label}</span>
                          {selectedLlmStatus.detail ? ` - ${selectedLlmStatus.detail}` : ''}
                        </div>
                        <div>
                          Run phase: <span className="font-semibold text-slate-700 dark:text-slate-200">{llmPhaseLabel(selectedLlmStatus.phase)}</span>
                        </div>
                        <div className="truncate md:col-span-2">
                          Deep link:{' '}
                          <a
                            className="font-mono text-blue-600 underline decoration-blue-300 underline-offset-2 dark:text-blue-300"
                            href={buildRunDeepLink(selectedSession.id)}
                          >
                            {buildRunDeepLink(selectedSession.id)}
                          </a>
                        </div>
                      </div>
                    </div>
                  )}
                </header>
                <div className="flex items-center justify-between px-4 pt-3 text-[11px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">
                  <div className="flex items-center gap-1.5">
                    <MessageSquare className="h-4 w-4" />
                    Chat Timeline
                  </div>
                  {!followTimelineTail && (
                    <button
                      className="rounded border border-slate-200 bg-white px-2 py-1 text-[10px] font-medium normal-case tracking-normal text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                      onClick={() => {
                        const timelineContainer = timelineContainerRef.current;
                        if (timelineContainer) {
                          timelineContainer.scrollTop = timelineContainer.scrollHeight;
                        }
                        setFollowTimelineTail(true);
                      }}
                      type="button"
                    >
                      Jump to latest
                    </button>
                  )}
                </div>
                <div
                  ref={timelineContainerRef}
                  className="min-h-0 flex-1 space-y-2 overflow-auto bg-slate-50 p-4 pt-2 dark:bg-slate-950"
                  onScroll={handleTimelineScroll}
                >
                  {timelineItems.length === 0 && (
                    <div className="text-center text-xs italic text-slate-400 dark:text-slate-500">No chat/events yet.</div>
                  )}
                  {timelineItems.map((item) => (
                    <div
                      key={item.key}
                      className={`rounded border p-2.5 text-sm ${item.kind === 'event' ? item.tone === 'error' ? 'border-red-200 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100' : item.tone === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100' : item.tone === 'tool' ? 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100' : 'border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200' : item.role === 'user' ? 'border-blue-100 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-100' : 'border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'}`}
                    >
                      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-widest text-slate-400 dark:text-slate-500">
                        <span>{item.kind === 'event' ? item.title : item.role}</span>
                        <span>{new Date(item.time).toLocaleTimeString([], { hour12: false })}</span>
                      </div>
                      {item.kind === 'event' && item.subtitle && (
                        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium opacity-80">
                          <span>{item.subtitle}</span>
                          {item.failureType && (
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${failureTypeBadgeClass(item.failureType)}`}>
                              {formatFailureTypeLabel(item.failureType)}
                            </span>
                          )}
                        </div>
                      )}
                      {item.kind === 'event' && item.tone === 'tool' && <MarkdownMessage content={item.content} dark={isDark} />}
                      {item.kind === 'event' && item.tone !== 'tool' && (
                        <div className="whitespace-pre-wrap break-words">{item.content}</div>
                      )}
                      {item.kind === 'chat' && item.role === 'assistant' && <MarkdownMessage content={item.content} dark={isDark} />}
                      {item.kind === 'chat' && item.role === 'user' && (
                        <UserMessageContent content={item.content} contentParts={item.contentParts} />
                      )}
                    </div>
                  ))}
                </div>
                <div className="border-t border-slate-200 p-3 dark:border-slate-800">
                  <div className="mb-2 grid grid-cols-2 gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px] text-slate-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300">
                    <div className="truncate">Workspace: <span className="font-mono">{workspaces.find((workspace) => workspace.id === workWorkspaceId)?.name ?? 'none'}</span></div>
                    <div className="truncate">Provider: <span className="font-mono">{workProvider || 'none'}</span></div>
                    <div className="truncate">Model: <span className="font-mono">{workModel || 'none'}</span></div>
                    <div>Auto-approve: <span className="font-mono">{autoApprove ? 'on' : 'off'}</span></div>
                    <div>Worktree: <span className="font-mono">{useWorktree ? 'on' : 'off'}</span></div>
                  </div>
                  {selectedSession && (
                    <div className="mb-2 rounded border border-blue-200 bg-blue-50 px-2 py-1.5 text-[11px] text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-200">
                      <div className="text-[10px] font-semibold uppercase tracking-wide opacity-80">Original ask kept in context</div>
                      <div className="mt-1 line-clamp-2">{compactPromptDisplay(selectedSession.prompt)}</div>
                    </div>
                  )}
                  <div className="mb-2 flex items-center justify-between rounded border border-slate-200 bg-white px-2 py-1.5 text-[11px] dark:border-slate-700 dark:bg-slate-900">
                    <div className="text-slate-600 dark:text-slate-300">
                      Composer mode:{' '}
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${composerModeBadgeClass(composerMode)}`}>
                        {composerMode}
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">{composerModeDescription(composerMode)}</div>
                  </div>
                  <div className="flex gap-2">
                    <textarea
                      className="h-14 flex-1 resize-none rounded border border-slate-200 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                      onChange={(event) => setComposerText(event.target.value)}
                      onPaste={(event) => {
                        void handleComposerPaste(event);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          if (selectedSessionId) {
                            void handleSendChat();
                          } else {
                            void handleStartFromComposer();
                          }
                        }
                      }}
                      placeholder={selectedSessionId ? 'Chat with selected run, or use Run to start a new run from this text...' : 'Describe task and click Run...'}
                      value={composerText}
                    />
                    <div className="flex flex-col gap-2">
                      <div className="flex gap-2">
                        <button
                          className="inline-flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                          disabled={!hasComposerContent || !workWorkspaceId || !workProvider || !workModel}
                          onClick={() => {
                            void handleStartFromComposer();
                          }}
                          type="button"
                        >
                          <Play className="h-3 w-3" /> Run
                        </button>
                        <button
                          className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                          disabled={
                            !selectedSessionId
                            || !selectedSession
                            || normalizeSessionStatus(selectedSession.status) !== 'running'
                          }
                          onClick={() => {
                            void handleStop();
                          }}
                          type="button"
                        >
                          Stop
                        </button>
                      </div>
                      <button
                        className="rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-slate-700"
                        disabled={!selectedSessionId || !hasComposerContent}
                        onClick={() => {
                          void handleSendChat();
                        }}
                        type="button"
                      >
                        Send
                      </button>
                    </div>
                  </div>
                  {composerImages.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {composerImages.map((attachment) => (
                        <div key={attachment.id} className="group relative overflow-hidden rounded border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
                          <img
                            alt={attachment.name}
                            className="h-16 w-16 object-cover"
                            src={attachment.dataUrl}
                          />
                          <button
                            aria-label={`Remove ${attachment.name}`}
                            className="absolute right-1 top-1 rounded bg-slate-900/70 px-1 text-[10px] text-white"
                            onClick={() => removeComposerAttachment(attachment.id)}
                            type="button"
                          >
                            x
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            </aside>
          </div>
        ) : (
          <div className="h-full overflow-auto p-8 dark:bg-slate-950">
            <h2 className="mb-5 flex items-center gap-2 text-2xl font-bold text-slate-800 dark:text-slate-100">
              <Settings className="h-6 w-6" />
              Environment Settings
            </h2>

            <div className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">Providers</h3>
              <div className="space-y-2">
                {providers.map((provider) => {
                  const status = providerStatuses.find((entry) => entry.provider === provider.id)?.source ?? 'none';
                  return (
                    <div key={provider.id} className="flex items-center justify-between rounded border border-slate-100 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950">
                      <span className="font-mono text-slate-700 dark:text-slate-200">{provider.id}</span>
                      <span className={`rounded px-2 py-0.5 text-xs ${status === 'none' ? 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'}`}>
                        {status}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">Workspaces</h3>
              <div className="space-y-2">
                {workspaces.map((workspace) => (
                  <div key={workspace.id} className="flex items-center justify-between rounded border border-slate-100 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950">
                    <span className="truncate font-mono text-xs text-slate-600 dark:text-slate-300">{workspace.path}</span>
                    {workspace.id === activeWorkspaceId && (
                      <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">active</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">Execution</h3>
              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                <input
                  checked={useWorktree}
                  className="h-4 w-4"
                  onChange={(event) => updateActiveLlmControls({ useWorktree: event.target.checked })}
                  type="checkbox"
                />
                Create a dedicated git worktree for each new run
              </label>
            </div>
          </div>
        )}
      </main>

      {errorMessage && (
        <div className="fixed bottom-3 right-3 max-w-xl rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 shadow dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {errorMessage}
        </div>
      )}

      {isLlmControlsModalOpen && (
        <div
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
          role="dialog"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setIsLlmControlsModalOpen(false);
            }
          }}
        >
          <div className="w-full max-w-xl rounded-lg border border-slate-200 bg-white p-4 shadow-xl dark:border-slate-700 dark:bg-slate-900">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">Edit LLM Controls</h2>
              <button
                className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                onClick={() => setIsLlmControlsModalOpen(false)}
                type="button"
              >
                Close
              </button>
            </div>

            <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-2">
              <select
                className="rounded border border-slate-200 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                value={workWorkspaceId}
                onChange={(event) => updateActiveLlmControls({ workspaceId: event.target.value })}
              >
                <option value="">Workspace</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                ))}
              </select>

              <select
                className="rounded border border-slate-200 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                value={workProvider}
                onChange={(event) => {
                  updateActiveLlmControls({
                    provider: event.target.value,
                    model: '',
                  });
                }}
              >
                <option value="">Provider</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.id}</option>
                ))}
              </select>

              <select
                className="rounded border border-slate-200 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900 md:col-span-2"
                value={workModel}
                onChange={(event) => updateActiveLlmControls({ model: event.target.value })}
              >
                <option value="">Model</option>
                {currentModels.map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>

              <label className="md:col-span-2 flex items-center gap-2 rounded border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                <input
                  checked={autoApprove}
                  className="h-4 w-4"
                  onChange={(event) => updateActiveLlmControls({ autoApprove: event.target.checked })}
                  type="checkbox"
                />
                Auto-approve
              </label>

              <label className="md:col-span-2 flex items-center gap-2 rounded border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                <input
                  checked={useWorktree}
                  className="h-4 w-4"
                  onChange={(event) => updateActiveLlmControls({ useWorktree: event.target.checked })}
                  type="checkbox"
                />
                Use worktree for new runs
              </label>
            </div>

            <div className="flex justify-end">
              <button
                className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white"
                onClick={() => setIsLlmControlsModalOpen(false)}
                type="button"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
