import { describe, expect, it } from 'vitest';
import { ContextEngine } from '../src/engine.js';
import type { ConversationTurn } from '../src/types.js';

function createTurns(count: number, content: string): ConversationTurn[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content,
    turnIndex: index,
    tokens: Math.ceil(content.length / 4),
  }));
}

describe('ContextEngine', () => {
  it('does not compact when context is comfortably under soft threshold', async () => {
    const engine = new ContextEngine({
      modelInfo: { contextWindow: 8_000, maxOutputTokens: 1_000 },
    });

    const result = await engine.buildContext({
      systemPrompt: 'System rules',
      turns: createTurns(6, 'small turn'),
      executionState: 'status: running',
      sharedFacts: [],
      turnsSinceLastCompaction: 1,
    });

    expect(result.compactionPerformed).toBe(false);
    expect(result.envelope.compacted).toBe(false);
  });

  it('compacts history when over budget pressure', async () => {
    const engine = new ContextEngine({
      modelInfo: { contextWindow: 1_200, maxOutputTokens: 200 },
    });

    const result = await engine.buildContext({
      systemPrompt: 'System rules ' + 'A'.repeat(1_600),
      turns: createTurns(24, 'Conversation detail '.repeat(120)),
      executionState: 'status: running\nphase: implementation',
      sharedFacts: [
        { id: 'fact_1', content: 'Important repository convention', tags: ['repo', 'convention'], author: 'agent', createdAt: Date.now() },
      ],
      turnsSinceLastCompaction: 20,
    });

    expect(result.compactionPerformed).toBe(true);
    expect(result.envelope.compacted).toBe(true);
    expect(result.envelope.compressedHistory.content.length).toBeGreaterThan(0);
  });
});
