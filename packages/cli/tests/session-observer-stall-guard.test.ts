import { describe, expect, it } from 'vitest';
import { SessionObserver } from '../src/observer/session-observer.js';
import { DEFAULT_OBSERVER_CONFIG } from '../src/observer/types.js';

describe('session observer stall guard', () => {
  function createObserver() {
    return new SessionObserver({
      sessionId: 'session-stall',
      eventStore: {
        watch: () => () => {},
      } as never,
      llm: {
        complete: async () => ({ text: JSON.stringify({ findings: [] }) }),
      } as never,
      config: DEFAULT_OBSERVER_CONFIG,
      emit: () => {},
      resolveApiKey: async () => undefined,
    });
  }

  it('injects required anti-stall behavior when high discovery volume has no writes', () => {
    const observer = createObserver() as unknown as {
      ctx: { totalEvents: number; toolCalls: Array<{ toolName: string }> };
      buildAnalysisPrompt: (phase: string) => string;
    };

    observer.ctx.totalEvents = 500;
    observer.ctx.toolCalls = Array.from({ length: 60 }, () => ({ toolName: 'read_file' }));

    const prompt = observer.buildAnalysisPrompt('implementation');

    expect(prompt).toContain('stalled=yes');
    expect(prompt).toContain('## Required Anti-Stall Behavior');
    expect(prompt).toContain('direct the next step to code edits');
  });

  it('does not inject anti-stall block when write activity is present and ratio is healthy', () => {
    const observer = createObserver() as unknown as {
      ctx: { totalEvents: number; toolCalls: Array<{ toolName: string }> };
      buildAnalysisPrompt: (phase: string) => string;
    };

    observer.ctx.totalEvents = 500;
    observer.ctx.toolCalls = [
      ...Array.from({ length: 20 }, () => ({ toolName: 'read_file' })),
      ...Array.from({ length: 10 }, () => ({ toolName: 'edit_file' })),
    ];

    const prompt = observer.buildAnalysisPrompt('implementation');

    expect(prompt).toContain('stalled=no');
    expect(prompt).not.toContain('## Required Anti-Stall Behavior');
  });
});