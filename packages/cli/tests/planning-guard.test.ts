import { describe, expect, it } from 'vitest';
import type { LlmToolCallEvent } from '@orchestrace/provider';
import type { WorkSession } from '../src/ui-server/types.js';
import {
  buildSessionSystemPrompt,
  enforcePlanningToolCallGuard,
  getSessionPlanningGuardState,
  isSimpleSessionTaskPrompt,
} from '../src/ui-server.js';

function createSession(overrides: Partial<WorkSession> = {}): WorkSession {
  const controller = new AbortController();
  return {
    id: 'session-1',
    workspaceId: 'ws-1',
    workspaceName: 'Workspace',
    workspacePath: '/tmp/workspace',
    prompt: 'Apply a small single-file policy update.\n\nRelevant Files\n- packages/cli/src/ui-server.ts',
    provider: 'github-copilot',
    model: 'gpt-5',
    planningProvider: 'github-copilot',
    planningModel: 'gpt-5',
    implementationProvider: 'github-copilot',
    implementationModel: 'gpt-5',
    deliveryStrategy: 'pr-only',
    autoApprove: false,
    planningNoToolGuardMode: 'enforce',
    adaptiveConcurrency: false,
    batchConcurrency: 4,
    batchMinConcurrency: 1,
    enableTrivialTaskGate: false,
    trivialTaskMaxPromptLength: 280,
    creationReason: 'start',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'running',
    llmStatus: {
      state: 'planning',
      label: 'Planning',
      detail: 'Planning in progress',
      phase: 'planning',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    taskStatus: {},
    events: [],
    agentGraph: [],
    controller,
    ...overrides,
  };
}

function startedTool(toolName: string): LlmToolCallEvent {
  return {
    type: 'started',
    toolCallId: `call-${toolName}`,
    toolName,
    arguments: '{}',
  };
}

describe('planning guard behavior', () => {
  it('forces implementation phase after exceeding no-write threshold while planning', () => {
    process.env.ORCHESTRACE_MAX_TOOL_CALLS_WITHOUT_WRITE = '2';
    process.env.ORCHESTRACE_PLANNING_BUDGET_PERCENT = '25';

    const session = createSession();
    const guards = new Map<string, ReturnType<typeof getSessionPlanningGuardState>>();
    const persistedEvents: Array<{ sessionId: string; type: string }> = [];

    for (let i = 0; i < 3; i += 1) {
      enforcePlanningToolCallGuard({
        session,
        continuationPhase: 'planning',
        toolEvent: startedTool('read_file'),
        sessionPlanningGuards: guards,
        persistEvent: (sessionId, event) => persistedEvents.push({ sessionId, type: event.type }),
        uiStatePersistence: { schedule: () => {}, flush: async () => {} },
      });
    }

    const state = guards.get(session.id);
    expect(state?.forcedImplementation).toBe(true);
    expect(session.llmStatus.phase).toBe('implementation');
    expect(session.llmStatus.detail).toContain('Planning guard triggered');
    expect(persistedEvents.some((entry) => entry.type === 'session:llm-status-change')).toBe(true);
  });

    it('forces implementation after repeated read-after-acknowledgment guardrail violations', () => {
    process.env.ORCHESTRACE_MAX_READ_AFTER_ACK_VIOLATIONS = '2';

    const session = createSession();
    const guards = new Map<string, ReturnType<typeof getSessionPlanningGuardState>>();
    const persistedEvents: Array<{ sessionId: string; type: string }> = [];

    const guardrailResultEvent: LlmToolCallEvent = {
      type: 'result',
      toolCallId: 'call-1',
      toolName: 'read_file',
      result: 'Tool call read_file (call-1) blocked by system guardrail. You acknowledged that context is sufficient, so the immediate next tool call must be write_file.',
      isError: true,
    };

    enforcePlanningToolCallGuard({
      session,
      continuationPhase: 'planning',
      toolEvent: guardrailResultEvent,
      sessionPlanningGuards: guards,
      persistEvent: (sessionId, event) => persistedEvents.push({ sessionId, type: event.type }),
      uiStatePersistence: { schedule: () => {}, flush: async () => {} },
    });
    enforcePlanningToolCallGuard({
      session,
      continuationPhase: 'planning',
      toolEvent: guardrailResultEvent,
      sessionPlanningGuards: guards,
      persistEvent: (sessionId, event) => persistedEvents.push({ sessionId, type: event.type }),
      uiStatePersistence: { schedule: () => {}, flush: async () => {} },
    });

    const state = guards.get(session.id);
    expect(state?.readAfterAcknowledgmentViolations).toBe(2);
    expect(state?.forcedImplementation).toBe(true);
    expect(session.llmStatus.detail).toContain('read-after-ack violations');
    expect(persistedEvents.some((entry) => entry.type === 'session:llm-status-change')).toBe(true);
  });

  it('resets consecutive non-write counter when write/edit tool is called', () => {

    process.env.ORCHESTRACE_MAX_TOOL_CALLS_WITHOUT_WRITE = '3';

    const session = createSession();
    const guards = new Map<string, ReturnType<typeof getSessionPlanningGuardState>>();

    enforcePlanningToolCallGuard({
      session,
      continuationPhase: 'planning',
      toolEvent: startedTool('read_file'),
      sessionPlanningGuards: guards,
      persistEvent: () => {},
      uiStatePersistence: { schedule: () => {}, flush: async () => {} },
    });

    enforcePlanningToolCallGuard({
      session,
      continuationPhase: 'planning',
      toolEvent: startedTool('edit_file'),
      sessionPlanningGuards: guards,
      persistEvent: () => {},
      uiStatePersistence: { schedule: () => {}, flush: async () => {} },
    });

    const state = guards.get(session.id);
        expect(state?.consecutiveNonWriteToolCalls).toBe(0);
    expect(state?.readAfterAcknowledgmentViolations).toBe(0);
    expect(state?.forcedImplementation).toBe(false);

  });

  it('includes simple-task policy and planning budget language in planning prompt', () => {
    const session = createSession();
    const prompt = buildSessionSystemPrompt(session, 'planning');

    expect(isSimpleSessionTaskPrompt(session.prompt)).toBe(true);
    expect(prompt).toContain('For simple single-file tasks, skip sub-agent delegation');
    expect(prompt).toContain('Planning is budgeted: keep planning activity under 25%');
    expect(prompt).toContain('If session guard thresholds are exceeded');
  });
});