// ---------------------------------------------------------------------------
// Chat Formatter — renders ChatMessage[] to terminal ANSI output
// ---------------------------------------------------------------------------

import type {
  ChatMessage,
  MessagePart,
  ChatSessionPhase,
} from '@orchestrace/store';
import {
  resolveToolIcon,
  ROLE_ICON,
  PHASE_ICON,
  STATUS_ICON,
  REASONING_ICON,
  OBSERVER_ICON,
  APPROVAL_ICON,
  CONTEXT_ICON,
} from '@orchestrace/store';

// ─── ANSI helpers ───────────────────────────────────────────────────────────

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

// ─── Part formatters ────────────────────────────────────────────────────────

export function formatPartLine(part: MessagePart): string {
  switch (part.type) {
    case 'reasoning':
      return `${REASONING_ICON} ${DIM}(${part.text.length.toLocaleString()} chars)${RESET}`;

    case 'text':
      return part.text;

    case 'tool-call': {
      const icon = resolveToolIcon(part.toolName);
      const status = part.status === 'success'
        ? `${GREEN}${STATUS_ICON.success}${RESET}`
        : part.status === 'error'
          ? `${RED}${STATUS_ICON.error}${RESET}`
          : `${YELLOW}${STATUS_ICON.calling}${RESET}`;
      const summary = part.inputSummary || '';
      const output = part.outputSummary ? `  ${DIM}${part.outputSummary}${RESET}` : '';
      return `${icon} ${part.toolName}  ${summary}  ${status}${output}`;
    }

    case 'phase-transition':
      return formatPhaseTransition(part.phase, part.label);

    case 'context-snapshot':
      return `${CONTEXT_ICON} ${part.model} · ${part.textChars.toLocaleString()} chars`;

    case 'approval-request':
      return `${APPROVAL_ICON} Plan ready · ${part.status}`;

    case 'observer-finding':
      return `${OBSERVER_ICON} [${part.severity}] ${part.title}`;

    case 'error':
      return `${RED}💥 ${part.message}${RESET}`;

    default:
      return '';
  }
}

export function formatPhaseTransition(phase: ChatSessionPhase, label?: string, model?: string): string {
  const icon = PHASE_ICON[phase] ?? '📋';
  const text = label ?? (phase.charAt(0).toUpperCase() + phase.slice(1));
  const modelPart = model ? ` · ${model}` : '';
  return `\n${DIM}── ${RESET}${BOLD}${icon} ${text}${modelPart}${RESET} ${DIM}${'─'.repeat(40)}${RESET}`;
}

export function formatMessage(msg: ChatMessage): string {
  const lines: string[] = [];
  const roleIcon = ROLE_ICON[msg.role] ?? '🤖';

  if (msg.role === 'user') {
    const textParts = msg.parts.filter((p) => p.type === 'text');
    const text = textParts.map((p) => p.type === 'text' ? p.text : '').join('\n');
    lines.push(`${CYAN}${roleIcon} ${text}${RESET}`);
    return lines.join('\n');
  }

  // Skip role header for system-only phase-transition messages
  if (msg.role === 'system' && msg.parts.length === 1 && msg.parts[0].type === 'phase-transition') {
    return formatPartLine(msg.parts[0]);
  }

  for (const part of msg.parts) {
    const line = formatPartLine(part);
    if (line) lines.push(line);
  }

  return lines.join('\n');
}
