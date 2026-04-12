// ---------------------------------------------------------------------------
// Observer — LLM Analyzer
// ---------------------------------------------------------------------------
// Sends session summaries to an LLM and extracts structured findings.
// ---------------------------------------------------------------------------

import type { LlmAdapter } from '@orchestrace/provider';
import {
  ALL_FINDING_CATEGORIES,
  normalizeFindingEvidence,
  type AnalysisResult,
  type FindingCategory,
  type FindingSeverity,
  type ObserverConfig,
  type ObserverFindingInput,
} from './types.js';
import type { SessionSummary } from './summarizer.js';
import { formatSummaryForLlm } from './summarizer.js';
import { FINDING_CATEGORY_LIST, OBSERVER_SYSTEM_PROMPT } from './prompts.js';

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

  parts.push(
    'Respond with a JSON object matching this exact schema:\n' +
      '```json\n' +
      '{\n' +
      '  "findings": [\n' +
      '    {\n' +
      '      "schemaVersion": "2",\n' +
      '      "category": "code-quality" | "performance" | "agent-efficiency" | "architecture" | "test-coverage",\n' +
      '      "severity": "low" | "medium" | "high" | "critical",\n' +
      '      "title": "Short one-line title",\n' +
      '      "description": "Detailed description of the issue found",\n' +
      '      "evidence": [{ "text": "Concrete implementation instruction / evidence detail" }],\n' +
      '      "relevantFiles": ["path/to/file.ts"]  // optional\n' +

      '    }\n' +
      '  ]\n' +
      '}\n' +
      '```\n' +
      'Compatibility: legacy outputs with `suggestedFix` are also accepted during rollout.\n' +
      'Return ONLY the JSON object, no other text.',
  );

  parts.push('');
  parts.push(`Only include findings in these categories: ${allowedCategories.join(', ')}`);

  return parts.join('\n');
}

/**
 * Parse the LLM response text into a structured AnalysisResult.
 * Tolerates markdown fences around the JSON.
 */
function parseAnalysisResponse(text: string, allowedCategories: FindingCategory[]): AnalysisResult {
  // Strip markdown code fences
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed || !Array.isArray(parsed.findings)) {
      return { findings: [] };
    }

        // Validate and sanitize each finding
    const validCategories: FindingCategory[] = [...ALL_FINDING_CATEGORIES];
    const validSeverities: FindingSeverity[] = ['low', 'medium', 'high', 'critical'];

    const mappedFindings: AnalysisResult['findings'] = parsed.findings
      .filter((f: Record<string, unknown>) =>
        isValidFindingCandidate(f, validCategories, validSeverities),
      )
      .map((f: Record<string, unknown>): ObserverFindingInput => {
        const evidence = normalizeFindingEvidence(
          Array.isArray(f.evidence)
            ? f.evidence
                .filter((entry): entry is { text: string } => {
                  if (!entry || typeof entry !== 'object') return false;
                  const textValue = (entry as Record<string, unknown>).text;
                  return typeof textValue === 'string';
                })
                .map((entry) => ({ text: entry.text }))
            : undefined,
          typeof f.suggestedFix === 'string' ? String(f.suggestedFix) : undefined,
        );

        return {
          schemaVersion: '2',
          category: f.category as FindingCategory,
          severity: f.severity as FindingSeverity,
          title: String(f.title).trim(),
          description: String(f.description).trim(),
          evidence,
          relevantFiles: Array.isArray(f.relevantFiles)
            ? f.relevantFiles.filter((p: unknown) => typeof p === 'string')
            : undefined,
        };
      });

    const findings: AnalysisResult['findings'] = mappedFindings.filter((finding) =>
      allowedCategories.includes(finding.category),
    );

    return { findings };
  } catch {
    console.error('[orchestrace][observer] Failed to parse LLM analysis response');
    return { findings: [] };
  }
}

function isValidFindingCandidate(
  f: Record<string, unknown>,
  validCategories: FindingCategory[],
  validSeverities: FindingSeverity[],
): boolean {
  const hasCore =
    typeof f.title === 'string'
    && f.title.trim().length > 0
    && typeof f.description === 'string'
    && f.description.trim().length > 0;
  if (!hasCore) {
    return false;
  }

  if (!validCategories.includes(f.category as FindingCategory)) {
    return false;
  }

  if (!validSeverities.includes(f.severity as FindingSeverity)) {
    return false;
  }

  const hasLegacy = typeof f.suggestedFix === 'string' && f.suggestedFix.trim().length > 0;
  const hasEvidence =
    Array.isArray(f.evidence)
    && f.evidence.some((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const textValue = (entry as Record<string, unknown>).text;
      return typeof textValue === 'string' && textValue.trim().length > 0;
    });

  return hasLegacy || hasEvidence;
}