import { normalize as normalizePosixPath } from 'node:path/posix';

import {
  validateToolCall,
  type AssistantMessage,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from '@mariozechner/pi-ai';
import type { LlmCompletionOptions, LlmToolset } from '../types.js';

import { consumeStream, getUsage } from './stream.js';
import { formatToolPayload, toErrorMessage } from './utils.js';
import { createTimeoutSignal } from './timeout.js';

const MAX_TOOL_ROUNDS = resolveMaxToolRounds();
const SUBAGENT_BATCH_RETRY_MAX_ATTEMPTS = resolveSubagentBatchRetryMaxAttempts();
const ACKNOWLEDGMENT_READ_AFTER_WRITE_ESCALATION_THRESHOLD = 2;

const SUFFICIENT_CONTEXT_ACK_PATTERNS: RegExp[] = [
  /\benough\s+(?:source\s+)?context\b/i,
  /\bsufficient\s+context\b/i,
  /\bmapped\s+all\s+touchpoints\b/i,
  /\bconfirmed\s+(?:ui[-\s]?server\s+)?wiring\b/i,
  /\b(i\s+have\s+)?all\s+the\s+context\s+i\s+need\b/i,
];


export async function executeWithOptionalTools(params: {
  model: ReturnType<typeof import('@mariozechner/pi-ai').getModel>;
  context: import('@mariozechner/pi-ai').Context;
  options: Record<string, unknown>;
  completionOptions?: LlmCompletionOptions;
  toolset?: LlmToolset;
  signal?: AbortSignal;
  timeoutMs?: number;
  onUsage: (usage: { input: number; output: number; cost: number }) => void;
}): Promise<AssistantMessage> {
  const {
    model,
    context,
    options,
    completionOptions,
    toolset,
    signal,
    timeoutMs,
    onUsage,
  } = params;

    let round = 0;
  let previousRoundHadToolError = false;
  let toolErrorRecoveryAttempts = 0;
  let writeRequiredNext = false;
  let readAfterAcknowledgmentViolations = 0;

  for (;;) {
    round += 1;
    if (MAX_TOOL_ROUNDS !== undefined && round > MAX_TOOL_ROUNDS) {
      throw new Error(`Model exceeded ${MAX_TOOL_ROUNDS} tool rounds without producing a final response.`);
    }

    const response = await consumeStreamWithTimeout(model, context, options, completionOptions, signal, timeoutMs);
    onUsage(getUsage(response));

    if (!toolset) {
      return response;
    }

    if (
      previousRoundHadToolError
      && (response.stopReason === 'error' || response.stopReason === 'aborted')
      && toolErrorRecoveryAttempts < 2
    ) {
      context.messages.push(response);
      const reason = response.errorMessage?.trim()
        ? response.errorMessage.trim()
        : `Model stopped with reason "${response.stopReason}" after a tool failure.`;
      context.messages.push({
        role: 'user',
        content: [{
          type: 'text',
          text:
            `Tool execution failed in the previous turn. Reason: ${reason}\n`
            + 'Do not stop. Inspect the failed tool result, correct the arguments, and retry the needed tool call(s).',
        }],
        timestamp: Date.now(),
      });
      previousRoundHadToolError = false;
      toolErrorRecoveryAttempts += 1;
      continue;
    }

    toolErrorRecoveryAttempts = 0;

        const acknowledgedSufficientContext = hasSufficientContextAcknowledgment(response);
    if (acknowledgedSufficientContext) {
      writeRequiredNext = true;
    }

    const toolCalls = getToolCalls(response);
    if (toolCalls.length === 0) {
      return response;
    }

    context.messages.push(response);
    const { results: toolResults, retryPrompts, hadErrors, writeRequirementSatisfied, readAfterAckViolation } = await executeToolCalls(
      toolset,
      context.tools ?? [],
      toolCalls,
      signal,
      completionOptions,
      writeRequiredNext,
    );
    if (writeRequirementSatisfied) {
      writeRequiredNext = false;
      readAfterAcknowledgmentViolations = 0;
    } else if (readAfterAckViolation) {
      readAfterAcknowledgmentViolations += 1;
      if (readAfterAcknowledgmentViolations >= ACKNOWLEDGMENT_READ_AFTER_WRITE_ESCALATION_THRESHOLD) {
        retryPrompts.unshift(
          `System escalation: repeated read-after-acknowledgment violations (${readAfterAcknowledgmentViolations}). `
          + 'You already acknowledged sufficient context. The very next tool call must be write_file with concrete content.',
        );
      }
    }

    context.messages.push(...toolResults);
    for (const retryPrompt of retryPrompts) {
      context.messages.push({
        role: 'user',
        content: [{
          type: 'text',
          text: retryPrompt,
        }],
        timestamp: Date.now(),
      });
    }
    previousRoundHadToolError = hadErrors;
  }
}

function resolveMaxToolRounds(): number | undefined {
  const raw = process.env.ORCHESTRACE_MAX_TOOL_ROUNDS;
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return undefined;
  }

  return parsed;
}

