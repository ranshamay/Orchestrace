import type { FindingSeverity } from './types.js';

/** Remove recommendation boilerplate from freeform text when needed. */
export function stripRecommendationText(text: string): string {
  return text
    .replace(/\b(recommended\s+fix|recommendation|suggested\s+fix)\s*:\s*/gi, '')
    .trim();
}

/**
 * Basic single-sentence summary validator.
 * Returns trimmed summary when valid, otherwise undefined.
 */
export function validateSummary(summary: unknown): string | undefined {
  if (typeof summary !== 'string') {
    return undefined;
  }

  const trimmed = summary.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const sentenceCount = (trimmed.match(/[.!?]+/g) ?? []).length;
  if (sentenceCount > 1) {
    return undefined;
  }

  return trimmed;
}

/** Convert unknown evidence payload into normalized {text} entries. */
export function sanitizeEvidenceEntries(
  evidence: unknown,
): Array<{ text: string }> | undefined {
  if (!Array.isArray(evidence)) {
    return undefined;
  }

  const entries = evidence
    .filter((entry): entry is { text: string } => {
      if (!entry || typeof entry !== 'object') return false;
      const textValue = (entry as Record<string, unknown>).text;
      return typeof textValue === 'string';
    })
    .map((entry) => ({ text: entry.text }));

  return entries.length > 0 ? entries : undefined;
}

/** Shared observer finding candidate validity gate. */
export function isValidFindingCandidate(f: Record<string, unknown>): boolean {
  const hasCore = typeof f.title === 'string' && typeof f.description === 'string';
  if (!hasCore) {
    return false;
  }

    
  const hasLegacy = typeof f.suggestedFix === 'string' || typeof f.issueSummary === 'string';
  const hasEvidence =
    Array.isArray(f.evidence)
    && f.evidence.some((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const textValue = (entry as Record<string, unknown>).text;
      return typeof textValue === 'string' && textValue.trim().length > 0;
    });

  return hasLegacy || hasEvidence;
}

/** Generic enum fallback guard. */
export function validateEnumValue<T extends string>(
  value: unknown,
  valid: readonly T[],
  fallback: T,
): T {
  if (typeof value !== 'string') {
    return fallback;
  }

  return valid.includes(value as T) ? (value as T) : fallback;
}

export function validateSeverity(value: unknown): FindingSeverity {
  const valid: FindingSeverity[] = ['low', 'medium', 'high', 'critical'];
  return validateEnumValue(value, valid, 'medium');
}

export function parseRelevantFiles(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const files = value.filter((entry): entry is string => typeof entry === 'string');
  return files.length > 0 ? files : undefined;
}