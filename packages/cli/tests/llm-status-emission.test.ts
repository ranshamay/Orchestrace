import { describe, expect, it } from 'vitest';
import type { SessionLlmStatus } from '../src/ui-server/types.js';
import {
  LLM_STATUS_MIN_EMIT_INTERVAL_MS,
  llmStatusIdentityKey,
  parseTimestamp,
  shouldEmitLlmStatus,
  type LlmStatusEmissionState,
} from '../src/ui-server/llm-status-emission.js';

function status(partial: Partial<SessionLlmStatus>): SessionLlmStatus {
  return {
    state: 'thinking',
    label: 'Thinking',
    detail: 'Generating plan...',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('llm status emission policy', () => {
  it('throttles repeated thinking statuses within interval', () => {
    const first = status({ updatedAt: '2026-01-01T00:00:00.000Z', phase: 'planning', taskId: 'task' });
    const prev: LlmStatusEmissionState = {
      key: llmStatusIdentityKey(first),
      emittedAt: parseTimestamp(first.updatedAt),
    };

    const next = status({ updatedAt: '2026-01-01T00:00:00.500Z', phase: 'planning', taskId: 'task' });
    expect(shouldEmitLlmStatus(next, prev, next.updatedAt)).toBe(false);
  });

  it('emits identical thinking statuses after interval elapses', () => {
    const first = status({ updatedAt: '2026-01-01T00:00:00.000Z', phase: 'planning', taskId: 'task' });
    const prev: LlmStatusEmissionState = {
      key: llmStatusIdentityKey(first),
      emittedAt: parseTimestamp(first.updatedAt),
    };

    const next = status({
      updatedAt: new Date(parseTimestamp(first.updatedAt) + LLM_STATUS_MIN_EMIT_INTERVAL_MS).toISOString(),
      phase: 'planning',
      taskId: 'task',
    });
    expect(shouldEmitLlmStatus(next, prev, next.updatedAt)).toBe(true);
  });

  it('emits immediately on phase transition', () => {
    const planning = status({ updatedAt: '2026-01-01T00:00:00.000Z', phase: 'planning', taskId: 'task' });
    const prev: LlmStatusEmissionState = {
      key: llmStatusIdentityKey(planning),
      emittedAt: parseTimestamp(planning.updatedAt),
    };

    const implementation = status({
      updatedAt: '2026-01-01T00:00:00.250Z',
      phase: 'implementation',
      detail: 'Generating implementation...',
      taskId: 'task',
    });

    expect(shouldEmitLlmStatus(implementation, prev, implementation.updatedAt)).toBe(true);
  });

  it('bypasses throttle for terminal statuses', () => {
    const prev: LlmStatusEmissionState = {
      key: llmStatusIdentityKey(status({ phase: 'planning', taskId: 'task' })),
      emittedAt: parseTimestamp('2026-01-01T00:00:00.000Z'),
    };

    const failed = status({
      state: 'failed',
      label: 'Failed',
      detail: 'Execution failed.',
      updatedAt: '2026-01-01T00:00:00.100Z',
      taskId: 'task',
      phase: 'implementation',
    });

    expect(shouldEmitLlmStatus(failed, prev, failed.updatedAt)).toBe(true);
  });

  it('emits immediately for tool status change', () => {
    const thinking = status({ updatedAt: '2026-01-01T00:00:00.000Z', phase: 'implementation', taskId: 'task' });
    const prev: LlmStatusEmissionState = {
      key: llmStatusIdentityKey(thinking),
      emittedAt: parseTimestamp(thinking.updatedAt),
    };

    const usingTools = status({
      state: 'using-tools',
      label: 'Using Tools',
      detail: 'Running tool edit_file.',
      updatedAt: '2026-01-01T00:00:00.050Z',
      taskId: 'task',
      phase: 'implementation',
    });

    expect(shouldEmitLlmStatus(usingTools, prev, usingTools.updatedAt)).toBe(true);
  });
});