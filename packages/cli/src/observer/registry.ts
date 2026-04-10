// ---------------------------------------------------------------------------
// Observer — Finding Registry
// ---------------------------------------------------------------------------
// Persists findings to disk with fingerprint-based deduplication.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import {
  ALL_FINDING_CATEGORIES,
  type FindingRecord,
  type FindingCategory,
  type FindingSeverity,
} from './types.js';


export class FindingRegistry {
  private findings: FindingRecord[] = [];
  private readonly filePath: string;
  private dirty = false;

  constructor(observerDir: string) {
    this.filePath = join(observerDir, 'findings.json');
  }

  /** Load persisted findings from disk. */
    async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      this.findings = normalizePersistedFindings(parsed);
    } catch {
      // File doesn't exist or is corrupted — start fresh
      this.findings = [];
    }
  }


  /** Persist findings to disk (only if dirty). */
  async save(): Promise<void> {
    if (!this.dirty) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.findings, null, 2), 'utf-8');
    this.dirty = false;
  }

  /**
   * Register a new finding. Returns the fingerprint.
   * If a finding with the same fingerprint already exists, merges the session
   * into additionalSessions instead of creating a duplicate.
   */
    register(
        finding: {
      category: FindingCategory;
      severity: FindingSeverity;
      title: string;
      description: string;
      suggestedFix?: string;
      evidence?: string[];
      relevantFiles?: string[];
    },

    sessionIds: string[],
  ): { fingerprint: string; isNew: boolean } {
    const fingerprint = computeFingerprint(finding.category, finding.title, finding.description);
    const existing = this.findings.find((f) => f.fingerprint === fingerprint);

    // Exact-match dedup always wins.
    if (existing) {
      mergeFindingSignal(existing, finding, sessionIds);
      this.dirty = true;
      return { fingerprint, isNew: false };
    }

    // If a somewhat equivalent finding is already in the active queue,
    // merge into that queued task instead of creating another queue item.
    const equivalentQueued = this.findings.find((record) => {
      if (!isQueueStatus(record.fixStatus)) {
        return false;
      }
      return isEquivalentFinding(record, finding);
    });

    if (equivalentQueued) {
      mergeFindingSignal(equivalentQueued, finding, sessionIds);
      this.dirty = true;
      return { fingerprint: equivalentQueued.fingerprint, isNew: false };
    }

        const normalizedEvidence = normalizeStringArray(finding.evidence);
    const normalizedSuggestedFix = normalizeSuggestedFix(finding.suggestedFix, normalizedEvidence);

    // New finding
    const record: FindingRecord = {
      category: finding.category,
      severity: finding.severity,
      title: finding.title,
      description: finding.description,
      suggestedFix: normalizedSuggestedFix,
      evidence: normalizedEvidence,
      relevantFiles: normalizeStringArray(finding.relevantFiles),
      fingerprint,
      observedInSessions: dedupeStrings(sessionIds),
      detectedAt: new Date().toISOString(),
      fixSessionId: null,
      fixStatus: 'pending',
      additionalSessions: [],
    };

    this.findings.push(record);
    this.dirty = true;
    return { fingerprint, isNew: true };
  }


  /** Get all findings that haven't been spawned as fix sessions yet. */
  getPending(): FindingRecord[] {
    return this.findings.filter((f) => f.fixStatus === 'pending');
  }

  /** Mark a finding as having a fix session spawned. */
  markSpawned(fingerprint: string, fixSessionId: string): void {
    const record = this.findings.find((f) => f.fingerprint === fingerprint);
    if (record) {
      record.fixSessionId = fixSessionId;
      record.fixStatus = 'spawned';
      this.dirty = true;
    }
  }

  /** Mark a finding's fix session as completed or failed. */
  markFixResult(fingerprint: string, status: 'completed' | 'failed'): void {
    const record = this.findings.find((f) => f.fingerprint === fingerprint);
    if (record) {
      record.fixStatus = status;
      this.dirty = true;
    }
  }

  /** Get all findings (for API/UI consumption). */
  getAll(): readonly FindingRecord[] {
    return this.findings;
  }

  /** Get a finding by fingerprint. */
  getByFingerprint(fingerprint: string): FindingRecord | undefined {
    return this.findings.find((f) => f.fingerprint === fingerprint);
  }

  /** Check if a fix session belongs to the observer. */
  isObserverSession(sessionId: string): boolean {
    return this.findings.some((f) => f.fixSessionId === sessionId);
  }
}

