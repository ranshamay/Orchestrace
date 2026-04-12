import type { TimelineItem } from '../types';
import { normalizeFailureType } from './failure';
import { compactInline, parseJsonObject, stripRunTag, stripTaskPrefix } from './text';

interface SearchFilesErrorDetails {
  errorType?: string;
  message?: string;
  stderr?: string;
  exitCode?: number;
  toolName?: string;
  command?: string;
  path?: string;
}


function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatTokenCount(value: number): string {
  return Math.round(value).toLocaleString();
}

function summarizeSubAgentBatchInput(payload: string): string | undefined {
  const parsed = parseJsonObject(payload);
  const rawAgents = parsed && Array.isArray(parsed.agents) ? parsed.agents : [];
  if (rawAgents.length === 0) {
    return undefined;
  }

  const concurrency = asNumber(parsed?.concurrency);
  const adaptiveConcurrency = parsed?.adaptiveConcurrency === true;
  const minConcurrency = asNumber(parsed?.minConcurrency);

  const settings: string[] = [];
  if (concurrency) {
    settings.push(`c=${concurrency}`);
  }
  if (adaptiveConcurrency) {
    settings.push(minConcurrency ? `adaptive,min=${minConcurrency}` : 'adaptive');
  }

  const items = rawAgents
    .slice(0, 4)
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        return `task-${index + 1}`;
      }

      const record = entry as Record<string, unknown>;
      const nodeId = typeof record.nodeId === 'string' && record.nodeId.trim() ? record.nodeId.trim() : `task-${index + 1}`;
      const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
      return prompt ? `${nodeId} (${prompt.length} chars)` : nodeId;
    });

  const suffix = rawAgents.length > items.length ? `, +${rawAgents.length - items.length} more` : '';
  const settingsText = settings.length > 0 ? ` (${settings.join(', ')})` : '';
  return `Spawning ${rawAgents.length} sub-agents${settingsText}: ${items.join(', ')}${suffix}`;
}

function summarizeSubAgentInput(payload: string): string | undefined {
  const parsed = parseJsonObject(payload);
  if (!parsed) {
    return undefined;
  }

  const nodeId = typeof parsed.nodeId === 'string' && parsed.nodeId.trim() ? parsed.nodeId.trim() : undefined;
  const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';
  const nodeText = nodeId ? ` ${nodeId}` : '';
  if (prompt) {
    return `Spawning sub-agent${nodeText} (${prompt.length} chars)`;
  }

  return `Spawning sub-agent${nodeText}`;
}

function summarizeSubAgentBatchOutput(payload: string): string | undefined {
  const parsed = parseJsonObject(payload);
  if (!parsed) {
    return undefined;
  }

  const total = asNumber(parsed.total);
  const completed = asNumber(parsed.completed);
  const failed = asNumber(parsed.failed);
  const usage = parsed.usage && typeof parsed.usage === 'object' ? parsed.usage as Record<string, unknown> : undefined;
  const usageInput = asNumber(usage?.input);
  const usageOutput = asNumber(usage?.output);
  const decomposition = parsed.decomposition && typeof parsed.decomposition === 'object'
    ? parsed.decomposition as Record<string, unknown>
    : undefined;
  const averagePromptChars = asNumber(decomposition?.averagePromptChars);

  const pieces: string[] = [];
  if (typeof completed === 'number' && typeof total === 'number') {
    pieces.push(`Batch result ${completed}/${total} completed`);
  } else if (typeof total === 'number') {
    pieces.push(`Batch result (${total} tasks)`);
  } else {
    pieces.push('Batch result');
  }

  if (typeof failed === 'number' && failed > 0) {
    pieces.push(`${failed} failed`);
  }

  if (typeof usageInput === 'number' || typeof usageOutput === 'number') {
    pieces.push(`in ${formatTokenCount(usageInput ?? 0)}, out ${formatTokenCount(usageOutput ?? 0)}`);
  }

  if (typeof averagePromptChars === 'number' && averagePromptChars > 0) {
    pieces.push(`avg task ${averagePromptChars} chars`);
  }

  return pieces.join(' • ');
}

