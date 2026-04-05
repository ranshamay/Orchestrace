import type { CompactionInput, CompactionLlmDelegate, CompactionResult } from '../types.js';
import { compactHeuristic } from './heuristic.js';
import { compactWithLlm } from './llm.js';

/**
 * Hybrid compaction engine:
 * 1. Always runs heuristic pass first (instant, no LLM cost)
 * 2. If result still exceeds budget, runs LLM summarization on the heuristic output
 */
export async function compactHybrid(
  input: CompactionInput,
  delegate?: CompactionLlmDelegate,
  signal?: AbortSignal,
): Promise<CompactionResult> {
  // Pass 1: heuristic
  const heuristicResult = compactHeuristic(input);

  // If heuristic brought it under budget, we're done
  if (heuristicResult.tokensAfterCompaction <= input.budgetTokens) {
    return heuristicResult;
  }

  // No LLM delegate available – return heuristic result as-is
  if (!delegate) {
    return heuristicResult;
  }

  // Pass 2: LLM summarization on the already-compacted output
  const llmResult = await compactWithLlm(input, delegate, signal);

  return {
    ...llmResult,
    compactionMethod: 'hybrid',
  };
}