function mergeFindingSignal(
  record: FindingRecord,
  incoming: {
    severity: FindingSeverity;
    suggestedFix?: string;
    evidence?: string[];
    relevantFiles?: string[];
  },
  sessionIds: string[],
): void {

  // Track additional source sessions.
  for (const sid of sessionIds) {
    if (
      !record.observedInSessions.includes(sid) &&
      !record.additionalSessions.includes(sid)
    ) {
      record.additionalSessions.push(sid);
    }
  }

  // Escalate severity when a stronger signal appears.
  if (compareSeverity(incoming.severity, record.severity) > 0) {
    record.severity = incoming.severity;
  }

    const normalizedIncomingEvidence = normalizeStringArray(incoming.evidence);
  const mergedEvidence = dedupeStrings([...(record.evidence ?? []), ...normalizedIncomingEvidence]);
  if (mergedEvidence.length > 0) {
    record.evidence = mergedEvidence;
  }

  const nextSuggestedFix = normalizeSuggestedFix(incoming.suggestedFix, normalizedIncomingEvidence);
  if (nextSuggestedFix.length > 0) {
    record.suggestedFix = nextSuggestedFix;
  } else if (!record.suggestedFix || record.suggestedFix.trim().length === 0) {
    record.suggestedFix = normalizeSuggestedFix(undefined, record.evidence ?? []);
  }

  // Merge relevant file hints without duplicates.
  if (incoming.relevantFiles && incoming.relevantFiles.length > 0) {
    const merged = new Set([...(record.relevantFiles ?? []), ...incoming.relevantFiles]);
    record.relevantFiles = [...merged];
  }
}


function isQueueStatus(status: FindingRecord['fixStatus']): boolean {
  return status === 'pending' || status === 'spawned';
}

function isEquivalentFinding(
  existing: FindingRecord,
  incoming: {
    category: FindingCategory;
    title: string;
    description: string;
  },
): boolean {
  if (existing.category !== incoming.category) {
    return false;
  }

  const existingTitle = normalizeForComparison(existing.title);
  const incomingTitle = normalizeForComparison(incoming.title);
  if (existingTitle.length > 0 && existingTitle === incomingTitle) {
    return true;
  }

  const existingDesc = normalizeForComparison(existing.description);
  const incomingDesc = normalizeForComparison(incoming.description);
  if (existingDesc.length === 0 || incomingDesc.length === 0) {
    return false;
  }

  return existingDesc === incomingDesc;
}

function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compareSeverity(a: FindingSeverity, b: FindingSeverity): number {
  const rank: Record<FindingSeverity, number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  return rank[a] - rank[b];
}

/**
 * Compute a deterministic fingerprint for deduplication.
 * Uses category + normalized title + first 200 chars of description.
 */
function computeFingerprint(category: string, title: string, description: string): string {
  const normalized = `${category}::${title.toLowerCase().trim()}::${description.slice(0, 200).toLowerCase().trim()}`;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function normalizePersistedFindings(value: unknown): FindingRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: FindingRecord[] = [];
  for (const entry of value) {
    const record = normalizePersistedFinding(entry);
    if (record) {
      normalized.push(record);
    }
  }
  return normalized;
}

function normalizePersistedFinding(value: unknown): FindingRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const entry = value as Record<string, unknown>;
  const category = parseCategory(entry.category);
  const severity = parseSeverity(entry.severity);
  const title = asTrimmedString(entry.title);
  const description = asTrimmedString(entry.description);
  if (!category || !severity || title.length === 0 || description.length === 0) {
    return null;
  }

  const evidence = normalizeStringArray(entry.evidence);
  const suggestedFix = normalizeSuggestedFix(asOptionalString(entry.suggestedFix), evidence);
  const fingerprint = asTrimmedString(entry.fingerprint) || computeFingerprint(category, title, description);
  const detectedAt = asTrimmedString(entry.detectedAt) || new Date().toISOString();
  const fixSessionId = asNullableString(entry.fixSessionId);
  const fixStatus = parseFixStatus(entry.fixStatus);

  return {
    fingerprint,
    category,
    severity,
    title,
    description,
    suggestedFix,
    evidence,
    relevantFiles: normalizeStringArray(entry.relevantFiles),
    observedInSessions: normalizeStringArray(entry.observedInSessions),
    detectedAt,
    fixSessionId,
    fixStatus,
    additionalSessions: normalizeStringArray(entry.additionalSessions),
  };
}

function parseCategory(value: unknown): FindingCategory | null {
  if (typeof value !== 'string') {
    return null;
  }
  return ALL_FINDING_CATEGORIES.includes(value as FindingCategory)
    ? (value as FindingCategory)
    : null;
}

function parseSeverity(value: unknown): FindingSeverity | null {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'critical') {
    return value;
  }
  return null;
}

function parseFixStatus(value: unknown): FindingRecord['fixStatus'] {
  if (value === 'pending' || value === 'spawned' || value === 'completed' || value === 'failed') {
    return value;
  }
  return 'pending';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return dedupeStrings(
    value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeSuggestedFix(suggestedFix: string | undefined, evidence: string[]): string {
  const normalizedFix = (suggestedFix ?? '').trim();
  if (normalizedFix.length > 0) {
    return normalizedFix;
  }

  if (evidence.length > 0) {
    return evidence.join('\n');
  }

  return 'Review the finding details and implement an appropriate fix.';
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNullableString(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asTrimmedString(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}



