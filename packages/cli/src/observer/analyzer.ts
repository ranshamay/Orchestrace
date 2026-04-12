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

  const llmResult = parseAnalysisResponse(result.text, allowedCategories);
  const deterministicFindings = summaries.flatMap((summary) =>
    detectRedundantFullReadPasses(summary, allowedCategories),
  );

  const mergedFindings = [...llmResult.findings];
  for (const finding of deterministicFindings) {
    if (!mergedFindings.some((existing) => areEquivalentFindings(existing, finding))) {
      mergedFindings.push(finding);
    }
  }

  return { findings: mergedFindings };
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
      .filter((f: Record<string, unknown>) => isValidFindingCandidate(f))
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
          category: validCategories.includes(f.category as FindingCategory)
            ? (f.category as FindingCategory)
            : ('code-quality' as FindingCategory),
          severity: validSeverities.includes(f.severity as FindingSeverity)
            ? (f.severity as FindingSeverity)
            : ('medium' as FindingSeverity),
          title: String(f.title),
          description: String(f.description),
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

function isValidFindingCandidate(f: Record<string, unknown>): boolean {
  const hasCore = typeof f.title === 'string' && typeof f.description === 'string';
  if (!hasCore) {
    return false;
  }

  const hasLegacy = typeof f.suggestedFix === 'string';
  const hasEvidence =
    Array.isArray(f.evidence)
    && f.evidence.some((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const textValue = (entry as Record<string, unknown>).text;
      return typeof textValue === 'string' && textValue.trim().length > 0;
    });

  return hasLegacy || hasEvidence;
}

function areEquivalentFindings(a: ObserverFindingInput, b: ObserverFindingInput): boolean {
  return a.category === b.category && a.severity === b.severity && a.title === b.title;
}

function detectRedundantFullReadPasses(
  summary: SessionSummary,
  allowedCategories: FindingCategory[],
): ObserverFindingInput[] {
  if (!allowedCategories.includes('agent-efficiency')) {
    return [];
  }

    const findings: ObserverFindingInput[] = [];
  const readPassHistory = new Map<string, { passCount: number; lastReadIndex: number; readPaths: string[] }>();
  const lastWriteIndexByPath = new Map<string, number>();

  for (let i = 0; i < summary.toolCalls.length; i++) {
    const call = summary.toolCalls[i];
    const writtenPaths = extractWritePaths(call);
    for (const path of writtenPaths) {
      lastWriteIndexByPath.set(path, i);
    }

    const readPaths = extractFullReadPaths(call);

    if (readPaths.length === 0) {
      continue;
    }

    const readSignature = readPaths.slice().sort().join('|');
    const prior = readPassHistory.get(readSignature);

    if (!prior) {
      readPassHistory.set(readSignature, {
        passCount: 1,
        lastReadIndex: i,
        readPaths,
      });
      continue;
    }

        const hasInvalidation = prior.readPaths.some((path) => {
      const lastWriteIndex = lastWriteIndexByPath.get(path);
      return typeof lastWriteIndex === 'number' && lastWriteIndex > prior.lastReadIndex;
    });
    if (hasInvalidation) {
      readPassHistory.set(readSignature, {
        passCount: 1,
        lastReadIndex: i,
        readPaths,
      });
      continue;
    }


    const nextPassCount = prior.passCount + 1;
    readPassHistory.set(readSignature, {
      passCount: nextPassCount,
      lastReadIndex: i,
      readPaths,
    });

    if (nextPassCount < 3) {
      continue;
    }

    const title = 'Implementation repeatedly re-read unchanged file set instead of editing';
    if (findings.some((f) => f.title === title)) {
      continue;
    }

    findings.push({
      schemaVersion: '2',
      category: 'agent-efficiency',
      severity: 'high',
      title,
      description:
        `Session ${summary.sessionId} performed at least ${nextPassCount} full read pass(es) of the same file set with no intervening writes/invalidation. ` +
        'After gap analysis, the agent should use working memory and proceed directly to write/edit calls.',
      evidence: [
        {
          text:
            `Repeated read_files/read_file pass detected for unchanged files: ${readPaths.join(', ')}. ` +
            'Add implementation-phase enforcement: no redundant rereads unless invalidated by write, context switch, explicit user request, or prior partial read.',
        },
      ],
      relevantFiles: readPaths,
    });
  }

  return findings;
}

function extractFullReadPaths(call: SessionSummary['toolCalls'][number]): string[] {
  if (call.isError) return [];
  if (call.toolName !== 'read_file' && call.toolName !== 'read_files') return [];
  if (!call.inputPreview || call.inputPreview.trim().length === 0) return [];

  const input = safeParseJson(call.inputPreview);
  if (!input || typeof input !== 'object') return [];

    if (call.toolName === 'read_file') {
    const parsed = input as { path?: unknown; startLine?: unknown; endLine?: unknown };
    if (typeof parsed.startLine === 'number' || typeof parsed.endLine === 'number') {
      return [];
    }
    const path = normalizePath(parsed.path);
    return path ? [path] : [];
  }


  const files = (input as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];

    const paths = files
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const parsedEntry = entry as { path?: unknown; startLine?: unknown; endLine?: unknown };
      if (typeof parsedEntry.startLine === 'number' || typeof parsedEntry.endLine === 'number') {
        return null;
      }
      return normalizePath(parsedEntry.path);
    })
    .filter((path): path is string => !!path);


  return dedupeStrings(paths);
}

function extractWritePaths(call: SessionSummary['toolCalls'][number]): string[] {
  if (call.isError) return [];

  if (call.toolName === 'write_file' || call.toolName === 'edit_file') {
    const input = safeParseJson(call.inputPreview);
    if (!input || typeof input !== 'object') return [];
    const path = normalizePath((input as { path?: unknown }).path);
    return path ? [path] : [];
  }

  if (call.toolName === 'write_files' || call.toolName === 'edit_files') {
    const input = safeParseJson(call.inputPreview);
    if (!input || typeof input !== 'object') return [];
    const files = (input as { files?: unknown }).files;
    if (!Array.isArray(files)) return [];
    return dedupeStrings(
      files
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null;
          return normalizePath((entry as { path?: unknown }).path);
        })
        .filter((path): path is string => !!path),
    );
  }

  return [];
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}
