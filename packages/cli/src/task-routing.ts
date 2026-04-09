import {
  classifyTaskPrompt,
  DEFAULT_CLI_SHELL_COMMAND_POLICY,
  extractShellCommand as extractShellCommandFromCore,
  parseShellCommandToArgv as parseShellCommandToArgvFromCore,
  validateShellInput as validateShellInputFromCore,
  type TaskRouteCategory,
  type TaskRouteResult,
} from '@orchestrace/core';
import type {
  ParsedShellCommand,
  ShellExecutionValidation,
  TaskType,
} from '@orchestrace/core';




const RETRY_CONTINUATION_MARKER = 'Retry continuation context from previous attempt:';
const FOLLOW_UP_MARKER = 'Follow-up request:';

export interface ResolvedRoute {
  result: TaskRouteResult;
  nodeType: TaskType;
  validationEnabled: boolean;
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
  return validateShellInputFromCore(input, DEFAULT_CLI_SHELL_COMMAND_POLICY);
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
  return extractShellCommandFromCore(prompt, DEFAULT_CLI_SHELL_COMMAND_POLICY);
}


export function parseShellCommandToArgv(command: string): ShellExecutionValidation {
  return parseShellCommandToArgvFromCore(command, DEFAULT_CLI_SHELL_COMMAND_POLICY);
}


