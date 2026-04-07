import type { TaskNode } from '../dag/types.js';

export type TrivialTaskReason =
  | 'disabled'
  | 'prompt_too_long'
  | 'contains_multistep_markers'
  | 'contains_file_edit_markers'
  | 'contains_pr_markers'
  | 'single_shell_command'
  | 'informational_query'
  | 'unknown';

export interface TrivialTaskClassification {
  isTrivial: boolean;
  reasons: TrivialTaskReason[];
  promptLength: number;
  maxPromptLength: number;
}

export interface TrivialTaskGateConfig {
  enabled?: boolean;
  maxPromptLength?: number;
}

const DEFAULT_TRIVIAL_TASK_MAX_PROMPT_LENGTH = 120;

const FILE_EDIT_MARKERS = [
  'edit',
  'modify',
  'change',
  'refactor',
  'rewrite',
  'implement',
  'create file',
  'write file',
  'update file',
  'delete file',
  'rename file',
  'patch',
  'commit',
  'branch',
  'push',
  'pull request',
  'pr ',
  'github',
  'test',
  'typecheck',
  'lint',
  'build',
];

const MULTISTEP_MARKERS = [
  ' and ',
  ' then ',
  ' after ',
  ' before ',
  ' also ',
  'step',
  'first',
  'second',
  'finally',
  ';',
  '\n',
  '->',
  '=>',
];

const INFO_PREFIXES = [
  'what is ',
  'who is ',
  'where is ',
  'when is ',
  'why is ',
  'how do ',
  'how to ',
  'explain ',
  'summarize ',
  'show ',
  'list ',
  'status ',
  'version ',
];

const SHELL_COMMAND_PATTERNS: RegExp[] = [
  /^(echo|pwd|ls|whoami|date|uname|cat|head|tail|wc|env|printenv|node\s+--version|npm\s+-v|pnpm\s+-v|git\s+status)(\s+.*)?$/i,
  /^run\s+(.+)$/i,
  /^execute\s+(.+)$/i,
];

export function resolveTrivialTaskGateConfig(options?: {
  enabled?: boolean;
  maxPromptLength?: number;
}): Required<TrivialTaskGateConfig> {
  const envEnabled = parseBoolean(process.env.ORCHESTRACE_TRIVIAL_TASK_GATE_ENABLED);
  const envMaxPromptLength = parsePositiveInt(process.env.ORCHESTRACE_TRIVIAL_TASK_MAX_PROMPT_LENGTH);

  return {
    enabled: options?.enabled ?? envEnabled ?? false,
    maxPromptLength: options?.maxPromptLength ?? envMaxPromptLength ?? DEFAULT_TRIVIAL_TASK_MAX_PROMPT_LENGTH,
  };
}

export function classifyTrivialTaskPrompt(
  prompt: string,
  config?: TrivialTaskGateConfig,
): TrivialTaskClassification {
  const resolved = resolveTrivialTaskGateConfig(config);
  const normalized = normalizePrompt(prompt);

  if (!resolved.enabled) {
    return {
      isTrivial: false,
      reasons: ['disabled'],
      promptLength: normalized.length,
      maxPromptLength: resolved.maxPromptLength,
    };
  }

  if (!normalized) {
    return {
      isTrivial: false,
      reasons: ['unknown'],
      promptLength: 0,
      maxPromptLength: resolved.maxPromptLength,
    };
  }

  const reasons: TrivialTaskReason[] = [];

  if (normalized.length > resolved.maxPromptLength) {
    reasons.push('prompt_too_long');
  }

  if (containsAny(normalized, MULTISTEP_MARKERS)) {
    reasons.push('contains_multistep_markers');
  }

  if (containsAny(normalized, FILE_EDIT_MARKERS)) {
    reasons.push('contains_file_edit_markers');
  }

  if (normalized.includes('pull request') || normalized.includes('pr ') || normalized.includes('github')) {
    reasons.push('contains_pr_markers');
  }

  if (isSingleShellCommandPrompt(normalized)) {
    reasons.push('single_shell_command');
  }

  if (isInformationalQueryPrompt(normalized)) {
    reasons.push('informational_query');
  }

  const hasRiskMarkers = reasons.includes('prompt_too_long')
    || reasons.includes('contains_multistep_markers')
    || reasons.includes('contains_file_edit_markers')
    || reasons.includes('contains_pr_markers');

  const hasTrivialSignal = reasons.includes('single_shell_command')
    || reasons.includes('informational_query');

  return {
    isTrivial: hasTrivialSignal && !hasRiskMarkers,
    reasons: reasons.length > 0 ? reasons : ['unknown'],
    promptLength: normalized.length,
    maxPromptLength: resolved.maxPromptLength,
  };
}

export function classifyTrivialTaskNode(
  node: TaskNode,
  config?: TrivialTaskGateConfig,
): TrivialTaskClassification {
  return classifyTrivialTaskPrompt(node.prompt, config);
}

export function extractSingleCommandFromPrompt(prompt: string): string | undefined {
  const normalized = normalizePrompt(prompt);
  if (!isSingleShellCommandPrompt(normalized)) {
    return undefined;
  }

  const stripped = normalized
    .replace(/^please\s+/, '')
    .replace(/^can you\s+/, '')
    .replace(/^could you\s+/, '')
    .replace(/^just\s+/, '')
    .trim();

  const runMatch = stripped.match(/^(run|execute)\s+(.+)$/i);
  if (runMatch?.[2]) {
    return runMatch[2].trim();
  }

  return stripped;
}

function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ').toLowerCase();
}

function containsAny(text: string, markers: string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}

function isSingleShellCommandPrompt(normalizedPrompt: string): boolean {
  const stripped = normalizedPrompt
    .replace(/^please\s+/, '')
    .replace(/^can you\s+/, '')
    .replace(/^could you\s+/, '')
    .replace(/^just\s+/, '')
    .replace(/^run\s+command\s+/, 'run ')
    .trim();

  if (stripped.length === 0 || stripped.length > 160) {
    return false;
  }

  return SHELL_COMMAND_PATTERNS.some((pattern) => pattern.test(stripped));
}

function isInformationalQueryPrompt(normalizedPrompt: string): boolean {
  if (normalizedPrompt.length > 160) {
    return false;
  }

  if (INFO_PREFIXES.some((prefix) => normalizedPrompt.startsWith(prefix))) {
    return true;
  }

  return normalizedPrompt.endsWith('?')
    && !containsAny(normalizedPrompt, FILE_EDIT_MARKERS)
    && !containsAny(normalizedPrompt, MULTISTEP_MARKERS);
}

function parseBoolean(raw: string | undefined): boolean | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return undefined;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return undefined;
}