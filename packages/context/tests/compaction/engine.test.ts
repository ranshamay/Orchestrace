import { describe, expect, it } from 'vitest';
import { compactHybrid } from '../../src/compaction/engine.js';
import type { CompactionInput } from '../../src/types.js';

function buildTurns(count: number, content: string) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content,
    turnIndex: index,
    tokens: Math.ceil(content.length / 4),
  }));
}

describe('compactHybrid', () => {
  it('returns heuristic result when already under budget', async () => {
    const input: CompactionInput = {
      turns: buildTurns(4, 'short turn'),
      anchorCount: 1,
      budgetTokens: 10_000,
    };

    const result = await compactHybrid(input);
    expect(result.compactionMethod).toBe('heuristic');
    expect(result.tokensAfterCompaction).toBeLessThanOrEqual(input.budgetTokens);
  });

  it('falls back to LLM pass when heuristic output is still over budget', async () => {
    const input: CompactionInput = {
      turns: buildTurns(18, 'Very long content '.repeat(120)),
      anchorCount: 2,
      budgetTokens: 350,
    };

    const delegate = {
      summarize: async () => '## Decisions\n- Chosen compact plan\n\n## Errors & Blockers\n- none',
    };

    const result = await compactHybrid(input, delegate);
    expect(result.compactionMethod).toBe('hybrid');
    expect(result.compressedHistory).toContain('## Decisions');
    expect(result.droppedTurnCount).toBeGreaterThan(0);
  });
});
