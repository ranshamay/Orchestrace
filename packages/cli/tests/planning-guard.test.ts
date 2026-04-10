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
  it('includes direct edit-first and no-scripting policy in implementation prompt', () => {
    const session = createSession();
    const prompt = buildSessionSystemPrompt(session, 'implementation');

    expect(prompt).toContain('When sufficient context is available, immediately issue the first edit_file/edit_files call.');
    expect(prompt).toContain('Do not use python/bash or other intermediate scripting layers to orchestrate edits; use edit_file/edit_files directly.');
    expect(prompt).toContain('Edit files sequentially: start with the first target file, then proceed file-by-file.');
  });


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