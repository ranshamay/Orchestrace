// ---------------------------------------------------------------------------
// Observer — Event Log Summarizer
// ---------------------------------------------------------------------------
// Reads a session's event log and produces a condensed text summary suitable
// for LLM analysis. Keeps token budget manageable by trimming verbose payloads.
// ---------------------------------------------------------------------------

import type { EventStore, SessionEvent, MaterializedSession } from '@orchestrace/store';
import { materializeSession } from '@orchestrace/store';

/** Max characters for a single tool call's input/output in the summary. */
const TOOL_PREVIEW_LIMIT = 2000;
/** Max stream-delta characters to include. */
const STREAM_DELTA_LIMIT = 4000;
/** Max number of llm status entries to include in one summary. */
const LLM_STATUS_HISTORY_MAX_ENTRIES = 160;

export interface SessionSummary {
  sessionId: string;
  config: {
    prompt: string;
    provider: string;
    model: string;
    workspacePath: string;
    autoApprove: boolean;
  };
  status: string;
  error?: string;
  output?: string;
  llmStatusHistory: Array<{ time: string; state: string; detail?: string }>;
  dagEvents: Array<{ time: string; type: string; taskId?: string; message: string }>;
  toolCalls: Array<{
    time: string;
    toolName: string;
    inputPreview: string;
    outputPreview: string;
    isError: boolean;
  }>;
  agentGraph: Array<{
    id: string;
    name?: string;
    status?: string;
    prompt: string;
  }>;
  todos: Array<{ text: string; status?: string; done: boolean }>;
  streamedText: string;
  totalEvents: number;
  durationMs: number | null;
}

/**
 * Read and summarize a session's full event log.
 */
export async function summarizeSession(
  eventStore: EventStore,
  sessionId: string,
): Promise<SessionSummary | null> {
  const events = await eventStore.read(sessionId);
  if (events.length === 0) return null;

  const mat = materializeSession(events);
  if (!mat) return null;

  return buildSummary(sessionId, events, mat);
}

function buildSummary(
  sessionId: string,
  events: SessionEvent[],
  mat: MaterializedSession,
): SessionSummary {
  const llmStatusHistory: SessionSummary['llmStatusHistory'] = [];
  const toolCalls: SessionSummary['toolCalls'] = [];
  const dagEvents: SessionSummary['dagEvents'] = [];
  let streamedText = '';

  for (const event of events) {
    switch (event.type) {
      case 'session:llm-status-change':
        llmStatusHistory.push({
          time: event.time,
          state: event.payload.llmStatus.state,
          detail: event.payload.llmStatus.detail,
        });
        break;

      case 'session:dag-event': {
        const dag = event.payload.event;
        // Extract tool calls from dag events
        if (dag.type === 'task:tool-call') {
          const parsed = tryParseToolCall(dag.message);
          if (parsed) {
            toolCalls.push({
              time: event.time,
              toolName: parsed.toolName,
              inputPreview: truncate(parsed.input, TOOL_PREVIEW_LIMIT),
              outputPreview: truncate(parsed.output, TOOL_PREVIEW_LIMIT),
              isError: parsed.isError,
            });
          }
        }
        dagEvents.push({
          time: event.time,
          type: dag.type,
          taskId: dag.taskId,
          message: truncate(dag.message, 500),
        });
        break;
      }

      case 'session:stream-delta':
        if (streamedText.length < STREAM_DELTA_LIMIT) {
          streamedText += event.payload.delta;
        }
        break;
    }
  }

  const firstTime = events[0]?.time;
  const lastTime = events[events.length - 1]?.time;
  const durationMs =
    firstTime && lastTime
      ? new Date(lastTime).getTime() - new Date(firstTime).getTime()
      : null;

  const compactedLlmStatusHistory = compactLlmStatusHistory(llmStatusHistory);

  return {
    sessionId,
    config: {
      prompt: mat.config.prompt,
      provider: mat.config.provider,
      model: mat.config.model,
      workspacePath: mat.config.workspacePath,
      autoApprove: mat.config.autoApprove,
    },
    status: mat.status,
    error: mat.error,
    output: mat.output?.text ? truncate(mat.output.text, 3000) : undefined,
    llmStatusHistory: compactedLlmStatusHistory,
    dagEvents,
    toolCalls,
    agentGraph: mat.agentGraph.map((n) => ({
      id: n.id,
      name: n.name,
      status: n.status,
      prompt: truncate(n.prompt, 500),
    })),
    todos: mat.todos.map((t) => ({
      text: t.text,
      status: t.status,
      done: t.done,
    })),
    streamedText: truncate(streamedText, STREAM_DELTA_LIMIT),
    totalEvents: events.length,
    durationMs,
  };
}

