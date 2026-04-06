import type { AgentTodo, ChatContentPart, ChatMessage, WorkSession } from '../../lib/api';
import { resolveSessionFailureType } from './failure';
import { resolveLlmStatus } from './llm';
import { compactInline, stripRunTag } from './text';

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

export function indentBlock(text: string, prefix = '    '): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

export function buildSessionTraceExport(
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
  lines.push('Worktree mode: native git worktree');
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