// ---------------------------------------------------------------------------
// Observer — LLM Analyzer
// ---------------------------------------------------------------------------
// Sends session summaries to an LLM and extracts structured findings.
// ---------------------------------------------------------------------------

import type { LlmAdapter } from '@orchestrace/provider';
import {
  ALL_FINDING_CATEGORIES,
  type AnalysisResult,
  type FindingCategory,
  type FindingSeverity,
  type ObserverConfig,
  type ObserverFindingEvidence,
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

  parts.push(
    'Respond with a JSON object matching this exact schema:\n' +
      '```json\n' +
      '{\n' +
      '  "findings": [\n' +
      '    {\n' +
      '      "category": "code-quality" | "performance" | "agent-efficiency" | "architecture" | "test-coverage",\n' +
      '      "severity": "low" | "medium" | "high" | "critical",\n' +
      '      "title": "Short one-line title",\n' +
      '      "description": "Detailed description of the issue found",\n' +
            '      "suggestedFix": "Concrete implementation instruction that could be used as a task prompt",\n' +
      '      "relevantFiles": ["path/to/file.ts"],  // optional\n' +
      '      "evidence": {\n' +
      '        "summary": "Concrete evidence observed in session events",\n' +
      '        "eventCount": 1466,\n' +
      '        "durationSeconds": 90,\n' +
      '        "toolCalls": { "writes": 0, "reads": 34, "searches": 21, "total": 55 },\n' +
      '        "implementationAttempt": { "current": 1, "max": 3 },\n' +
      '        "files": ["packages/cli/src/observer/types.ts"],\n' +
      '        "snippets": ["No write_file/edit_file tool calls observed in implementation phase."]\n' +
      '      }\n' +
      '    }\n' +
      '  ]\n' +
      '}\n' +
      '```\n' +
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
function sanitizeEvidence(value: unknown): ObserverFindingEvidence {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;

  const summary = typeof raw.summary === 'string' && raw.summary.trim().length > 0
    ? raw.summary.trim()
    : 'Evidence details were not provided by the analyzer response.';

  const toolCallsRaw = raw.toolCalls && typeof raw.toolCalls === 'object'
    ? (raw.toolCalls as Record<string, unknown>)
    : undefined;

  const implementationAttemptRaw = raw.implementationAttempt && typeof raw.implementationAttempt === 'object'
    ? (raw.implementationAttempt as Record<string, unknown>)
    : undefined;

  const toNumber = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  return {
    summary,
    eventCount: toNumber(raw.eventCount),
    durationSeconds: toNumber(raw.durationSeconds),
    toolCalls: toolCallsRaw
      ? {
        writes: toNumber(toolCallsRaw.writes),
        reads: toNumber(toolCallsRaw.reads),
        searches: toNumber(toolCallsRaw.searches),
        total: toNumber(toolCallsRaw.total),
      }
      : undefined,
    implementationAttempt: implementationAttemptRaw
      ? {
        current: toNumber(implementationAttemptRaw.current),
        max: toNumber(implementationAttemptRaw.max),
      }
      : undefined,
    files: Array.isArray(raw.files)
      ? raw.files.filter((p: unknown) => typeof p === 'string')
      : undefined,
    snippets: Array.isArray(raw.snippets)
      ? raw.snippets.filter((s: unknown) => typeof s === 'string')
      : undefined,
  };
}

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
            .filter(
        (f: Record<string, unknown>) =>
          typeof f.title === 'string' &&
          typeof f.description === 'string' &&
          typeof f.suggestedFix === 'string' &&
          f.evidence !== undefined,
      )
      .map((f: Record<string, unknown>) => ({ 
        category: validCategories.includes(f.category as FindingCategory)
          ? (f.category as FindingCategory)
          : ('code-quality' as FindingCategory),
        severity: validSeverities.includes(f.severity as FindingSeverity)
          ? (f.severity as FindingSeverity)
          : ('medium' as FindingSeverity),
        title: String(f.title),
        description: String(f.description),
        suggestedFix: String(f.suggestedFix),
                relevantFiles: Array.isArray(f.relevantFiles)
          ? f.relevantFiles.filter((p: unknown) => typeof p === 'string')
          : undefined,
        evidence: sanitizeEvidence(f.evidence),
      }));

    const findings: AnalysisResult['findings'] = mappedFindings.filter((finding) =>
      allowedCategories.includes(finding.category),
    );

    return { findings };
  } catch {
    console.error('[orchestrace][observer] Failed to parse LLM analysis response');
    return { findings: [] };
  }
}