function summarizeSubAgentOutput(payload: string, isError: boolean): string | undefined {
  const parsed = parseJsonObject(payload);
  if (!parsed) {
    return undefined;
  }

  const status = typeof parsed.status === 'string' ? parsed.status : undefined;
  const usage = parsed.usage && typeof parsed.usage === 'object' ? parsed.usage as Record<string, unknown> : undefined;
  const usageInput = asNumber(usage?.input);
  const usageOutput = asNumber(usage?.output);
  const nodeId = typeof parsed.nodeId === 'string' && parsed.nodeId.trim() ? parsed.nodeId.trim() : undefined;
  const prefix = nodeId ? `Sub-agent ${nodeId}` : 'Sub-agent';

  if (status === 'failed' || isError) {
    return `${prefix} failed`;
  }

  if (typeof usageInput === 'number' || typeof usageOutput === 'number') {
    return `${prefix} completed • in ${formatTokenCount(usageInput ?? 0)}, out ${formatTokenCount(usageOutput ?? 0)}`;
  }

  return `${prefix} completed`;
}

function summarizeSubAgentWorkerInput(payload: string): string | undefined {
  const parsed = parseJsonObject(payload);
  if (!parsed) {
    return undefined;
  }

  const nodeId = typeof parsed.nodeId === 'string' && parsed.nodeId.trim() ? parsed.nodeId.trim() : undefined;
  const promptChars = asNumber(parsed.promptChars);
  const provider = typeof parsed.provider === 'string' && parsed.provider.trim() ? parsed.provider.trim() : undefined;
  const model = typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : undefined;

  const pieces: string[] = [];
  pieces.push(nodeId ? `Sub-agent ${nodeId} started` : 'Sub-agent started');

  if (typeof promptChars === 'number') {
    pieces.push(`${promptChars} chars`);
  }

  if (provider && model) {
    pieces.push(`${provider}/${model}`);
  }

  return pieces.join(' • ');
}

function summarizeSubAgentWorkerOutput(payload: string, isError: boolean): string | undefined {
  const parsed = parseJsonObject(payload);
  if (!parsed) {
    return undefined;
  }

  const nodeId = typeof parsed.nodeId === 'string' && parsed.nodeId.trim() ? parsed.nodeId.trim() : undefined;
  const status = typeof parsed.status === 'string' ? parsed.status : undefined;
  const usage = parsed.usage && typeof parsed.usage === 'object' ? parsed.usage as Record<string, unknown> : undefined;
  const usageInput = asNumber(usage?.input);
  const usageOutput = asNumber(usage?.output);
  const failureType = normalizeFailureType(typeof parsed.failureType === 'string' ? parsed.failureType : undefined);
  const recoverable = parsed.recoverable === true;

  const prefix = nodeId ? `Sub-agent ${nodeId}` : 'Sub-agent';
  if (isError || status === 'failed') {
    const failureBits: string[] = [];
    if (failureType) {
      failureBits.push(failureType.replace(/_/g, ' '));
    }
    if (recoverable) {
      failureBits.push('recoverable');
    }

    return failureBits.length > 0
      ? `${prefix} failed • ${failureBits.join(', ')}`
      : `${prefix} failed`;
  }

  if (typeof usageInput === 'number' || typeof usageOutput === 'number') {
    return `${prefix} completed • in ${formatTokenCount(usageInput ?? 0)}, out ${formatTokenCount(usageOutput ?? 0)}`;
  }

  return `${prefix} completed`;
}

function formatToolLabel(toolName: string): string {
  if (toolName === 'subagent_worker') {
    return 'sub-agent';
  }

  return toolName;
}

