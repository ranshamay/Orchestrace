// ---------------------------------------------------------------------------
// Observer — LLM Analyzer
// ---------------------------------------------------------------------------
// Sends session summaries to an LLM and extracts structured findings.
// ---------------------------------------------------------------------------

import type { LlmAdapter } from '@orchestrace/provider';
import {
  buildObserverFindingsJsonSchemaBlock,
  parseObserverFindingsResponse,
} from '@orchestrace/shared';
import {
  ALL_FINDING_CATEGORIES,
  type AnalysisResult,
  type FindingCategory,
  type FindingSeverity,
  type ObserverConfig,
} from './types.js';
import type { SessionSummary } from './summarizer.js';
import { formatSummaryForLlm } from './summarizer.js';
import { OBSERVER_SYSTEM_PROMPT } from './prompts.js';

/**
 * Analyze one or more session summaries via LLM and return structured findings.
 */
export async function analyzeSessionSummaries(
  llm: LlmAdapter,
  config: ObserverConfig,
  summaries: SessionSummary[],
  signal?: AbortSignal,
  resolveApiKey?: (provider: string) => Promise<string | undefined>,
): Promise<AnalysisResult> {
  if (summaries.length === 0) return { findings: [] };

  const allowedCategories =
    config.assessmentCategories.length > 0
      ? config.assessmentCategories
      : ALL_FINDING_CATEGORIES;

  const userPrompt = buildAnalysisPrompt(summaries, allowedCategories);

  const apiKey = resolveApiKey ? await resolveApiKey(config.provider) : undefined;
  const result = await llm.complete({
    provider: config.provider,
    model: config.model,
    systemPrompt: OBSERVER_SYSTEM_PROMPT,
    prompt: userPrompt,
    signal,
        apiKey,
    refreshApiKey: resolveApiKey ? () => resolveApiKey(config.provider) : undefined,
    allowAuthRefreshRetry: true,


  });

  return parseAnalysisResponse(result.text, allowedCategories);
}

function buildAnalysisPrompt(summaries: SessionSummary[], allowedCategories: FindingCategory[]): string {
  const parts: string[] = [];

  parts.push(
    `Analyze the following ${summaries.length} session log(s) for optimization opportunities.\n`,
  );

  for (const summary of summaries) {
    parts.push(formatSummaryForLlm(summary));
    parts.push('---\n');
  }

    parts.push('Respond with a JSON object matching this exact schema:\n');
  parts.push(
    buildObserverFindingsJsonSchemaBlock({
      categories: allowedCategories,
    }),
  );
  parts.push('Return ONLY the JSON object, no other text.');

  parts.push('');
  parts.push(`Only include findings in these categories: ${allowedCategories.join(', ')}`);

  return parts.join('\n');
}

/**
 * Parse the LLM response text into a structured AnalysisResult.
 * Tolerates markdown fences around the JSON.
 */
function parseAnalysisResponse(text: string, allowedCategories: FindingCategory[]): AnalysisResult {
  try {
    const parsed = parseObserverFindingsResponse(text, {
      categories: ALL_FINDING_CATEGORIES,
      categoryValidation: { type: 'coerce', fallback: 'code-quality' },
    });

    const findings: AnalysisResult['findings'] = parsed.findings
      .filter((finding) => allowedCategories.includes(finding.category))
      .map((finding) => ({
        category: finding.category,
        severity: finding.severity as FindingSeverity,
        title: finding.title,
        description: finding.description,
        suggestedFix: finding.suggestedFix,
        relevantFiles: finding.relevantFiles,
      }));

    return { findings };
  } catch {
    console.error('[orchestrace][observer] Failed to parse LLM analysis response');
    return { findings: [] };
  }
}