function compactLlmStatusHistory(
  history: SessionSummary['llmStatusHistory'],
): SessionSummary['llmStatusHistory'] {
  if (history.length === 0) {
    return history;
  }

  const collapsed: Array<{
    time: string;
    state: string;
    detail?: string;
    count: number;
    key: string;
  }> = [];

  for (const entry of history) {
    const key = `${entry.state}|${entry.detail ?? ''}`;
    const previous = collapsed[collapsed.length - 1];
    if (previous && previous.key === key) {
      previous.count += 1;
      previous.time = entry.time;
      continue;
    }

    collapsed.push({
      time: entry.time,
      state: entry.state,
      detail: entry.detail,
      count: 1,
      key,
    });
  }

  const condensed = collapsed.map((entry) => {
    if (entry.count <= 1) {
      return {
        time: entry.time,
        state: entry.state,
        detail: entry.detail,
      };
    }

    if (entry.detail && entry.detail.length > 0) {
      return {
        time: entry.time,
        state: entry.state,
        detail: `${entry.detail} [repeated ${entry.count}x]`,
      };
    }

    return {
      time: entry.time,
      state: entry.state,
      detail: `Repeated ${entry.state} status update ${entry.count}x.`,
    };
  });

  if (condensed.length <= LLM_STATUS_HISTORY_MAX_ENTRIES) {
    return condensed;
  }

  const middleMarkerSlots = 1;
  const keepCount = Math.max(2, LLM_STATUS_HISTORY_MAX_ENTRIES - middleMarkerSlots);
  const headCount = Math.ceil(keepCount / 2);
  const tailCount = Math.floor(keepCount / 2);
  const omittedCount = condensed.length - headCount - tailCount;

  const marker = {
    time: condensed[headCount]?.time ?? condensed[condensed.length - tailCount - 1]?.time ?? condensed[0].time,
    state: 'analyzing',
    detail: `${omittedCount} status transitions omitted for brevity.`,
  };

  return [
    ...condensed.slice(0, headCount),
    marker,
    ...condensed.slice(condensed.length - tailCount),
  ];
}

/** Try to parse a tool-call message into structured form. */
function tryParseToolCall(
  message: string,
): { toolName: string; input: string; output: string; isError: boolean } | null {
  // dag events for tool calls have format: "Tool <name> input <json>" or "Tool <name> output <json>"
  const toolMatch = message.match(/^Tool\s+(\S+)\s+(input|output)\s+/);
  if (!toolMatch) return null;
  const toolName = toolMatch[1];
  const phase = toolMatch[2];
  const rest = message.slice(toolMatch[0].length);

  if (phase === 'input') {
    return { toolName, input: rest, output: '', isError: false };
  }
  return { toolName, input: '', output: rest, isError: message.includes('[error]') };
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `…[truncated ${s.length - maxLen} chars]`;
}

/**
 * Format a session summary as a text block for LLM consumption.
 */
export function formatSummaryForLlm(summary: SessionSummary): string {
  const lines: string[] = [];

  lines.push(`## Session ${summary.sessionId}`);
  lines.push(`Prompt: ${summary.config.prompt}`);
  lines.push(`Provider: ${summary.config.provider} / Model: ${summary.config.model}`);
  lines.push(`Workspace: ${summary.config.workspacePath}`);
  lines.push(`Status: ${summary.status}${summary.error ? ` — Error: ${summary.error}` : ''}`);
  lines.push(`Duration: ${summary.durationMs != null ? `${(summary.durationMs / 1000).toFixed(1)}s` : 'unknown'}`);
  lines.push(`Total events: ${summary.totalEvents}`);
  lines.push('');

  if (summary.output) {
    lines.push('### Output');
    lines.push(summary.output);
    lines.push('');
  }

  if (summary.agentGraph.length > 0) {
    lines.push('### Agent Graph');
    for (const node of summary.agentGraph) {
      lines.push(`- [${node.status ?? 'unknown'}] ${node.name ?? node.id}: ${node.prompt}`);
    }
    lines.push('');
  }

  if (summary.todos.length > 0) {
    lines.push('### Todos');
    for (const todo of summary.todos) {
      lines.push(`- [${todo.done ? 'x' : ' '}] (${todo.status ?? '?'}) ${todo.text}`);
    }
    lines.push('');
  }

  if (summary.toolCalls.length > 0) {
    lines.push(`### Tool Calls (${summary.toolCalls.length} total)`);
    for (const tc of summary.toolCalls) {
      lines.push(`[${tc.time}] ${tc.toolName}${tc.isError ? ' [ERROR]' : ''}`);
      if (tc.inputPreview) lines.push(`  Input: ${tc.inputPreview}`);
      if (tc.outputPreview) lines.push(`  Output: ${tc.outputPreview}`);
    }
    lines.push('');
  }

  if (summary.llmStatusHistory.length > 0) {
    lines.push('### LLM Status History');
    for (const s of summary.llmStatusHistory) {
      lines.push(`[${s.time}] ${s.state}${s.detail ? ` — ${s.detail}` : ''}`);
    }
    lines.push('');
  }

  if (summary.streamedText) {
    lines.push('### Streamed Agent Text (excerpt)');
    lines.push(summary.streamedText);
    lines.push('');
  }

  return lines.join('\n');
}
