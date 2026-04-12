import { describe, expect, it, vi } from 'vitest';
import { analyzeSessionSummaries } from '../src/observer/analyzer.js';
import { DEFAULT_OBSERVER_CONFIG } from '../src/observer/types.js';
import type { SessionSummary } from '../src/observer/summarizer.js';

describe('observer analyzer prompt contract', () => {
  it('passes severity calibration and evidence threshold instructions in model prompt', async () => {
    const complete = vi.fn(async () => ({ text: JSON.stringify({ findings: [] }) }));

    const summary: SessionSummary = {
      sessionId: 'session-1',
      config: {
        prompt: 'Fix issue',
        provider: 'github-copilot',
        model: 'gpt-5',
        workspacePath: '/tmp/workspace',
        autoApprove: false,
      },
      status: 'running',
      llmStatusHistory: [],
      dagEvents: [],
      toolCalls: [],
      agentGraph: [],
      todos: [],
      streamedText: '',
      totalEvents: 10,
      durationMs: 1000,
    };

    await analyzeSessionSummaries(
      { complete } as { complete: typeof complete } as never,
      DEFAULT_OBSERVER_CONFIG,
      [summary],
      undefined,
      async () => undefined,
    );

    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0]?.[0] as { prompt?: string };
    const prompt = String(request?.prompt ?? '');

    expect(prompt).toContain('Apply severity calibration strictly');
    expect(prompt).toContain('critical requires severe demonstrated impact and 3+ corroborating evidence points');
    expect(prompt).toContain('If evidence thresholds are not met, lower severity or omit the finding');
  });
});