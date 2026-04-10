import { describe, expect, it } from 'vitest';
import { buildSessionSystemPrompt } from '../src/ui-server.js';
import type { WorkSession } from '../src/ui-server/types.js';

function makeSession(overrides: Partial<WorkSession> = {}): WorkSession {
  const now = new Date().toISOString();
  return {
    id: 's1',
    workspaceId: 'w1',
    workspaceName: 'ws',
    workspacePath: '/tmp/ws',
    prompt: 'Implement change',
    provider: 'github-copilot',
    model: 'gpt-5.3-codex',
    planningProvider: 'github-copilot',
    planningModel: 'gpt-5.3-codex',
    implementationProvider: 'github-copilot',
    implementationModel: 'gpt-5.3-codex',
    deliveryStrategy: 'pr-only',
    autoApprove: false,
    planningNoToolGuardMode: 'enforce',
    adaptiveConcurrency: false,
    batchConcurrency: 8,
    batchMinConcurrency: 1,
    enableTrivialTaskGate: false,
    trivialTaskMaxPromptLength: 120,
    creationReason: 'start',
    createdAt: now,
    updatedAt: now,
    status: 'running',
    llmStatus: {
      state: 'planning',
      label: 'Planning',
      updatedAt: now,
    },
    taskStatus: {},
    events: [],
    agentGraph: [],
    controller: new AbortController(),
    ...overrides,
  };
}

describe('buildSessionSystemPrompt (implementation)', () => {
  it('uses planning coordination state in context and does not force startup re-reads', () => {
    const prompt = buildSessionSystemPrompt(makeSession(), 'implementation');

    expect(prompt).toContain('Use todo/agent graph state from planning already in session context; call todo_get/agent_graph_get only when state is missing, stale, or ambiguous, then keep todo_update current while implementing.');
    expect(prompt).not.toContain('Read todo_get and agent_graph_get before coding, then keep todo_update current while implementing.');
  });
});