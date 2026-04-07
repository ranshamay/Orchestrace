import { classifyTaskPrompt, type TaskRouteCategory, type TaskRouteResult } from '@orchestrace/core';
import type { TaskType } from '@orchestrace/core';

const SHELL_COMMAND_START = /^(pnpm|npm|yarn|node|npx|git|cat|echo|grep|find|sed|awk|curl|bash|zsh|python|make|docker|kubectl|ls|pwd)(?:\s|$)/i;

const RETRY_CONTINUATION_MARKER = 'Retry continuation context from previous attempt:';
const FOLLOW_UP_MARKER = 'Follow-up request:';

export interface ResolvedRoute {
  result: TaskRouteResult;
  nodeType: TaskType;
  validationEnabled: boolean;
}

export interface ShellExecutionValidation {
  ok: boolean;
  command?: string;
  reason?: string;
}

export function parseTaskRouteOverride(raw: string | undefined): TaskRouteCategory | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'shell_command' || normalized === 'investigation' || normalized === 'code_change' || normalized === 'refactor') {
    return normalized;
  }
  return undefined;
}

export function resolveTaskRoute(prompt: string, overrideRaw?: string): ResolvedRoute {
  const forceCategory = parseTaskRouteOverride(overrideRaw);
  const classified = classifyTaskPrompt(prompt, forceCategory ? { forceCategory } : undefined);
  const result: TaskRouteResult = classified.category === 'shell_command'
    && classified.source === 'heuristic'
    && !extractShellCommand(prompt)
    ? {
      category: 'code_change',
      strategy: 'full_planning_pipeline',
      confidence: 0.45,
      reason: 'Shell heuristic matched, but prompt was not an executable command; defaulting to safe full planning pipeline.',
      source: 'fallback',
    }
    : classified;
  const nodeType: TaskType = result.category === 'refactor' ? 'refactor' : 'code';
  return {
    result,
    nodeType,
    validationEnabled: result.category !== 'investigation',
  };
}

/**
 * Observer-generated fix prompts are task instructions, never shell commands.
 * Force observer sessions into the planning/code pipeline even if a global shell
 * route override is enabled.
 */
export function resolveTaskRouteForSource(
  prompt: string,
  source: 'user' | 'observer' | undefined,
  overrideRaw?: string,
): ResolvedRoute {
  if (source === 'observer') {
    return resolveTaskRoute(prompt, 'code_change');
  }
  return resolveTaskRoute(prompt, overrideRaw);
}

/**
 * Final safety check before executing sh -lc.
 * Rejects multiline markdown/prose payloads and returns a validated command.
 */
export function validateShellExecutionPrompt(prompt: string): ShellExecutionValidation {
  const normalized = prompt.trim();
  if (!normalized) {
    return {
      ok: false,
      reason: 'Route shell_command selected, but prompt was empty.',
    };
  }
  if (normalized.includes('\n')) {
    return {
      ok: false,
      reason: 'Rejected shell execution: prompt contains multiple lines and appears to be instructions/markdown, not a single command.',
    };
  }
  const command = extractShellCommand(normalized);
  if (!command) {
    return {
      ok: false,
      reason: 'Route shell_command selected, but no executable command was found in the prompt.',
    };
  }
  return { ok: true, command };
}

/**
 * Removes retry-context scaffolding from retry execution prompts so routing/effort
 * classifiers evaluate user intent instead of serialized continuation metadata.
 */
export function stripRetryContinuationContext(prompt: string): string {
  let result = prompt.trim();
  if (!result) {
    return result;
  }

  while (true) {
    const markerIndex = result.indexOf(RETRY_CONTINUATION_MARKER);
    if (markerIndex < 0) {
      break;
    }

    const followUpIndex = result.indexOf(FOLLOW_UP_MARKER, markerIndex + RETRY_CONTINUATION_MARKER.length);
    if (followUpIndex < 0) {
      result = result.slice(0, markerIndex).trimEnd();
      break;
    }

    const prefix = result.slice(0, markerIndex).trimEnd();
    const suffix = result.slice(followUpIndex).trimStart();
    result = [prefix, suffix].filter((section) => section.length > 0).join('\n\n');
  }

  return result.trim();
}

export function extractShellCommand(prompt: string): string | undefined {
  const normalized = prompt.trim();
  if (normalized.includes('\n') || normalized.length > 200) return undefined;
  const command = normalized
    .replace(/^\$\s*/, '')
    .replace(/^(run|execute|exec|shell|command|cmd)\s+/i, '')
    .trim();
  if (!command) return undefined;
  if (!SHELL_COMMAND_START.test(command)) return undefined;
  return command || undefined;
}