function resolveSubagentBatchRetryMaxAttempts(): number {
  const defaultAttempts = 2;
  const raw = process.env.ORCHESTRACE_SUBAGENT_BATCH_RETRY_MAX_ATTEMPTS;
  if (!raw) {
    return defaultAttempts;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return defaultAttempts;
  }

  return parsed;
}

async function executeToolCalls(
  toolset: LlmToolset,
  tools: Tool[],
  toolCalls: ToolCall[],
  signal?: AbortSignal,
  completionOptions?: LlmCompletionOptions,
  writeRequiredNext = false,
): Promise<{
  results: ToolResultMessage[];
  retryPrompts: string[];
  hadErrors: boolean;
  writeRequirementSatisfied: boolean;
  readAfterAckViolation: boolean;
}> {
  const results: ToolResultMessage[] = [];
  const retryPrompts: string[] = [];
  let hadErrors = false;
  let writeRequirementSatisfied = false;
  let readAfterAckViolation = false;


  for (const toolCall of toolCalls) {
    let payload: { content: string; isError: boolean; details?: unknown };
    let validatedArgs: Record<string, unknown> | undefined;

        completionOptions?.onToolCall?.({
      type: 'started',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      arguments: formatToolPayload(toolCall.arguments),
    });

    if (writeRequiredNext && toolCall.name !== 'write_file') {
      readAfterAckViolation = true;
      payload = {
        content: buildAcknowledgmentWriteGuardViolationMessage(toolCall),
        isError: true,
      };
      completionOptions?.onToolCall?.({
        type: 'result',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        arguments: formatToolPayload(toolCall.arguments),
        result: formatToolPayload(payload.content),
        isError: true,
        details: payload.details,
      });
      hadErrors = true;
      results.push({
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: payload.content }],
        details: payload.details,
        isError: payload.isError,
        timestamp: Date.now(),
      });
      retryPrompts.push(payload.content);
      continue;
    }

    if (writeRequiredNext && toolCall.name === 'write_file') {
      writeRequirementSatisfied = true;
      writeRequiredNext = false;
    }

    try {

      coerceStringifiedArrayArgs(toolCall);
      validatedArgs = validateToolCall(tools, toolCall) as Record<string, unknown>;
            const toolResult = await executeToolWithEditFilesDedup({
        toolset,
        toolCall,
        arguments: validatedArgs,
        signal,
      });


      payload = {
        content: toolResult.content,
        isError: toolResult.isError ?? false,
        details: toolResult.details,
      };

      completionOptions?.onToolCall?.({
        type: 'result',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        arguments: formatToolPayload(toolCall.arguments),
        result: formatToolPayload(toolResult.content),
        isError: toolResult.isError ?? false,
        details: toolResult.details,
      });
    } catch (error) {
      payload = {
        content:
          `Tool execution failed: ${toErrorMessage(error)}\n`
          + 'Inspect the error, correct the arguments, and retry this tool call.',
        isError: true,
      };

      completionOptions?.onToolCall?.({
        type: 'result',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        arguments: formatToolPayload(toolCall.arguments),
        result: formatToolPayload(payload.content),
        isError: true,
        details: payload.details,
      });
    }

    hadErrors = hadErrors || payload.isError;

    results.push({
      role: 'toolResult',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: 'text', text: payload.content }],
      details: payload.details,
      isError: payload.isError,
      timestamp: Date.now(),
    });

    if (payload.isError) {
      if (toolCall.name === 'subagent_spawn_batch') {
        retryPrompts.push(buildSubagentBatchRetryMessage(toolCall, payload.content));
      } else {
        retryPrompts.push(buildToolCallRetryMessage(toolCall, payload.content));
      }
    }
  }

    return {
    results,
    retryPrompts,
    hadErrors,
    writeRequirementSatisfied,
    readAfterAckViolation,
  };
}



