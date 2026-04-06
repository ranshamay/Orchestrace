import type { CompactionInput, CompactionResult, CompactionLlmDelegate } from '../types.js';
import { countTokens } from '../tokenizer.js';

const SUMMARIZATION_PROMPT_TEMPLATE = `You are a context compaction engine. Compress the following conversation history into a structured summary that preserves all critical information for continuing the task.

RULES:
- Keep ALL decisions made and their rationale
- Keep ALL unresolved errors, blockers, and open questions
- Keep file paths, function names, and specific technical details
- Keep user requirements and constraints verbatim
- Drop redundant tool output noise, verbose logs, and repeated content
- Use structured bullet points, not prose
- Target output length: under {maxTokens} tokens

FORMAT:
## Decisions
- [decision bullet points]

## Errors & Blockers
- [unresolved issues]

## Progress
- [what was accomplished]

## Open Questions
- [pending items]

## Key Technical Details
- [file paths, function names, configs mentioned]

CONVERSATION TO COMPRESS:
{content}`;

/**
 * LLM-based compaction: uses a fast/cheap model to summarize conversation
 * history into structured bullets.
 */
export async function compactWithLlm(
  input: CompactionInput,
  delegate: CompactionLlmDelegate,
  signal?: AbortSignal,
): Promise<CompactionResult> {
  const { turns, anchorCount, budgetTokens } = input;

  if (turns.length === 0) {
    return {
      compressedHistory: '',
      droppedTurnCount: 0,
      retainedAnchorCount: 0,
      compactionMethod: 'llm',
      tokensBeforeCompaction: 0,
      tokensAfterCompaction: 0,
    };
  }

  const tokensBeforeCompaction = turns.reduce((sum, t) => sum + t.tokens, 0);

  // Keep tail anchors verbatim, compress the rest
  const tailAnchors = turns.slice(-anchorCount);
  const toCompress = turns.slice(0, turns.length - anchorCount);

  if (toCompress.length === 0) {
    return {
      compressedHistory: tailAnchors.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join('\n\n'),
      droppedTurnCount: 0,
      retainedAnchorCount: tailAnchors.length,
      compactionMethod: 'llm',
      tokensBeforeCompaction,
      tokensAfterCompaction: tailAnchors.reduce((sum, t) => sum + t.tokens, 0),
    };
  }

  const conversationText = toCompress
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join('\n\n');

  const tailAnchorTokens = tailAnchors.reduce((sum, t) => sum + t.tokens, 0);
  const summaryBudget = Math.max(500, budgetTokens - tailAnchorTokens);

  const prompt = SUMMARIZATION_PROMPT_TEMPLATE
    .replace('{maxTokens}', String(summaryBudget))
    .replace('{content}', conversationText);

  const summary = await delegate.summarize(prompt, summaryBudget, signal);

  const parts = [summary];
  for (const turn of tailAnchors) {
    parts.push(`${turn.role.toUpperCase()}: ${turn.content}`);
  }

  const compressedHistory = parts.join('\n\n');
  const tokensAfterCompaction = countTokens(compressedHistory);

  return {
    compressedHistory,
    droppedTurnCount: toCompress.length,
    retainedAnchorCount: tailAnchors.length,
    compactionMethod: 'llm',
    tokensBeforeCompaction,
    tokensAfterCompaction,
  };
}
