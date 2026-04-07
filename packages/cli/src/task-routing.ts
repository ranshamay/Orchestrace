import { classifyTaskPrompt, type TaskRouteCategory, type TaskRouteResult } from '@orchestrace/core';
import type { TaskType } from '@orchestrace/core';

const SHELL_COMMAND_START = /^(pnpm|npm|yarn|node|npx|git|cat|echo|grep|find|sed|awk|curl|bash|zsh|python|make|docker|kubectl|ls|pwd)(?:\s|$)/i;

export interface ResolvedRoute {
  result: TaskRouteResult;
  nodeType: TaskType;
  validationEnabled: boolean;
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
