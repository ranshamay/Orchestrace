import { describe, expect, it } from 'vitest';
import { OBSERVER_SYSTEM_PROMPT, REALTIME_OBSERVER_SYSTEM_PROMPT } from '../src/observer/prompts.js';
import { buildParserValidationGateFindings } from '../src/observer/analyzer.js';

type MockSessionSummary = {
  sessionId: string;
  config: {
    prompt: string;
    provider: string;
    model: string;
    workspacePath: string;
    autoApprove: boolean;
  };
  status: string;
  llmStatusHistory: Array<{ time: string; state: string; detail?: string }>;
  dagEvents: Array<{ time: string; type: string; taskId?: string; message: string }>;
  toolCalls: Array<{
    time: string;
    toolName: string;
    inputPreview: string;
    outputPreview: string;
    isError: boolean;
  }>;
  agentGraph: Array<{ id: string; name?: string; status?: string; prompt: string }>;
  todos: Array<{ text: string; status?: string; done: boolean }>;
  streamedText: string;
  totalEvents: number;
  durationMs: number | null;
};

function createDiscoveryLoopSummary(overrides?: Partial<MockSessionSummary>): MockSessionSummary {
  const readCalls = Array.from({ length: 14 }, (_, idx) => ({
    time: new Date(Date.now() + idx * 1000).toISOString(),
    toolName: idx % 2 === 0 ? 'read_files' : 'search_files',
    inputPreview: '{"path":"packages/cli/src/observer"}',
    outputPreview: '{}',
    isError: false,
  }));

  return {
    sessionId: 'session-loop',
    config: {
      prompt: 'Implement observer fix',
      provider: 'test-provider',
      model: 'test-model',
      workspacePath: '/tmp/workspace',
      autoApprove: true,
    },
    status: 'completed',
    llmStatusHistory: [
      { time: new Date().toISOString(), state: 'implementing', detail: 'implementation phase' },
    ],
    dagEvents: [],
    toolCalls: readCalls,
    agentGraph: [],
    todos: [],
    streamedText: '',
    totalEvents: 140,
    durationMs: 160_000,
    ...overrides,
  };
}

describe('observer discovery-loop regression', () => {
  it('contains explicit implementation-first anti-loop guidance in prompts', () => {
    expect(OBSERVER_SYSTEM_PROMPT).toContain('prolonged read/search discovery with zero write operations');
    expect(OBSERVER_SYSTEM_PROMPT).toContain('immediate transition to the first concrete code write');

    expect(REALTIME_OBSERVER_SYSTEM_PROMPT).toContain(
      'read/search tool calls accumulate while write tool calls remain zero',
    );
        expect(REALTIME_OBSERVER_SYSTEM_PROMPT).toContain(
      'recommend skipping non-deliverable audit/documentation detours',
    );

  });

  it('emits analyzer parser gate findings for zero-write discovery loops', () => {
    const summary = createDiscoveryLoopSummary();
    const findings = buildParserValidationGateFindings(
      [summary as Parameters<typeof buildParserValidationGateFindings>[0][number]],
      ['agent-efficiency'],
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.category).toBe('agent-efficiency');
    expect(findings[0]?.title).toContain('Implementation stalled in discovery loop');
    expect(findings[0]?.description).toContain('writes=0');
    expect(findings[0]?.evidence?.[0]?.text).toContain('first concrete write/edit');
  });
});