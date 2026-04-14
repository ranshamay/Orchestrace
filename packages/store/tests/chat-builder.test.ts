import { describe, it, expect } from 'vitest';
import { convertLegacyEvents } from '../src/chat-builder.js';
import type { MaterializedSession, SessionChatMessage, SessionConfig } from '../src/types.js';

function buildSession(messages: SessionChatMessage[]): MaterializedSession {
  const createdAt = '2026-01-01T00:00:00.000Z';
  const config: SessionConfig = {
    id: 'sess-1',
    workspaceId: 'ws-1',
    workspaceName: 'ws',
    workspacePath: '/tmp/ws',
    prompt: '',
    provider: 'github-copilot',
    model: 'gpt-5.3-codex',
    autoApprove: false,
    adaptiveConcurrency: false,
    batchConcurrency: 4,
    batchMinConcurrency: 1,
    creationReason: 'start',
  };

  return {
    config,
    status: 'completed',
    llmStatus: {
      state: 'completed',
      label: 'Completed',
      updatedAt: createdAt,
    },
    taskStatus: {},
    events: [],
    agentGraph: [],
    chatThread: {
      provider: config.provider,
      model: config.model,
      workspacePath: config.workspacePath,
      taskPrompt: config.prompt,
      createdAt,
      updatedAt: messages[messages.length - 1]?.time ?? createdAt,
      messages,
    },
    todos: [],
    contextFacts: [],
    contextCompaction: { turnsSinceLastCompaction: 0 },
    lastSeq: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

describe('convertLegacyEvents', () => {
  it('keeps assistant chat turns separated', () => {
    const session = buildSession([
      { role: 'assistant', content: 'first reply', time: '2026-01-01T00:00:01.000Z' },
      { role: 'assistant', content: 'second reply', time: '2026-01-01T00:00:02.000Z' },
    ]);

    const converted = convertLegacyEvents(session);
    const assistant = converted.filter((message) => message.role === 'assistant');

    expect(assistant).toHaveLength(2);
    expect(assistant[0].parts[0]).toMatchObject({ type: 'text', text: 'first reply' });
    expect(assistant[1].parts[0]).toMatchObject({ type: 'text', text: 'second reply' });
  });

  it('preserves alternating user and assistant turns from chat thread', () => {
    const session = buildSession([
      { role: 'user', content: 'question one', time: '2026-01-01T00:00:01.000Z' },
      { role: 'assistant', content: 'answer one', time: '2026-01-01T00:00:02.000Z' },
      { role: 'user', content: 'question two', time: '2026-01-01T00:00:03.000Z' },
      { role: 'assistant', content: 'answer two', time: '2026-01-01T00:00:04.000Z' },
    ]);

    const converted = convertLegacyEvents(session);

    expect(converted.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });
});
