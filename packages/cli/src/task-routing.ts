import { classifyTaskPrompt, type TaskRouteCategory, type TaskRouteResult } from '@orchestrace/core';
import type { TaskType } from '@orchestrace/core';

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
  const result = classifyTaskPrompt(prompt, forceCategory ? { forceCategory } : undefined);
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
  return command || undefined;
}