type ToolExecutionPayload = {
  content: string;
  isError?: boolean;
  details?: unknown;
};

type ParsedSubagentBatchFailure = {
  failedNodeIds: string[];
  runs: Array<{ status?: string; nodeId?: string; id?: string; error?: string }>;
};

const SUBAGENT_RETRY_CONTEXT_LINE_PREFIX = 'Retry context:';
const SUBAGENT_RETRY_CONTEXT_MAX_ERROR_CHARS = 240;
const SUBAGENT_RETRY_CONTEXT_MAX_LINE_CHARS = 360;
const SUBAGENT_BATCH_IDENTICAL_FAILURE_CAP = 2;
const SUBAGENT_BATCH_RETRY_BASE_DELAY_MS = 200;

async function executeToolWithEditFilesDedup(params: {
  toolset: LlmToolset;
  toolCall: ToolCall;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<ToolExecutionPayload> {
  const { toolset, toolCall, arguments: toolArgs, signal } = params;

  if (toolCall.name !== 'edit_files') {
    return executeToolWithSubagentBatchRetry(params);
  }

  const editFiles = getEditFileEntries(toolArgs.files);
  if (editFiles.length === 0 || !hasDuplicateEditPaths(editFiles)) {
    return executeToolWithSubagentBatchRetry(params);
  }

  return executeDedupedEditFilesBatch({
    toolset,
    toolCall,
    toolArgs,
    editFiles,
    signal,
  });
}

function getEditFileEntries(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .filter((entry) => typeof entry.path === 'string' && entry.path.trim().length > 0);
}

function hasDuplicateEditPaths(editFiles: Array<Record<string, unknown>>): boolean {
  const seen = new Set<string>();
  for (const edit of editFiles) {
    const key = toCanonicalEditPathKey(edit.path);
    if (seen.has(key)) {
      return true;
    }
    seen.add(key);
  }

  return false;
}

function toCanonicalEditPathKey(pathValue: unknown): string {
  const rawPath = typeof pathValue === 'string' ? pathValue : String(pathValue ?? '');
  const normalized = normalizePosixPath(rawPath.trim());
  return normalized === '.' ? '' : normalized;
}


async function executeDedupedEditFilesBatch(params: {
  toolset: LlmToolset;
  toolCall: ToolCall;
  toolArgs: Record<string, unknown>;
  editFiles: Array<Record<string, unknown>>;
  signal?: AbortSignal;
}): Promise<ToolExecutionPayload> {
  const { toolset, toolCall, toolArgs, editFiles, signal } = params;

  const aggregateFiles: unknown[] = [];
  const aggregateDetails: unknown[] = [];
  let total = 0;
  let successes = 0;
  let failures = 0;
  let hadError = false;

  for (const edit of editFiles) {
    const perFileArgs: Record<string, unknown> = {
      ...toolArgs,
      files: [edit],
    };

    const result = await executeToolWithSubagentBatchRetry({
      toolset,
      toolCall,
      arguments: perFileArgs,
      signal,
    });

    hadError = hadError || (result.isError ?? false);
    if (result.details !== undefined) {
      aggregateDetails.push(result.details);
    }

    const parsed = parseEditFilesBatchResult(result.content);
    if (parsed) {
      total += parsed.total;
      successes += parsed.successes;
      failures += parsed.failures;
      if (Array.isArray(parsed.files)) {
        aggregateFiles.push(...parsed.files);
      }
    } else {
      total += 1;
      if (result.isError ?? false) {
        failures += 1;
      } else {
        successes += 1;
      }
      aggregateFiles.push({
        path: typeof edit.path === 'string' ? edit.path : 'unknown',
        ok: !(result.isError ?? false),
        error: result.isError ? result.content : undefined,
      });
    }
  }

  const payload = {
    total,
    successes,
    failures,
    files: aggregateFiles,
  };

  return {
    content: JSON.stringify(payload, null, 2),
    isError: hadError,
    details: aggregateDetails.length > 0 ? { splitBatch: true, results: aggregateDetails } : { splitBatch: true },
  };
}

function parseEditFilesBatchResult(content: string): {
  total: number;
  successes: number;
  failures: number;
  files: unknown[];
} | undefined {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const files = Array.isArray(parsed.files) ? parsed.files : [];
    const total = typeof parsed.total === 'number' ? parsed.total : files.length;
    const successes = typeof parsed.successes === 'number'
      ? parsed.successes
      : files.filter((entry) => getRecord(entry)?.ok === true).length;
    const failures = typeof parsed.failures === 'number'
      ? parsed.failures
      : Math.max(total - successes, 0);

    return {
      total,
      successes,
      failures,
      files,
    };
  } catch {
    return undefined;
  }
}

async function executeToolWithSubagentBatchRetry(params: {

  toolset: LlmToolset;
  toolCall: ToolCall;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<ToolExecutionPayload> {
  const { toolset, toolCall, arguments: toolArgs, signal } = params;

  const first = await toolset.executeTool(
    {
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolArgs,
    },
    signal,
  );

  if (toolCall.name !== 'subagent_spawn_batch' || !(first.isError ?? false)) {
    return first;
  }

  const originalAgents = getSubagentBatchAgents(toolArgs);
  if (originalAgents.length === 0) {
    return first;
  }

  let attempt = 0;
  let latest = first;
  let previousFailureSignature = buildSubagentBatchFailureSignature(parseSubagentBatchFailure(latest.content));
  let consecutiveIdenticalFailures = 1;

  while (attempt < SUBAGENT_BATCH_RETRY_MAX_ATTEMPTS) {
    const parsedFailure = parseSubagentBatchFailure(latest.content);
    if (parsedFailure.failedNodeIds.length === 0) {
      return latest;
    }

    if (consecutiveIdenticalFailures > SUBAGENT_BATCH_IDENTICAL_FAILURE_CAP) {
      return buildSubagentBatchCircuitBreakerResult({
        latestFailure: latest,
        parsedFailure,
        consecutiveIdenticalFailures,
      });
    }

    const retryAgents = buildFailedSubagentRetryAgents(
      originalAgents,
      parsedFailure.failedNodeIds,
      parsedFailure.runs,
    );
    if (retryAgents.length === 0) {
      return latest;
    }

    const retryArgs = {
      ...toolArgs,
      agents: retryAgents,
    };

    await sleepWithSignal(SUBAGENT_BATCH_RETRY_BASE_DELAY_MS * (2 ** attempt), signal);
    attempt += 1;
    latest = await toolset.executeTool(
      {
        id: toolCall.id,
        name: toolCall.name,
        arguments: retryArgs,
      },
      signal,
    );

    if (!(latest.isError ?? false)) {
      return latest;
    }

    const nextParsedFailure = parseSubagentBatchFailure(latest.content);
    const nextFailureSignature = buildSubagentBatchFailureSignature(nextParsedFailure);
    if (nextFailureSignature === previousFailureSignature) {
      consecutiveIdenticalFailures += 1;
    } else {
      previousFailureSignature = nextFailureSignature;
      consecutiveIdenticalFailures = 1;
    }

    if (consecutiveIdenticalFailures > SUBAGENT_BATCH_IDENTICAL_FAILURE_CAP) {
      return buildSubagentBatchCircuitBreakerResult({
        latestFailure: latest,
        parsedFailure: nextParsedFailure,
        consecutiveIdenticalFailures,
      });
    }
  }

  return buildSubagentBatchFallbackResult(latest, originalAgents);
}

function getSubagentBatchAgents(args: Record<string, unknown>): Array<Record<string, unknown>> {
  const agentsRaw = args.agents;
  if (!Array.isArray(agentsRaw)) {
    return [];
  }

  return agentsRaw.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object');
}

function parseSubagentBatchFailure(content: string): ParsedSubagentBatchFailure {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const failedNodeIds = normalizeStringArray(parsed.failedNodeIds);
    const runs = Array.isArray(parsed.runs)
      ? parsed.runs
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
        .map((entry) => ({
          status: typeof entry.status === 'string' ? entry.status : undefined,
          nodeId: typeof entry.nodeId === 'string' ? entry.nodeId : undefined,
          id: typeof entry.id === 'string' ? entry.id : undefined,
          error: typeof entry.error === 'string' ? entry.error : undefined,
        }))
      : [];

    if (failedNodeIds.length > 0) {
      return { failedNodeIds: dedupeStrings(failedNodeIds), runs };
    }

    const derivedFailedNodeIds = runs
      .filter((run) => run.status === 'failed')
      .map((run) => run.nodeId ?? run.id)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);

    return {
      failedNodeIds: dedupeStrings(derivedFailedNodeIds),
      runs,
    };
  } catch {
    return { failedNodeIds: [], runs: [] };
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function buildSubagentBatchFailureSignature(parsedFailure: ParsedSubagentBatchFailure): string {
  const failedNodeIds = [...parsedFailure.failedNodeIds].sort();
  const failedRunErrors = parsedFailure.runs
    .filter((run) => run.status === 'failed')
    .map((run) => {
      const nodeRef = run.nodeId ?? run.id ?? 'unknown-node';
      const normalizedError = sanitizeInline(run.error, SUBAGENT_RETRY_CONTEXT_MAX_ERROR_CHARS) ?? 'unknown-error';
      return `${nodeRef}:${normalizedError}`;
    })
    .sort();

  return JSON.stringify({ failedNodeIds, failedRunErrors });
}

function buildFailedSubagentRetryAgents(
  originalAgents: Array<Record<string, unknown>>,
  failedNodeIds: string[],
  runs: Array<{ status?: string; nodeId?: string; id?: string; error?: string }>,
): Array<Record<string, unknown>> {
  const failedSet = new Set(failedNodeIds);
  const runErrorsByNodeId = buildRunErrorsByNodeId(runs);

  return originalAgents
    .filter((agent) => {
      const nodeId = typeof agent.nodeId === 'string' ? agent.nodeId : undefined;
      return nodeId ? failedSet.has(nodeId) : false;
    })
    .map((agent) => {
      const nodeId = typeof agent.nodeId === 'string' ? agent.nodeId : undefined;
      if (!nodeId) {
        return agent;
      }

      const retryContextLine = buildSubagentRetryContextLine(nodeId, runErrorsByNodeId.get(nodeId));
      if (!retryContextLine) {
        return agent;
      }

      const contextPacket = getRecord(agent.contextPacket);
      const existingRelevantContext = getStringArray(contextPacket?.relevantContext);
      const relevantContext = [
        ...existingRelevantContext.filter((entry) => !entry.startsWith(SUBAGENT_RETRY_CONTEXT_LINE_PREFIX)),
        retryContextLine,
      ];

      return {
        ...agent,
        contextPacket: {
          ...(contextPacket ?? {}),
          relevantContext,
        },
      };
    });
}

function buildRunErrorsByNodeId(
  runs: Array<{ status?: string; nodeId?: string; id?: string; error?: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const run of runs) {
    if (run.status !== 'failed') {
      continue;
    }

    const nodeId = run.nodeId ?? run.id;
    if (!nodeId || map.has(nodeId)) {
      continue;
    }

    if (typeof run.error === 'string' && run.error.trim().length > 0) {
      map.set(nodeId, run.error);
    }
  }

  return map;
}

function buildSubagentRetryContextLine(nodeId: string, runError: string | undefined): string {
  const base = `${SUBAGENT_RETRY_CONTEXT_LINE_PREFIX} prior sub-agent attempt failed for node "${nodeId}".`;
  const cleanError = sanitizeInline(runError, SUBAGENT_RETRY_CONTEXT_MAX_ERROR_CHARS);
  if (!cleanError) {
    return truncateWithEllipsis(base, SUBAGENT_RETRY_CONTEXT_MAX_LINE_CHARS);
  }

  const withError = `${base} Last error: ${cleanError}`;
  return truncateWithEllipsis(withError, SUBAGENT_RETRY_CONTEXT_MAX_LINE_CHARS);
}

function sanitizeInline(value: string | undefined, maxChars: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    return undefined;
  }

  return truncateWithEllipsis(normalized, maxChars);
}

function truncateWithEllipsis(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  if (maxChars <= 1) {
    return value.slice(0, maxChars);
  }

  return `${value.slice(0, maxChars - 1)}…`;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function buildSubagentBatchRetryMessage(toolCall: ToolCall, errorContent: string): string {
  const parsed = parseSubagentBatchFailure(errorContent);
  const suffix = parsed.failedNodeIds.length > 0
    ? `Failed nodeIds: ${parsed.failedNodeIds.join(', ')}.`
    : 'Unable to parse failed nodeIds from batch result.';

  return [
    `Tool call ${toolCall.name} (${toolCall.id}) failed.`,
    errorContent,
    suffix,
    'Retry subagent_spawn_batch once for all failed nodes together as a single batch request.',
  ].join('\n');
}

function buildSubagentBatchCircuitBreakerResult(params: {
  latestFailure: ToolExecutionPayload;
  parsedFailure: ParsedSubagentBatchFailure;
  consecutiveIdenticalFailures: number;
}): ToolExecutionPayload {
  const failedNodeIds = params.parsedFailure.failedNodeIds;
  const payload = {
    status: 'escalated_error',
    reason: 'identical_subagent_batch_failures_repeated',
    retryCap: SUBAGENT_BATCH_RETRY_MAX_ATTEMPTS,
    identicalFailureCap: SUBAGENT_BATCH_IDENTICAL_FAILURE_CAP,
    consecutiveIdenticalFailures: params.consecutiveIdenticalFailures,
    failedNodeIds,
    actionRequired: 'manual_intervention_or_backoff_before_retry',
    message: 'Circuit breaker tripped: identical subagent batch failures repeated more than twice consecutively. Halting further automatic batch retries.',
    lastFailure: params.latestFailure.content,
  };

  return {
    content: JSON.stringify(payload, null, 2),
    isError: true,
    details: {
      circuitBreaker: true,
      reason: payload.reason,
      failedNodeIds,
      consecutiveIdenticalFailures: params.consecutiveIdenticalFailures,
      identicalFailureCap: SUBAGENT_BATCH_IDENTICAL_FAILURE_CAP,
    },
  };
}

function buildSubagentBatchFallbackResult(
  latestFailure: ToolExecutionPayload,
  originalAgents: Array<Record<string, unknown>>,
): ToolExecutionPayload {
  const parsedFailure = parseSubagentBatchFailure(latestFailure.content);
  const failedNodes = parsedFailure.failedNodeIds.length > 0
    ? parsedFailure.failedNodeIds
    : originalAgents
      .map((agent) => (typeof agent.nodeId === 'string' ? agent.nodeId : undefined))
      .filter((value): value is string => Boolean(value));

  const critical: string[] = [];
  const nonCritical: string[] = [];

  for (const nodeId of failedNodes) {
    if (isNonCriticalResearchNode(nodeId)) {
      nonCritical.push(nodeId);
    } else {
      critical.push(nodeId);
    }
  }

  const fallback = {
    status: 'fallback',
    retryCap: SUBAGENT_BATCH_RETRY_MAX_ATTEMPTS,
    failedNodeIds: failedNodes,
    critical,
    nonCritical,
    inlineInstructions: critical.length > 0
      ? 'Inline fallback required for critical nodes: continue by completing these nodes directly in the parent agent response and clearly mark degraded confidence.'
      : undefined,
    skippedNodes: nonCritical,
    warning: nonCritical.length > 0
      ? 'Skipped non-critical research nodes after retry exhaustion.'
      : undefined,
    lastFailure: latestFailure.content,
  };

  return {
    content: JSON.stringify(fallback, null, 2),
    isError: critical.length > 0,
    details: {
      fallback: true,
      critical,
      nonCritical,
      retryCap: SUBAGENT_BATCH_RETRY_MAX_ATTEMPTS,
    },
  };
}

function isNonCriticalResearchNode(nodeId: string): boolean {
  const normalized = nodeId.toLowerCase();
  return normalized.includes('research') || normalized.includes('investigat') || normalized.includes('context');
}

async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('Operation aborted while waiting to retry subagent batch.'));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function buildToolCallRetryMessage(toolCall: ToolCall, errorContent: string): string {

  const deterministicEditFailure = isDeterministicEditValidationFailure(toolCall.name, errorContent);
  const remediationLine = deterministicEditFailure
    ? 'This failure is deterministic. Revise the edit plan/arguments (or skip this edit) before issuing another edit tool call.'
    : 'Correct the arguments using this error and retry this tool call.';

  return [
    `Tool call ${toolCall.name} (${toolCall.id}) failed.`,
    errorContent,
    remediationLine,
  ].join('\n');
}

function buildAcknowledgmentWriteGuardViolationMessage(toolCall: ToolCall): string {
  return [
    `Tool call ${toolCall.name} (${toolCall.id}) blocked by system guardrail.`,
    'You acknowledged that context is sufficient, so the immediate next tool call must be write_file.',
    'Call write_file next with concrete content before any additional read/search/list tool calls.',
  ].join('\n');
}

function hasSufficientContextAcknowledgment(message: AssistantMessage): boolean {
  for (const block of message.content) {
    if (block.type !== 'text') {
      continue;
    }

    const text = typeof block.text === 'string' ? block.text : '';
    if (!text.trim()) {
      continue;
    }

    if (SUFFICIENT_CONTEXT_ACK_PATTERNS.some((pattern) => pattern.test(text))) {
      return true;
    }
  }

  return false;
}

function isDeterministicEditValidationFailure(toolName: string, errorContent: string): boolean {

  if (toolName !== 'edit_file' && toolName !== 'edit_files') {
    return false;
  }

  const normalized = errorContent.toLowerCase();
    return normalized.includes('missing newtext')
    || normalized.includes('no-op edit is not allowed')
    || normalized.includes('duplicate paths are not allowed');

}

function getToolCalls(message: AssistantMessage): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const block of message.content) {
    if (block.type === 'toolCall') {
      calls.push(block);
    }
  }

  return calls;
}