export function toolInputSummary(toolName: string, payload: string): string {
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

  if (toolName === 'playwright_run') {
    const command = parsed && typeof parsed.command === 'string' ? parsed.command : 'test';
    return `Running Playwright: ${compactInline(command, 160)}`;
  }

  if (toolName.startsWith('todo_')) {
    return 'Updating checklist';
  }

  if (toolName === 'agent_graph_set') {
    return 'Updating execution graph';
  }

  if (toolName === 'subagent_spawn') {
    return summarizeSubAgentInput(payload) ?? 'Spawning sub-agent';
  }

  if (toolName === 'subagent_spawn_batch') {
    return summarizeSubAgentBatchInput(payload) ?? 'Spawning sub-agents in parallel';
  }

  if (toolName === 'subagent_worker') {
    return summarizeSubAgentWorkerInput(payload) ?? 'Running sub-agent';
  }

  return `Calling ${toolName}`;
}

export function toolOutputSummary(
  toolName: string,
  payload: string,
  isError: boolean,
  details?: unknown,
): string {

  if (toolName === 'subagent_spawn_batch') {
    const summary = summarizeSubAgentBatchOutput(payload);
    if (summary) {
      return summary;
    }
  }

  if (toolName === 'subagent_spawn') {
    const summary = summarizeSubAgentOutput(payload, isError);
    if (summary) {
      return summary;
    }
  }

  if (toolName === 'subagent_worker') {
    const summary = summarizeSubAgentWorkerOutput(payload, isError);
    if (summary) {
      return summary;
    }
  }

    if (isError) {
    if (toolName === 'search_files' && details && typeof details === 'object') {
      const searchDetails = details as SearchFilesErrorDetails;
      const message = typeof searchDetails.message === 'string' && searchDetails.message.trim().length > 0
        ? searchDetails.message.trim()
        : undefined;
      const errorType = typeof searchDetails.errorType === 'string' && searchDetails.errorType.trim().length > 0
        ? searchDetails.errorType.trim().replace(/_/g, ' ')
        : undefined;
      if (message && errorType) {
        return compactInline(`Search failed (${errorType}): ${message}`, 260);
      }
      if (message) {
        return compactInline(`Search failed: ${message}`, 260);
      }
    }

    return compactInline(payload || 'Tool returned an error.', 260);
  }

  if (!payload.trim()) {
    return 'Completed with empty output.';
  }
  return compactInline(payload, 260);
}

export function formatToolPayloadForDisplay(payload: string, maxChars = 200_000): string {
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
        : toolOutputSummary(params.toolName, params.payload, params.isError);

  const payloadLimit = params.toolName === 'subagent_spawn_batch'
    ? 200_000
    : params.toolName === 'subagent_spawn'
      ? 200_000
      : params.toolName === 'subagent_worker'
        ? 200_000
      : 80_000;
  const displayPayload = formatToolPayloadForDisplay(params.payload, payloadLimit);
  const codeLanguage = displayPayload.startsWith('{') || displayPayload.startsWith('[') ? 'json' : 'text';

  return `${summary}\n\n\`\`\`${codeLanguage}\n${displayPayload}\n\`\`\``;
}

export function parseToolCallEvent(event: {
  type: string;
  message: string;
  taskId?: string;
  toolName?: string;
  toolStatus?: 'started' | 'result';
  toolInput?: string;
  toolOutput?: string;
  toolIsError?: boolean;
  toolDetails?: unknown;
}): {
  taskId: string;
  toolName: string;
  direction: 'input' | 'output';
  isError: boolean;
  payload: string;
  details?: unknown;
} | undefined {
  if (event.type !== 'task:tool-call') return undefined;

  if (event.toolName && event.toolStatus) {
    const direction = event.toolStatus === 'started' ? 'input' : 'output';
    const payload = direction === 'input' ? (event.toolInput ?? '') : (event.toolOutput ?? '');
    const taskId = typeof event.taskId === 'string' && event.taskId.trim().length > 0
      ? event.taskId
      : 'task';
    return {
      taskId,
      toolName: event.toolName,
      direction,
      isError: event.toolIsError === true,
      payload,
      details: event.toolDetails,
    };
  }

  const clean = stripRunTag(event.message);
  const match = clean.match(/^([^:]+):\s+tool\s+([a-zA-Z0-9_.-]+)\s+(input|output)(\s+\[error\])?\s*([\s\S]*)$/);
  if (!match) return undefined;
  return {
    taskId: match[1],
    toolName: match[2],
    direction: match[3] as 'input' | 'output',
    isError: Boolean(match[4]),
    payload: match[5] ?? '',
  };
}


