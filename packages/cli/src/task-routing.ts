import { classifyTaskPrompt, type TaskRouteCategory, type TaskRouteResult } from '@orchestrace/core';
import type { TaskType } from '@orchestrace/core';

const ALLOWED_SHELL_PROGRAMS = [
  'pnpm',
  'npm',
  'yarn',
  'node',
  'npx',
  'git',
  'cat',
  'echo',
  'grep',
  'find',
  'sed',
  'awk',
  'curl',
  'python',
  'make',
  'docker',
  'kubectl',
  'ls',
  'pwd',
] as const;

const ALLOWED_SHELL_PROGRAMS_SET = new Set<string>(ALLOWED_SHELL_PROGRAMS);
const SHELL_COMMAND_START = new RegExp(`^(${ALLOWED_SHELL_PROGRAMS.join('|')})(?:\\s|$)`, 'i');
const MARKDOWN_LIKE_PAYLOAD = /(^\s*\[[^\]]+\])|(^\s*#{1,6}\s+\S)|(```)|(^\s*(?:Category|Severity|Issue|Task):\s)/im;
const FORBIDDEN_SHELL_META_CHARS = /[;&|<>`]/;
const FORBIDDEN_SHELL_SUBSTITUTIONS = /(\$\(|\$\{|\$\(\()/;


const RETRY_CONTINUATION_MARKER = 'Retry continuation context from previous attempt:';
const FOLLOW_UP_MARKER = 'Follow-up request:';

export interface ResolvedRoute {
  result: TaskRouteResult;
  nodeType: TaskType;
  validationEnabled: boolean;
}

export interface ParsedShellCommand {
  program: string;
  args: string[];
}

export interface ShellExecutionValidation {
  ok: boolean;
  command?: string;
  parsed?: ParsedShellCommand;
  reason?: string;
}


export interface SafeDispatchResolution {
  route: TaskRouteResult;
  shell: ShellExecutionValidation;
}

export interface ShellDispatchSourceValidation {
  ok: boolean;
  reason?: string;
}

export type RoutingCoercionType =
  | 'route_mismatch'
  | 'shell_source_guard_demotion'
  | 'shell_prompt_validation_demotion';

export interface RoutingCoercionAudit {
  coercionType: RoutingCoercionType;
  originalRoute: TaskRouteCategory;
  finalRoute: TaskRouteCategory;
  reason: string;
  risk: 'high' | 'medium';
}

export function parseTaskRouteOverride(raw: string | undefined): TaskRouteCategory | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'shell_command' || normalized === 'investigation' || normalized === 'code_change' || normalized === 'refactor') {
    return normalized;
  }
  return undefined;
}

function fallbackToCodeChangeRoute(result: TaskRouteResult, reason: string): TaskRouteResult {
  return {
    category: 'code_change',
    strategy: 'full_planning_pipeline',
    confidence: result.confidence,
    reason,
    source: 'fallback',
  };
}

export function resolveTaskRoute(prompt: string, overrideRaw?: string): ResolvedRoute {
  const forceCategory = parseTaskRouteOverride(overrideRaw);
  const classified = classifyTaskPrompt(prompt, forceCategory ? { forceCategory } : undefined);
  const result: TaskRouteResult = classified.category === 'shell_command'
    && classified.source === 'heuristic'
    && !extractShellCommand(prompt)
    ? fallbackToCodeChangeRoute(
      classified,
      'Shell heuristic matched, but prompt was not an executable command; defaulting to safe full planning pipeline.',
    )
    : classified;
  const nodeType: TaskType = result.category === 'refactor' ? 'refactor' : 'code';
  return {
    result,
    nodeType,
    validationEnabled: result.category !== 'investigation',
  };
}

/**
 * Enforces the final dispatch contract shared by runner + CLI entrypoints.
 * Shell dispatch is only allowed when:
 * 1) route selects shell_command,
 * 2) source guard explicitly allows shell execution,
 * 3) prompt passes command extraction validation.
 *
 * Any guard failure deterministically demotes dispatch to code_change.
 */
export function deriveRoutingCoercionAudit(
  resolvedRoute: TaskRouteResult,
  dispatch: SafeDispatchResolution,
): RoutingCoercionAudit | undefined {
  const finalRoute = dispatch.route;
  if (resolvedRoute.category === finalRoute.category) {
    return undefined;
  }

  const reason = finalRoute.reason ?? dispatch.shell.reason ?? 'Route was coerced to satisfy dispatch safety constraints.';
  const sourceGuardDemotion = resolvedRoute.category === 'shell_command'
    && finalRoute.category !== 'shell_command'
    && dispatch.shell.reason?.includes('source')
    ? true
    : false;
  const shellValidationDemotion = resolvedRoute.category === 'shell_command'
    && finalRoute.category !== 'shell_command'
    && !sourceGuardDemotion;

  return {
    coercionType: sourceGuardDemotion
      ? 'shell_source_guard_demotion'
      : shellValidationDemotion
        ? 'shell_prompt_validation_demotion'
        : 'route_mismatch',
    originalRoute: resolvedRoute.category,
    finalRoute: finalRoute.category,
    reason,
    risk: resolvedRoute.category === 'shell_command' || finalRoute.category === 'shell_command' ? 'high' : 'medium',
  };
}

export function enforceSafeShellDispatch(
  prompt: string,
  route: TaskRouteResult,
  source: 'user' | 'observer' | undefined,
): SafeDispatchResolution {
  if (route.category !== 'shell_command') {
    return {
      route,
      shell: { ok: false, reason: 'Route is not shell_command.' },
    };
  }

  const sourceValidation = validateShellDispatchSource(source);
  if (!sourceValidation.ok) {
    return {
      route: fallbackToCodeChangeRoute(route, `Shell dispatch blocked by source guard: ${sourceValidation.reason}`),
      shell: { ok: false, reason: sourceValidation.reason },
    };
  }

    const shell = validateShellExecutionPrompt(prompt);
  if (shell.ok) {
    return { route, shell };
  }

  const demotedRoute = fallbackToCodeChangeRoute(
    route,
    `Shell dispatch blocked by validation: ${shell.reason ?? 'prompt did not contain an executable command.'}`,
  );

  return {
    route: demotedRoute,
    shell,
  };
}

/**
 * Source-aware shell gate used as defense-in-depth at dispatch boundary.
 * Only explicit user-originated sessions may execute shell routes.
 */
export function validateShellDispatchSource(
  source: 'user' | 'observer' | undefined,
): ShellDispatchSourceValidation {
  if (source === 'user') {
    return { ok: true };
  }
  if (source === 'observer') {
    return {
      ok: false,
      reason: 'Rejected shell execution for source observer; observer prompts must route through planning pipeline.',
    };
  }
  return {
    ok: false,
    reason: 'Rejected shell execution because source is undefined; only source user is allowed.',
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
 * Canonical shell-input validator used by all shell execution entrypoints.
 * Accepts only single-line executable command text and rejects markdown/prose.
 *
 * Validation now also enforces a strict allowlist and returns a parsed argv
 * payload safe for direct `execFile(program, args)` execution without `sh -lc`.
 */
export function validateShellInput(input: string): ShellExecutionValidation {
  const normalized = input.trim();
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
  if (MARKDOWN_LIKE_PAYLOAD.test(normalized)) {
    return {
      ok: false,
      reason: 'Rejected shell execution: prompt appears to contain markdown/instructional content, not a direct command.',
    };
  }
  const command = extractShellCommand(normalized);
  if (!command) {
    return {
      ok: false,
      reason: 'Route shell_command selected, but no executable command was found in the prompt.',
    };
  }

  const parsed = parseShellCommandToArgv(command);
  if (!parsed.ok || !parsed.parsed) {
    return {
      ok: false,
      reason: parsed.reason ?? 'Rejected shell execution: command contains unsupported or unsafe shell syntax.',
    };
  }

  return { ok: true, command, parsed: parsed.parsed };
}


/**
 * Backward-compatible alias for existing call sites/tests.
 */
export function validateShellExecutionPrompt(prompt: string): ShellExecutionValidation {
  return validateShellInput(prompt);
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

function tokenizeCommandPreservingQuotes(command: string): { ok: boolean; tokens?: string[]; reason?: string } {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaping = false;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (quote === 'single') {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === 'double') {
      if (char === '"') {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'") {
      quote = 'single';
      continue;
    }

    if (char === '"') {
      quote = 'double';
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    return { ok: false, reason: 'Rejected shell execution: trailing escape character is not supported.' };
  }
  if (quote) {
    return { ok: false, reason: 'Rejected shell execution: unterminated quoted string.' };
  }
  if (current.length > 0) {
    tokens.push(current);
  }

  if (tokens.length === 0) {
    return { ok: false, reason: 'Rejected shell execution: empty command after parsing.' };
  }

  return { ok: true, tokens };
}

export function parseShellCommandToArgv(command: string): ShellExecutionValidation {
  const normalized = command.trim();
  if (!normalized) {
    return { ok: false, reason: 'Rejected shell execution: command is empty.' };
  }

  if (FORBIDDEN_SHELL_META_CHARS.test(normalized) || FORBIDDEN_SHELL_SUBSTITUTIONS.test(normalized)) {
    return {
      ok: false,
      reason: 'Rejected shell execution: shell operators, redirection, piping, or substitution syntax is not allowed.',
    };
  }

  const tokenized = tokenizeCommandPreservingQuotes(normalized);
  if (!tokenized.ok || !tokenized.tokens) {
    return {
      ok: false,
      reason: tokenized.reason ?? 'Rejected shell execution: unable to parse command safely.',
    };
  }

  const [program, ...args] = tokenized.tokens;
  const normalizedProgram = program.toLowerCase();
  if (!ALLOWED_SHELL_PROGRAMS_SET.has(normalizedProgram)) {
    return {
      ok: false,
      reason: `Rejected shell execution: command '${program}' is not in the allowed shell command list.`,
    };
  }

  return {
    ok: true,
    command: normalized,
    parsed: {
      program,
      args,
    },
  };
}