/**
 * LLMs sometimes emit array arguments as JSON strings (e.g. `"[{...}]"` instead of `[{...}]`).
 * Detect and coerce these before schema validation to avoid preventable failures.
 */
function coerceStringifiedArrayArgs(toolCall: ToolCall): void {
  const args = toolCall.arguments;
  if (!args || typeof args !== 'object') return;

  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        (args as Record<string, unknown>)[key] = parsed;
      }
    } catch {
      // Not valid JSON — leave as-is for schema validation to report
    }
  }
}

async function consumeStreamWithTimeout(
  model: ReturnType<typeof import('@mariozechner/pi-ai').getModel>,
  context: import('@mariozechner/pi-ai').Context,
  options: Record<string, unknown>,
  completionOptions: LlmCompletionOptions | undefined,
  baseSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<AssistantMessage> {
  if (!timeoutMs || timeoutMs <= 0) {
    if (baseSignal) {
      options.signal = baseSignal;
    }
    return consumeStream(model, context, options, completionOptions);
  }

  const perCallTimeout = createTimeoutSignal(baseSignal, timeoutMs);
  if (perCallTimeout.signal) {
    options.signal = perCallTimeout.signal;
  }

  let timedOut = false;
  const timeoutError = new Error(`LLM request timed out after ${timeoutMs}ms`);
  let hardTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const streamPromise = consumeStream(model, context, options, completionOptions);
  const hardTimeoutPromise = new Promise<AssistantMessage>((_, reject) => {
    hardTimeoutId = setTimeout(() => {
      timedOut = true;
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([streamPromise, hardTimeoutPromise]);
  } finally {
    if (hardTimeoutId) {
      clearTimeout(hardTimeoutId);
    }
    // If we hit the hard timeout path, the underlying stream promise may
    // resolve/reject later; swallow it to avoid unhandled rejections.
    if (timedOut) {
      void streamPromise.catch(() => undefined);
    }
    perCallTimeout.cleanup();
  }
}