export function formatTimelineEvent(event: {
  type: string;
  message: string;
  taskId?: string;
  failureType?: string;
  testsPassed?: number;
  testsFailed?: number;
  uiTestsRequired?: boolean;
  uiTestsRun?: boolean;
  screenshotPaths?: string[];
  rejectionReason?: string;
}): Pick<TimelineItem, 'title' | 'subtitle' | 'content' | 'tone' | 'failureType'> {
  const clean = stripRunTag(event.message);
  if (event.type === 'task:tool-call') {
    const toolMatch = clean.match(/^([^:]+):\s+tool\s+([a-zA-Z0-9_.-]+)\s+(input|output)(\s+\[error\])?\s*([\s\S]*)$/);
    if (toolMatch) {
      const toolName = toolMatch[2];
      const direction = toolMatch[3];
      const isError = Boolean(toolMatch[4]);
      const payload = toolMatch[5] ?? '';
      const toolLabel = formatToolLabel(toolName);
      if (direction === 'input') {
        return { title: `Using ${toolLabel}`, subtitle: 'Tool input', tone: 'tool', content: renderToolEventContent({ direction: 'input', toolName, payload, isError }) };
      }
      return { title: `${toolLabel} result`, subtitle: isError ? 'Tool error' : 'Tool output', tone: isError ? 'error' : 'tool', content: renderToolEventContent({ direction: 'output', toolName, payload, isError }) };
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
    case 'task:testing': {
      const uiNote = event.uiTestsRequired ? ' UI changes detected; UI tests required.' : '';
      return {
        title: 'Testing',
        subtitle: event.taskId,
        tone: 'neutral',
        content: detail || `Tester agent is generating and running tests.${uiNote}`,
      };
    }
    case 'task:tester-verdict': {
      const rejected = event.testsFailed !== undefined ? event.testsFailed > 0 : /rejected/i.test(clean);
      const summaryParts = [
        event.testsPassed !== undefined ? `passed=${event.testsPassed}` : undefined,
        event.testsFailed !== undefined ? `failed=${event.testsFailed}` : undefined,
        event.uiTestsRequired ? `uiTests=${event.uiTestsRun ? 'ran' : 'missing'}` : undefined,
        event.screenshotPaths ? `screenshots=${event.screenshotPaths.length}` : undefined,
      ].filter((value): value is string => Boolean(value));

      const fallback = rejected
        ? 'Tester agent requested implementation rework.'
        : 'Tester agent approved the implementation.';

      return {
        title: rejected ? 'Tester Rejected' : 'Tester Approved',
        subtitle: event.taskId,
        tone: rejected ? 'error' : 'success',
        content: detail || `${fallback}${summaryParts.length > 0 ? ` (${summaryParts.join(', ')})` : ''}${event.rejectionReason ? ` Reason: ${event.rejectionReason}` : ''}`,
      };
    }
    case 'task:validating':
      return { title: 'Validating', subtitle: event.taskId, tone: 'neutral', content: detail || 'Running verification checks.' };
    case 'task:completed':
    case 'graph:completed':
      return { title: 'Completed', subtitle: event.taskId, tone: 'success', content: detail || 'Run completed successfully.' };
    case 'task:failed':
    case 'graph:failed':
      return { title: 'Failed', subtitle: event.taskId, tone: 'error', failureType: normalizeFailureType(event.failureType), content: detail || 'Execution failed.' };
    default:
      return {
        title: event.type.replace('task:', '').replace('graph:', '').replace(/-/g, ' '),
        subtitle: event.taskId,
        tone: 'neutral',
        content: compactInline(detail || clean, 260),
      };
  }
}