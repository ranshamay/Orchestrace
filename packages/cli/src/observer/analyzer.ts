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
import { OBSERVER_SYSTEM_PROMPT } from './prompts.js';


const READ_SEARCH_TOOLS = new Set(['read_file', 'read_files', 'search_files']);
const WRITE_TOOLS = new Set(['write_file', 'write_files', 'edit_file', 'edit_files']);

const DISCOVERY_LOOP_MIN_READ_SEARCH = 12;
const DISCOVERY_LOOP_MIN_STREAK = 8;
const DISCOVERY_LOOP_MIN_EVENTS = 80;
const DISCOVERY_LOOP_MIN_DURATION_MS = 90_000;

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

  const parsed = parseAnalysisResponse(result.text, allowedCategories);
  const gateFindings = buildParserValidationGateFindings(summaries, allowedCategories);

  if (gateFindings.length === 0) {
    return parsed;
  }

  const combined = [...parsed.findings];
  for (const gate of gateFindings) {
    if (
      combined.some(
        (existing) =>
          existing.category === gate.category
          && existing.title.trim().toLowerCase() === gate.title.trim().toLowerCase(),
      )
    ) {
      continue;
    }
    combined.push(gate);
  }

  return { findings: combined };
}

function buildAnalysisPrompt(summaries: SessionSummary[], allowedCategories: FindingCategory[]): string {
  const parts: string[] = [];

  parts.push(
    `Analyze the following ${summaries.length} session log(s) for optimization opportunities.\n`,
  );

  for (const summary of summaries) {
    parts.push(formatSessionSummaryForAnalyzer(summary));
    parts.push('---\n');
  }

  parts.push(

    'Respond with a JSON object matching this exact schema:\n'
      + '```json\n'
      + '{\n'
      + '  "findings": [\n'
      + '    {\n'
      + '      "schemaVersion": "2",\n'
      + '      "category": "code-quality" | "performance" | "agent-efficiency" | "architecture" | "test-coverage",\n'
      + '      "severity": "low" | "medium" | "high" | "critical",\n'
      + '      "title": "Short one-line title",\n'
      + '      "description": "Detailed description of the issue found",\n'
      + '      "evidence": [{ "text": "Concrete implementation instruction / evidence detail" }],\n'
      + '      "relevantFiles": ["path/to/file.ts"]  // optional\n'
      + '    }\n'
      + '  ]\n'
      + '}\n'
      + '```\n'
      + 'Compatibility: legacy outputs with `suggestedFix` are also accepted during rollout.\n'
      + 'Return ONLY the JSON object, no other text.',
  );

  parts.push('');
  parts.push(`Only include findings in these categories: ${allowedCategories.join(', ')}`);

    return parts.join('\n');
}

function formatSessionSummaryForAnalyzer(summary: SessionSummary): string {
  const lines: string[] = [];

  lines.push(`## Session ${summary.sessionId}`);
  lines.push(`Prompt: ${summary.config.prompt}`);
  lines.push(`Provider: ${summary.config.provider} / Model: ${summary.config.model}`);
  lines.push(`Workspace: ${summary.config.workspacePath}`);
  lines.push(`Status: ${summary.status}${summary.error ? ` — Error: ${summary.error}` : ''}`);
  lines.push(`Duration: ${summary.durationMs != null ? `${(summary.durationMs / 1000).toFixed(1)}s` : 'unknown'}`);
  lines.push(`Total events: ${summary.totalEvents}`);
  lines.push('');

  if (summary.toolCalls.length > 0) {
    lines.push('### Tool Calls');
    for (const tool of summary.toolCalls) {
      lines.push(`- ${tool.toolName}${tool.isError ? ' [error]' : ''}`);
    }
    lines.push('');
  }

  if (summary.todos.length > 0) {
    lines.push('### Todos');
    for (const todo of summary.todos) {
      lines.push(`- [${todo.done ? 'x' : ' '}] ${todo.text}${todo.status ? ` (${todo.status})` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
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

export function buildParserValidationGateFindings(
  summaries: SessionSummary[],
  allowedCategories: FindingCategory[],
): ObserverFindingInput[] {
  if (!allowedCategories.includes('agent-efficiency')) {
    return [];
  }

  const findings: ObserverFindingInput[] = [];

  for (const summary of summaries) {
    const metrics = collectToolMetrics(summary);
    const startedImplementation = summary.llmStatusHistory.some(
      (entry) => entry.state === 'implementing' || entry.detail?.includes('implementing'),
    );
    const longRunningSession =
      summary.totalEvents >= DISCOVERY_LOOP_MIN_EVENTS
      || (summary.durationMs != null && summary.durationMs >= DISCOVERY_LOOP_MIN_DURATION_MS);

    const qualifies =
      metrics.readSearchCalls >= DISCOVERY_LOOP_MIN_READ_SEARCH
      && metrics.writeCalls === 0
      && metrics.longestDiscoveryStreak >= DISCOVERY_LOOP_MIN_STREAK
      && (startedImplementation || longRunningSession);

    if (!qualifies) {
      continue;
    }

    const severity: FindingSeverity =
      metrics.readSearchCalls >= 30 || summary.totalEvents >= 400 ? 'critical' : 'high';

    findings.push({
      schemaVersion: '2',
      category: 'agent-efficiency',
      severity,
      title: `Implementation stalled in discovery loop (${summary.sessionId})`,
      description:
        `Session ${summary.sessionId} repeatedly invoked read/search tools without any write/edit operation, `
        + `indicating an implementation stall. read/search=${metrics.readSearchCalls}, writes=${metrics.writeCalls}, `
        + `longest discovery streak=${metrics.longestDiscoveryStreak}, total events=${summary.totalEvents}.`,
      evidence: [
        {
          text:
            'Transition immediately to code generation: execute the first concrete write/edit in the requested target file before additional discovery calls.',
        },
        {
          text:
            'Skip non-deliverable audit/documentation detours when the task explicitly requires code changes, then re-run validation after writing.',
        },
      ],
    });
  }

  return findings;
}

function collectToolMetrics(summary: SessionSummary): {
  readSearchCalls: number;
  writeCalls: number;
  longestDiscoveryStreak: number;
} {
  let readSearchCalls = 0;
  let writeCalls = 0;
  let currentDiscoveryStreak = 0;
  let longestDiscoveryStreak = 0;

  for (const toolCall of summary.toolCalls) {
    if (READ_SEARCH_TOOLS.has(toolCall.toolName)) {
      readSearchCalls++;
      currentDiscoveryStreak++;
      if (currentDiscoveryStreak > longestDiscoveryStreak) {
        longestDiscoveryStreak = currentDiscoveryStreak;
      }
      continue;
    }

    if (WRITE_TOOLS.has(toolCall.toolName)) {
      writeCalls++;
    }

    currentDiscoveryStreak = 0;
  }

  return {
    readSearchCalls,
    writeCalls,
    longestDiscoveryStreak,
  };
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