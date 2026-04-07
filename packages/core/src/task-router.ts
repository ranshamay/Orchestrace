export type TaskRouteCategory = 'shell_command' | 'investigation' | 'code_change' | 'refactor';

export type TaskRouteStrategy = 'direct_shell' | 'read_only_analysis' | 'full_planning_pipeline';

export interface TaskRouteResult {
  category: TaskRouteCategory;
  strategy: TaskRouteStrategy;
  confidence: number;
  reason: string;
  source: 'heuristic' | 'override' | 'fallback';
}

const SHELL_PREFIXES = [
  'run ',
  'execute ',
  'exec ',
  'shell ',
  'command ',
  'cmd ',
  '$ ',
] as const;

const SHELL_COMMAND_PATTERNS = [
  /^(?:\$\s*)?(pnpm|npm|yarn|node|npx|git|cat|echo|grep|find|sed|awk|curl|bash|zsh|python|make|docker|kubectl)(?:\s|$)/,
  /^(?:\$\s*)?ls(?:\s|$)/,
  /^(?:\$\s*)?pwd(?:\s|$)/,
] as const;

const INVESTIGATION_HINTS = [
  'investigate',
  'analyze',
  'explain',
  'summarize',
  'what is',
  'where is',
  'why does',
  'read-only',
  'read only',
  'inspect',
  'diagnose',
  'find out',
] as const;

const REFACTOR_HINTS = [
  'refactor',
  'restructure',
  'cleanup',
  'clean up',
  'reorganize',
  'extract',
  'rename',
] as const;

const CODE_CHANGE_HINTS = [
  'implement',
  'add ',
  'change ',
  'modify',
  'fix',
  'update',
  'create',
  'remove',
  'delete',
  'patch',
  'write ',
] as const;

function normalizePrompt(prompt: string): string {
  return prompt.trim().toLowerCase();
}

function clampConfidence(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function strategyForTaskRoute(category: TaskRouteCategory): TaskRouteStrategy {
  switch (category) {
    case 'shell_command':
      return 'direct_shell';
    case 'investigation':
      return 'read_only_analysis';
    case 'refactor':
    case 'code_change':
    default:
      return 'full_planning_pipeline';
  }
}

export function classifyTaskPrompt(prompt: string, options?: { forceCategory?: TaskRouteCategory }): TaskRouteResult {
  const forced = options?.forceCategory;
  if (forced) {
    return {
      category: forced,
      strategy: strategyForTaskRoute(forced),
      confidence: 1,
      reason: 'Explicit route override provided.',
      source: 'override',
    };
  }

  const normalized = normalizePrompt(prompt);
  if (!normalized) {
    return {
      category: 'code_change',
      strategy: strategyForTaskRoute('code_change'),
      confidence: 0,
      reason: 'Prompt is empty; defaulting to safe full planning pipeline.',
      source: 'fallback',
    };
  }

  const isMultilineOrLong = normalized.includes('\n') || normalized.length > 200;
  const looksLikeShellPrefix = SHELL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  const hasShellHint = SHELL_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
  if (!isMultilineOrLong && (looksLikeShellPrefix || hasShellHint)) {
    return {
      category: 'shell_command',
      strategy: strategyForTaskRoute('shell_command'),
      confidence: looksLikeShellPrefix ? 0.97 : 0.88,
      reason: looksLikeShellPrefix
        ? 'Prompt starts with shell-command directive.'
        : 'Prompt includes shell command tokens.',
      source: 'heuristic',
    };
  }

  const hasInvestigationHint = INVESTIGATION_HINTS.some((hint) => normalized.includes(hint));
  const hasCodeHint = CODE_CHANGE_HINTS.some((hint) => normalized.includes(hint));
  const hasRefactorHint = REFACTOR_HINTS.some((hint) => normalized.includes(hint));

  if (hasInvestigationHint && !hasCodeHint && !hasRefactorHint) {
    return {
      category: 'investigation',
      strategy: strategyForTaskRoute('investigation'),
      confidence: 0.82,
      reason: 'Prompt appears analysis-oriented without explicit code-change intent.',
      source: 'heuristic',
    };
  }

  if (hasRefactorHint) {
    return {
      category: 'refactor',
      strategy: strategyForTaskRoute('refactor'),
      confidence: 0.86,
      reason: 'Prompt includes refactor intent keywords.',
      source: 'heuristic',
    };
  }

  if (hasCodeHint) {
    return {
      category: 'code_change',
      strategy: strategyForTaskRoute('code_change'),
      confidence: 0.78,
      reason: 'Prompt includes implementation/change intent keywords.',
      source: 'heuristic',
    };
  }

  return {
    category: 'code_change',
    strategy: strategyForTaskRoute('code_change'),
    confidence: clampConfidence(0.55),
    reason: 'Ambiguous prompt; defaulting to safe full planning pipeline.',
    source: 'fallback',
  };
}