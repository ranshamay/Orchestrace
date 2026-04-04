import type { SessionStatus } from '../types';

export function normalizeTaskStatus(raw?: string): string {
  const value = (raw ?? '').toLowerCase();
  if (value.includes('failed') || value.includes('error')) {
    return 'failed';
  }
  if (value.includes('completed') || value.includes('output') || value.includes('done')) {
    return 'completed';
  }
  if (value.includes('started') || value.includes('stream') || value.includes('tool-call')) {
    return 'running';
  }
  return 'pending';
}

export function statusColor(status: string): string {
  switch (status) {
    case 'running':
      return '#2563eb';
    case 'completed':
      return '#059669';
    case 'failed':
      return '#dc2626';
    default:
      return '#94a3b8';
  }
}

export function normalizeSessionStatus(raw?: string): SessionStatus {
  const value = (raw ?? '').toLowerCase();
  if (!value) {
    return 'pending';
  }
  if (value.includes('fail') || value.includes('error')) {
    return 'failed';
  }
  if (value.includes('cancel') || value.includes('abort')) {
    return 'cancelled';
  }
  if (value.includes('complete') || value.includes('done') || value.includes('success')) {
    return 'completed';
  }
  if (value.includes('run') || value.includes('progress') || value.includes('start') || value.includes('stream')) {
    return 'running';
  }
  if (value.includes('pending') || value.includes('queue') || value.includes('wait')) {
    return 'pending';
  }
  return 'unknown';
}

export function formatSessionStatus(raw?: string): string {
  const normalized = normalizeSessionStatus(raw);
  if (normalized === 'unknown') {
    const fallback = (raw ?? '').trim().toLowerCase();
    return fallback || 'unknown';
  }
  return normalized;
}

export function sessionStatusBadgeClass(raw?: string, selected = false): string {
  if (selected) {
    return 'bg-white/20 text-white';
  }

  switch (normalizeSessionStatus(raw)) {
    case 'running':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
    case 'completed':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
    case 'failed':
      return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
    case 'cancelled':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
    case 'pending':
    default:
      return 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
  }
}