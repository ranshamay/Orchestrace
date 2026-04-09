import { classifyTaskPrompt, type TaskRouteCategory, type TaskRouteResult } from '@orchestrace/core';
import type { TaskType } from '@orchestrace/core';

type ProgramArgValidator = (args: string[]) => string | undefined;

const SAFE_PACKAGE_MANAGER_SCRIPTS = new Set(['test', 'lint', 'typecheck', 'build']);
const SAFE_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'remote']);
const DISALLOWED_GIT_SUBCOMMANDS = new Set([
  'add',
  'commit',
  'push',
  'pull',
  'merge',
  'rebase',
  'reset',
  'clean',
  'checkout',
  'switch',
  'stash',
  'worktree',
  'clone',
  'config',
  'init',
]);

const FORBIDDEN_SHELL_META_CHARS = /[;&|<>`]/;
const FORBIDDEN_SHELL_SUBSTITUTIONS = /(\$\(|\$\{|\$\(\()/;
const FORBIDDEN_SHELL_CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const FORBIDDEN_SHELL_LINE_BREAKS = /[\r\n]/;
const FORBIDDEN_ARG_PATTERNS = [
  /(^|\/)\.\.(\/|$)/,
  /^-/,
  /^(?:https?|ssh|file):\/\//i,
];
const MARKDOWN_LIKE_PAYLOAD = /(^\s*\[[^\]]+\])|(^\s*#{1,6}\s+\S)|(```)|(^\s*(?:Category|Severity|Issue|Task):\s)/im;

const SHELL_COMMAND_POLICY: Record<string, ProgramArgValidator> = {
  git: validateGitArgs,
  pnpm: (args) => validatePackageManagerArgs('pnpm', args),
  npm: (args) => validatePackageManagerArgs('npm', args),
  yarn: (args) => validatePackageManagerArgs('yarn', args),
  ls: validateLsArgs,
  pwd: validatePwdArgs,
  cat: validateCatArgs,
  grep: validateGrepArgs,
  find: validateFindArgs,
  echo: () => undefined,
};

const ALLOWED_SHELL_PROGRAMS = Object.keys(SHELL_COMMAND_POLICY);
const ALLOWED_SHELL_PROGRAMS_SET = new Set<string>(ALLOWED_SHELL_PROGRAMS);
const SHELL_COMMAND_START = new RegExp(`^(${ALLOWED_SHELL_PROGRAMS.map(escapeRegexLiteral).join('|')})(?:\\s|$)`, 'i');

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

const DEFAULT_SHELL_VALIDATION_FAILURE_REASON = 'input did not pass centralized validation';

