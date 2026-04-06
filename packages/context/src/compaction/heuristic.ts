import type { CompactionInput, CompactionResult, ConversationTurn } from '../types.js';
import { countTokens } from '../tokenizer.js';

/**
 * Heuristic compaction: removes tool noise, keeps decisions/errors,
 * truncates middle history while preserving head anchors and tail recency.
 */
export function compactHeuristic(input: CompactionInput): CompactionResult {
  const { turns, anchorCount, budgetTokens } = input;

  if (turns.length === 0) {
    return {
      compressedHistory: '',
      droppedTurnCount: 0,
      retainedAnchorCount: 0,
      compactionMethod: 'heuristic',
      tokensBeforeCompaction: 0,
      tokensAfterCompaction: 0,
    };
  }

  const tokensBeforeCompaction = turns.reduce((sum, t) => sum + t.tokens, 0);

  // Split into head anchors, middle, and tail anchors
  const headAnchors = turns.slice(0, anchorCount);
  const tailAnchors = turns.slice(-anchorCount);
  const middle = turns.slice(anchorCount, turns.length - anchorCount);

  // Phase 1: Strip tool_result content (keep only short summaries)
  const compactedMiddle = middle.map((turn) => compactTurn(turn));

  // Phase 2: Score and sort middle turns by importance
  const scored = compactedMiddle.map((turn) => ({
    turn,
    score: scoreTurn(turn),
  }));
  scored.sort((a, b) => b.score - a.score);

  // Phase 3: Greedily fit turns within budget, preserving chronological order
  const anchorTokens = [...headAnchors, ...tailAnchors].reduce((sum, t) => sum + t.tokens, 0);
  let remainingBudget = budgetTokens - anchorTokens;

  const retainedMiddleIndices = new Set<number>();
  for (const { turn } of scored) {
    if (turn.tokens <= remainingBudget) {
      retainedMiddleIndices.add(turn.turnIndex);
      remainingBudget -= turn.tokens;
    }
  }

  // Build compressed output preserving chronological order
  const parts: string[] = [];

  // Head anchors
  for (const turn of headAnchors) {
    parts.push(formatTurn(turn));
  }

  // Compressed middle section
  const retainedMiddle: ConversationTurn[] = [];
  const droppedMiddle: ConversationTurn[] = [];

  for (const turn of compactedMiddle) {
    if (retainedMiddleIndices.has(turn.turnIndex)) {
      retainedMiddle.push(turn);
    } else {
      droppedMiddle.push(turn);
    }
  }

  if (droppedMiddle.length > 0) {
    parts.push(`[${droppedMiddle.length} earlier turns compacted]`);
  }

  // Build decision summary from dropped turns
  const decisions = extractDecisionPoints(droppedMiddle);
  if (decisions.length > 0) {
    parts.push('Key decisions from compacted history:');
    for (const decision of decisions) {
      parts.push(`- ${decision}`);
    }
  }

  // Retained middle turns
  for (const turn of retainedMiddle) {
    parts.push(formatTurn(turn));
  }

  // Tail anchors
  for (const turn of tailAnchors) {
    parts.push(formatTurn(turn));
  }

  const compressedHistory = parts.join('\n\n');
  const tokensAfterCompaction = countTokens(compressedHistory);

  return {
    compressedHistory,
    droppedTurnCount: droppedMiddle.length,
    retainedAnchorCount: headAnchors.length + tailAnchors.length,
    compactionMethod: 'heuristic',
    tokensBeforeCompaction,
    tokensAfterCompaction,
  };
}

function compactTurn(turn: ConversationTurn): ConversationTurn {
  if (turn.role === 'tool_result') {
    const maxLen = 300;
    const compacted = turn.content.length > maxLen
      ? turn.content.slice(0, maxLen) + '... [truncated]'
      : turn.content;
    return { ...turn, content: compacted, tokens: countTokens(compacted) };
  }

  if (turn.role === 'tool_call') {
    // Keep tool name and args summary, strip verbose content
    const maxLen = 200;
    const compacted = turn.content.length > maxLen
      ? turn.content.slice(0, maxLen) + '... [truncated]'
      : turn.content;
    return { ...turn, content: compacted, tokens: countTokens(compacted) };
  }

  return turn;
}

function scoreTurn(turn: ConversationTurn): number {
  let score = 0;

  // User messages are high value (contain requirements)
  if (turn.role === 'user') score += 10;

  // Assistant messages with decisions are high value
  if (turn.role === 'assistant') score += 5;

  // Tool results are lowest value (most noise)
  if (turn.role === 'tool_result') score += 1;
  if (turn.role === 'tool_call') score += 2;

  // Boost for error/failure content
  const lower = turn.content.toLowerCase();
  if (lower.includes('error') || lower.includes('fail') || lower.includes('fix')) score += 3;

  // Boost for decision language
  if (lower.includes('decided') || lower.includes('approach') || lower.includes('instead')) score += 3;

  // Boost for todo/plan/blocker content
  if (lower.includes('todo') || lower.includes('plan') || lower.includes('block')) score += 2;

  return score;
}

function formatTurn(turn: ConversationTurn): string {
  return `${turn.role.toUpperCase()}: ${turn.content}`;
}

function extractDecisionPoints(turns: ConversationTurn[]): string[] {
  const decisions: string[] = [];
  const decisionPatterns = [
    /decided\s+to\s+(.{20,100})/i,
    /approach[:\s]+(.{20,100})/i,
    /instead[,\s]+(.{20,100})/i,
    /conclusion[:\s]+(.{20,100})/i,
    /resolved[:\s]+(.{20,100})/i,
  ];

  for (const turn of turns) {
    if (turn.role !== 'assistant') continue;
    for (const pattern of decisionPatterns) {
      const match = turn.content.match(pattern);
      if (match?.[1]) {
        decisions.push(match[1].trim().replace(/\.$/, ''));
        break;
      }
    }
  }

  return decisions.slice(0, 10);
}
