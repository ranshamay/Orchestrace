import {
  ALL_FINDING_CATEGORIES,
  type FindingCategory,
  type FindingSeverity,
} from './types.js';

const VALID_SEVERITIES: FindingSeverity[] = ['low', 'medium', 'high', 'critical'];
const RESPONSE_PREVIEW_LIMIT = 1_200;

type ParseReasonCode =
  | 'ok'
  | 'empty_response'
  | 'json_parse_failed'
  | 'invalid_top_level'
  | 'missing_findings_array';

export interface NormalizedLlmFinding {
  category: FindingCategory;
  severity: FindingSeverity;
  title: string;
  description: string;
  suggestedFix: string;
  relevantFiles?: string[];
}

interface ParseDiagnostics {
  reason: ParseReasonCode;
  preview: string;
  rawLength: number;
  parseAttempts: number;
  invalidEntries: number;
  filteredByCategory: number;
  normalizedCategory: number;
  normalizedSeverity: number;
}

export function parseLlmFindingsResponse(
  text: string,
  allowedCategories: FindingCategory[],
  options: { contextLabel: 'LLM analysis' | 'real-time analysis' },
): NormalizedLlmFinding[] {
  const diagnostics: ParseDiagnostics = {
    reason: 'ok',
    preview: safePreview(text),
    rawLength: text.length,
    parseAttempts: 0,
    invalidEntries: 0,
    filteredByCategory: 0,
    normalizedCategory: 0,
    normalizedSeverity: 0,
  };

  const candidates = extractParseCandidates(text);
  diagnostics.parseAttempts = candidates.length;

  if (candidates.length === 0) {
    diagnostics.reason = 'empty_response';
    logHardFailure(options.contextLabel, diagnostics);
    return [];
  }

  let parsed: unknown;
  let parsedFound = false;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      parsedFound = true;
      break;
    } catch {
      continue;
    }
  }

  if (!parsedFound) {
    diagnostics.reason = 'json_parse_failed';
    logHardFailure(options.contextLabel, diagnostics);
    return [];
  }

  const findingsSource = getFindingsArray(parsed);
  if (!findingsSource.ok) {
    diagnostics.reason = findingsSource.reason;
    logHardFailure(options.contextLabel, diagnostics);
    return [];
  }

  const normalized: NormalizedLlmFinding[] = [];
  for (const finding of findingsSource.findings) {
    const normalizedFinding = normalizeFinding(finding, allowedCategories, diagnostics);
    if (normalizedFinding) normalized.push(normalizedFinding);
  }

  if (diagnostics.invalidEntries > 0 || diagnostics.filteredByCategory > 0) {
    console.warn(`[orchestrace][observer] Filtered invalid ${options.contextLabel} findings`, {
      reason: diagnostics.reason,
      invalidEntries: diagnostics.invalidEntries,
      filteredByCategory: diagnostics.filteredByCategory,
      normalizedCategory: diagnostics.normalizedCategory,
      normalizedSeverity: diagnostics.normalizedSeverity,
      preview: diagnostics.preview,
      rawLength: diagnostics.rawLength,
    });
  }

  return normalized;
}

function extractParseCandidates(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const candidates = new Set<string>();
  candidates.add(trimmed);

  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i);
  if (fenceMatch?.[1]) {
    candidates.add(fenceMatch[1].trim());
  }

  const objectSlice = sliceBetween(trimmed, '{', '}');
  if (objectSlice) candidates.add(objectSlice);

  const arraySlice = sliceBetween(trimmed, '[', ']');
  if (arraySlice) candidates.add(arraySlice);

  return Array.from(candidates).filter((candidate) => candidate.length > 0);
}

function sliceBetween(text: string, startChar: '{' | '[', endChar: '}' | ']'): string | null {
  const start = text.indexOf(startChar);
  const end = text.lastIndexOf(endChar);
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1).trim();
}

function getFindingsArray(
  parsed: unknown,
):
  | { ok: true; findings: unknown[] }
  | { ok: false; reason: 'invalid_top_level' | 'missing_findings_array' } {
  if (Array.isArray(parsed)) {
    return { ok: true, findings: parsed };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'invalid_top_level' };
  }

  const findings = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) {
    return { ok: false, reason: 'missing_findings_array' };
  }

  return { ok: true, findings };
}

function normalizeFinding(
  finding: unknown,
  allowedCategories: FindingCategory[],
  diagnostics: ParseDiagnostics,
): NormalizedLlmFinding | null {
  if (!finding || typeof finding !== 'object') {
    diagnostics.invalidEntries++;
    return null;
  }

  const record = finding as Record<string, unknown>;
  if (
    typeof record.title !== 'string' ||
    typeof record.description !== 'string' ||
    typeof record.suggestedFix !== 'string'
  ) {
    diagnostics.invalidEntries++;
    return null;
  }

  const category = normalizeCategory(record.category, diagnostics);
  if (!allowedCategories.includes(category)) {
    diagnostics.filteredByCategory++;
    return null;
  }

  const severity = normalizeSeverity(record.severity, diagnostics);
  const relevantFiles =
    Array.isArray(record.relevantFiles)
      ? record.relevantFiles.filter((value): value is string => typeof value === 'string')
      : undefined;

  return {
    category,
    severity,
    title: record.title,
    description: record.description,
    suggestedFix: record.suggestedFix,
    relevantFiles: relevantFiles && relevantFiles.length > 0 ? relevantFiles : undefined,
  };
}

function normalizeCategory(value: unknown, diagnostics: ParseDiagnostics): FindingCategory {
  if (typeof value === 'string' && ALL_FINDING_CATEGORIES.includes(value as FindingCategory)) {
    return value as FindingCategory;
  }
  diagnostics.normalizedCategory++;
  return 'code-quality';
}

function normalizeSeverity(value: unknown, diagnostics: ParseDiagnostics): FindingSeverity {
  if (typeof value === 'string' && VALID_SEVERITIES.includes(value as FindingSeverity)) {
    return value as FindingSeverity;
  }
  diagnostics.normalizedSeverity++;
  return 'medium';
}

function logHardFailure(contextLabel: string, diagnostics: ParseDiagnostics): void {
  console.error(`[orchestrace][observer] Failed to parse ${contextLabel} response`, {
    reason: diagnostics.reason,
    preview: diagnostics.preview,
    rawLength: diagnostics.rawLength,
    parseAttempts: diagnostics.parseAttempts,
  });
}

function safePreview(text: string): string {
  const collapsedWhitespace = text.replace(/\s+/g, ' ').trim();
  if (collapsedWhitespace.length <= RESPONSE_PREVIEW_LIMIT) return collapsedWhitespace;
  return `${collapsedWhitespace.slice(0, RESPONSE_PREVIEW_LIMIT)}…[truncated]`;
}