export function formatShellValidationRejection(entrypoint: string, reason?: string): string {
  return `[shell-guard] rejected shell execution at ${entrypoint}: ${reason ?? DEFAULT_SHELL_VALIDATION_FAILURE_REASON}`;
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

  const shell = validateShellInput(prompt);
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

export function validateShellInput(input: string): ShellExecutionValidation {
  const normalized = input.trim();
  if (!normalized) {
    return {
      ok: false,
      reason: 'Route shell_command selected, but prompt was empty.',
    };
  }

  if (FORBIDDEN_SHELL_LINE_BREAKS.test(normalized)) {
    return {
      ok: false,
      reason: 'Rejected shell execution: prompt contains multiple lines and appears to be instructions/markdown, not a single command.',
    };
  }

  if (FORBIDDEN_SHELL_CONTROL_CHARS.test(normalized)) {
    return {
      ok: false,
      reason: 'Rejected shell execution: prompt contains control characters that are not allowed.',
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

export function validateShellExecutionPrompt(prompt: string): ShellExecutionValidation {
  return validateShellInput(prompt);
}

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
  if (FORBIDDEN_SHELL_LINE_BREAKS.test(normalized) || FORBIDDEN_SHELL_CONTROL_CHARS.test(normalized) || normalized.length > 200) {
    return undefined;
  }

  const command = normalized
    .replace(/^\$\s*/, '')
    .replace(/^(run|execute|exec|shell|command|cmd)\s+/i, '')
    .trim();
  if (!command) return undefined;
  if (!SHELL_COMMAND_START.test(command)) return undefined;
  return command;
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

  if (FORBIDDEN_SHELL_LINE_BREAKS.test(normalized) || FORBIDDEN_SHELL_CONTROL_CHARS.test(normalized)) {
    return {
      ok: false,
      reason: 'Rejected shell execution: control characters and line breaks are not allowed.',
    };
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

  const argValidator = SHELL_COMMAND_POLICY[normalizedProgram];
  const argValidationError = argValidator?.(args);
  if (argValidationError) {
    return {
      ok: false,
      reason: `Rejected shell execution: ${argValidationError}`,
    };
  }

  return {
    ok: true,
    command: normalized,
    parsed: {
      program: normalizedProgram,
      args,
    },
  };
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validatePackageManagerArgs(program: 'pnpm' | 'npm' | 'yarn', args: string[]): string | undefined {
  if (args.length === 0) {
    return `command '${program}' requires an explicit safe script (allowed: ${[...SAFE_PACKAGE_MANAGER_SCRIPTS].join(', ')}).`;
  }

  if (args.some((arg) => arg.startsWith('-'))) {
    return `command '${program}' does not allow arbitrary flags from prompt input.`;
  }

  const [head, ...rest] = args;
  const normalizedHead = head.toLowerCase();

  if (program === 'npm') {
    if (normalizedHead !== 'run' || rest.length !== 1) {
      return `command 'npm' only allows 'npm run <script>' for safe scripts (${[...SAFE_PACKAGE_MANAGER_SCRIPTS].join(', ')}).`;
    }
    if (!SAFE_PACKAGE_MANAGER_SCRIPTS.has(rest[0].toLowerCase())) {
      return `npm script '${rest[0]}' is not in the allowlist (${[...SAFE_PACKAGE_MANAGER_SCRIPTS].join(', ')}).`;
    }
    return undefined;
  }

  if (program === 'yarn') {
    if (rest.length !== 0 && !(normalizedHead === 'run' && rest.length === 1)) {
      return `command 'yarn' only allows 'yarn <script>' or 'yarn run <script>' for safe scripts (${[...SAFE_PACKAGE_MANAGER_SCRIPTS].join(', ')}).`;
    }
    const script = normalizedHead === 'run' ? rest[0] : head;
    if (!script || !SAFE_PACKAGE_MANAGER_SCRIPTS.has(script.toLowerCase())) {
      return `yarn script '${script ?? '<missing>'}' is not in the allowlist (${[...SAFE_PACKAGE_MANAGER_SCRIPTS].join(', ')}).`;
    }
    return undefined;
  }

  if (normalizedHead !== 'run' || rest.length !== 1) {
    return `command 'pnpm' only allows 'pnpm run <script>' for safe scripts (${[...SAFE_PACKAGE_MANAGER_SCRIPTS].join(', ')}).`;
  }
  if (!SAFE_PACKAGE_MANAGER_SCRIPTS.has(rest[0].toLowerCase())) {
    return `pnpm script '${rest[0]}' is not in the allowlist (${[...SAFE_PACKAGE_MANAGER_SCRIPTS].join(', ')}).`;
  }
  return undefined;
}

function validateGitArgs(args: string[]): string | undefined {
  if (args.length === 0) {
    return "command 'git' requires an explicit read-only subcommand.";
  }

  const [subcommand, ...rest] = args;
  const normalizedSubcommand = subcommand.toLowerCase();
  if (DISALLOWED_GIT_SUBCOMMANDS.has(normalizedSubcommand)) {
    return `git subcommand '${subcommand}' is explicitly blocked for shell route execution.`;
  }
  if (!SAFE_GIT_SUBCOMMANDS.has(normalizedSubcommand)) {
    return `git subcommand '${subcommand}' is not in the allowlist (${[...SAFE_GIT_SUBCOMMANDS].join(', ')}).`;
  }
  if (rest.some((arg) => arg.startsWith('-'))) {
    return `git subcommand '${subcommand}' does not allow arbitrary flags from prompt input.`;
  }
  if (rest.some((arg) => !isSafePathLikeToken(arg))) {
    return `git subcommand '${subcommand}' includes path or token '${rest.find((arg) => !isSafePathLikeToken(arg))}' outside the allowlist.`;
  }
  return undefined;
}

function validatePwdArgs(args: string[]): string | undefined {
  if (args.length > 0) {
    return "command 'pwd' does not allow arguments.";
  }
  return undefined;
}

function validateLsArgs(args: string[]): string | undefined {
  if (args.some((arg) => arg.startsWith('-'))) {
    return "command 'ls' does not allow flags from prompt input.";
  }
  if (args.some((arg) => !isSafePathLikeToken(arg))) {
    return `command 'ls' includes disallowed path token '${args.find((arg) => !isSafePathLikeToken(arg))}'.`;
  }
  return undefined;
}

function validateCatArgs(args: string[]): string | undefined {
  if (args.length === 0) {
    return "command 'cat' requires at least one relative file path.";
  }
  if (args.some((arg) => !isSafePathLikeToken(arg))) {
    return `command 'cat' includes disallowed path token '${args.find((arg) => !isSafePathLikeToken(arg))}'.`;
  }
  return undefined;
}

function validateGrepArgs(args: string[]): string | undefined {
  if (args.length < 1) {
    return "command 'grep' requires a pattern argument.";
  }
  if (args.some((arg) => arg.startsWith('-'))) {
    return "command 'grep' does not allow arbitrary flags from prompt input.";
  }
  const [pattern, ...paths] = args;
  if (pattern.length > 200) {
    return "command 'grep' pattern exceeds maximum length (200 characters).";
  }
  if (paths.some((arg) => !isSafePathLikeToken(arg))) {
    return `command 'grep' includes disallowed path token '${paths.find((arg) => !isSafePathLikeToken(arg))}'.`;
  }
  return undefined;
}

function validateFindArgs(args: string[]): string | undefined {
  if (args.length > 2) {
    return "command 'find' allows at most two arguments (<path> <name-pattern>).";
  }
  if (args.some((arg) => arg.startsWith('-'))) {
    return "command 'find' does not allow flags or predicates from prompt input.";
  }
  if (args.some((arg) => !isSafePathLikeToken(arg))) {
    return `command 'find' includes disallowed path token '${args.find((arg) => !isSafePathLikeToken(arg))}'.`;
  }
  return undefined;
}

function isSafePathLikeToken(value: string): boolean {
  if (!value) {
    return false;
  }
  if (FORBIDDEN_ARG_PATTERNS.some((pattern) => pattern.test(value))) {
    return false;
  }
  return /^[a-zA-Z0-9_./:@%+,=~*-]+$/.test(value);
}