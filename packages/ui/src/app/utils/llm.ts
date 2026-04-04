import type { WorkSession } from '../../lib/api';
import type { LlmSessionPhase, LlmSessionState, LlmSessionStatus } from '../types';
import { normalizeFailureType, resolveSessionFailureType } from './failure';
import { normalizeSessionStatus } from './status';

export function normalizeLlmSessionState(raw?: string): LlmSessionState {
  const value = (raw ?? '').trim().toLowerCase();
  switch (value) {
    case 'queued':
    case 'analyzing':
    case 'thinking':
    case 'planning':
    case 'implementing':
    case 'validating':
    case 'retrying':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return value;
    case 'awaiting_approval':
    case 'awaiting-approval':
      return 'awaiting-approval';
    case 'using_tools':
    case 'using-tools':
      return 'using-tools';
    default:
      return 'queued';
  }
}

export function llmStatusLabel(state: LlmSessionState): string {
  switch (state) {
    case 'queued':
      return 'Queued';
    case 'analyzing':
      return 'Analyzing';
    case 'thinking':
      return 'Thinking';
    case 'planning':
      return 'Planning';
    case 'awaiting-approval':
      return 'Awaiting Approval';
    case 'implementing':
      return 'Implementing';
    case 'using-tools':
      return 'Using Tools';
    case 'validating':
      return 'Validating';
    case 'retrying':
      return 'Retrying';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Queued';
  }
}

function fallbackLlmState(sessionStatus?: string): LlmSessionState {
  switch (normalizeSessionStatus(sessionStatus)) {
    case 'running':
      return 'analyzing';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'queued';
  }
}

function normalizeLlmPhase(raw?: string): LlmSessionPhase | undefined {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'planning') {
    return 'planning';
  }
  if (value === 'implementation' || value === 'implementing') {
    return 'implementation';
  }
  return undefined;
}

export function fallbackLlmPhase(state: LlmSessionState): LlmSessionPhase | undefined {
  switch (state) {
    case 'planning':
    case 'awaiting-approval':
      return 'planning';
    case 'implementing':
    case 'using-tools':
    case 'validating':
    case 'retrying':
      return 'implementation';
    default:
      return undefined;
  }
}

export function llmPhaseLabel(phase?: LlmSessionPhase): string {
  if (!phase) {
    return 'Unknown';
  }
  return phase === 'planning' ? 'Planning' : 'Implementation';
}

export function llmPhaseBadgeClass(phase?: LlmSessionPhase, selected = false): string {
  if (selected) {
    return 'bg-white/20 text-white';
  }
  if (phase === 'planning') {
    return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300';
  }
  if (phase === 'implementation') {
    return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
  }
  return 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
}

export function resolveLlmStatus(session?: WorkSession): LlmSessionStatus {
  const raw = session?.llmStatus;
  const sessionFailureType = resolveSessionFailureType(session);
  if (raw) {
    const state = normalizeLlmSessionState(raw.state);
    const phase = normalizeLlmPhase(raw.phase) ?? fallbackLlmPhase(state);
    return {
      state,
      label: raw.label?.trim() || llmStatusLabel(state),
      detail: raw.detail?.trim() || undefined,
      failureType: normalizeFailureType(raw.failureType) ?? sessionFailureType,
      phase,
    };
  }

  const fallbackState = fallbackLlmState(session?.status);
  return {
    state: fallbackState,
    label: llmStatusLabel(fallbackState),
    failureType: sessionFailureType,
    phase: fallbackLlmPhase(fallbackState),
  };
}

export function llmStatusBadgeClass(status: LlmSessionStatus, selected = false): string {
  if (selected) {
    return 'bg-white/20 text-white';
  }

  switch (status.state) {
    case 'analyzing':
    case 'thinking':
    case 'planning':
      return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300';
    case 'awaiting-approval':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
    case 'implementing':
    case 'using-tools':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
    case 'validating':
      return 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300';
    case 'retrying':
      return 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300';
    case 'completed':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
    case 'failed':
      return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
    case 'cancelled':
    default:
      return 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
  }
}

export function isLlmStatusBusy(status: LlmSessionStatus): boolean {
  return ['queued', 'analyzing', 'thinking', 'planning', 'awaiting-approval', 'implementing', 'using-tools', 'validating', 'retrying'].includes(status.state);
}