import type { SessionLifecyclePhase } from './session-lifecycle.js';

function errorMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

export function formatLifecyclePhaseFailure(phase: SessionLifecyclePhase, message: string): string {
  return `[phase=${phase}] ${message}`;
}

export function appendCleanupErrors(
  baseError: string,
  cleanupErrors: Array<{ phase: SessionLifecyclePhase; actionLabel: string; error: unknown }>,
): string {
  if (cleanupErrors.length === 0) {
    return baseError;
  }
  const details = cleanupErrors.map((entry) => `${entry.phase}:${entry.actionLabel}:${errorMsg(entry.error)}`).join(' | ');
  return `${baseError}\nCleanup errors: ${details}`;
}