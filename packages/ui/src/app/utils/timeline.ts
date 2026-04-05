import type { TimelineItem } from '../types';
import { normalizeFailureType } from './failure';
import { compactInline, parseJsonObject, stripRunTag, stripTaskPrefix } from './text';

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
    return 'Spawning sub-agent';
  }

  if (toolName === 'subagent_spawn_batch') {
    return 'Spawning sub-agents in parallel';
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

export function formatTimelineEvent(event: { type: string; message: string; taskId?: string; failureType?: string }): Pick<TimelineItem, 'title' | 'subtitle' | 'content' | 'tone' | 'failureType'> {
  const clean = stripRunTag(event.message);
  if (event.type === 'task:tool-call') {
    const toolMatch = clean.match(/^([^:]+):\s+tool\s+([a-zA-Z0-9_.-]+)\s+(input|output)(\s+\[error\])?\s*([\s\S]*)$/);
    if (toolMatch) {
      const toolName = toolMatch[2];
      const direction = toolMatch[3];
      const isError = Boolean(toolMatch[4]);
      const payload = toolMatch[5] ?? '';
      if (direction === 'input') {
        return { title: `Using ${toolName}`, subtitle: 'Tool input', tone: 'tool', content: renderToolEventContent({ direction: 'input', toolName, payload, isError }) };
      }
      return { title: `${toolName} result`, subtitle: isError ? 'Tool error' : 'Tool output', tone: isError ? 'error' : 'tool', content: renderToolEventContent({ direction: 'output', toolName, payload, isError }) };
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