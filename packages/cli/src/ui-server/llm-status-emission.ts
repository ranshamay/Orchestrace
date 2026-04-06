import type { SessionLlmStatus } from './types.js';

export const LLM_STATUS_MIN_EMIT_INTERVAL_MS = 1_500;

export type LlmStatusEmissionState = {
  key: string;
  emittedAt: number;
};

export function llmStatusIdentityKey(status: SessionLlmStatus): string {
  return [
    status.state,
    status.detail ?? '',
    status.phase ?? '',
    status.taskId ?? '',
    status.failureType ?? '',
  ].join('|');
}

export function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function shouldEmitLlmStatus(
  next: SessionLlmStatus,
  previous: LlmStatusEmissionState | undefined,
  updatedAt: string,
): boolean {
  const terminalState = next.state === 'completed' || next.state === 'failed' || next.state === 'cancelled';
  if (terminalState) {
    return true;
  }

  const key = llmStatusIdentityKey(next);
  if (!previous || previous.key !== key) {
    return true;
  }

  const nowMs = parseTimestamp(updatedAt);
  return nowMs - previous.emittedAt >= LLM_STATUS_MIN_EMIT_INTERVAL_MS;
}