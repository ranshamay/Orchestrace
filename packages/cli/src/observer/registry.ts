// ---------------------------------------------------------------------------
// Observer — Finding Registry
// ---------------------------------------------------------------------------
// Persists findings to disk with fingerprint-based deduplication.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import {
  normalizeFindingEvidence,
  normalizeObserverFindingInput,
  type FindingRecord,
  type FindingCategory,
  type FindingSeverity,
  type ObserverFindingInput,
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
      if (!Array.isArray(parsed)) {
        this.findings = [];
        return;
      }

      const normalized: FindingRecord[] = [];
      let migratedCount = 0;
      let skippedCount = 0;

      for (const item of parsed) {
        const parsedRecord = parsePersistedFindingRecord(item);
        if (!parsedRecord) {
          skippedCount += 1;
          continue;
        }

        if (parsedRecord.wasMigrated) {
          migratedCount += 1;
        }
        normalized.push(parsedRecord.record);
      }

      this.findings = normalized;
      if (migratedCount > 0 || skippedCount > 0) {
        this.dirty = true;
      }

      if (migratedCount > 0) {
        console.log(
          `[orchestrace][observer] Migrated ${migratedCount} persisted finding(s) to schemaVersion=2`,
        );
      }
      if (skippedCount > 0) {
        console.warn(
          `[orchestrace][observer] Skipped ${skippedCount} malformed persisted finding(s) during load`,
        );
      }
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
    finding: ObserverFindingInput,
    sessionIds: string[],
  ): { fingerprint: string; isNew: boolean } {
    const normalizedFinding = normalizeObserverFindingInput(finding);
    const fingerprint = computeFingerprint(
      normalizedFinding.category,
      normalizedFinding.title,
      normalizedFinding.description,
    );
    const existing = this.findings.find((f) => f.fingerprint === fingerprint);

    // Exact-match dedup always wins.
    if (existing) {
      mergeFindingSignal(existing, normalizedFinding, sessionIds);
      this.dirty = true;
      return { fingerprint, isNew: false };
    }

    // If a somewhat equivalent finding is already in the active queue,
    // merge into that queued task instead of creating another queue item.
    const equivalentQueued = this.findings.find((record) => {
      if (!isQueueStatus(record.fixStatus)) {
        return false;
      }
      return isEquivalentFinding(record, normalizedFinding);
    });

    if (equivalentQueued) {
      mergeFindingSignal(equivalentQueued, normalizedFinding, sessionIds);
      this.dirty = true;
      return { fingerprint: equivalentQueued.fingerprint, isNew: false };
    }

    // New finding
    const record: FindingRecord = {
      ...normalizedFinding,
      fingerprint,
      observedInSessions: sessionIds,
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
    relevantFiles?: string[];
    evidence: Array<{ text: string }>;
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

  // Merge relevant file hints without duplicates.
  if (incoming.relevantFiles && incoming.relevantFiles.length > 0) {
    const merged = new Set([...(record.relevantFiles ?? []), ...incoming.relevantFiles]);
    record.relevantFiles = [...merged];
  }

  // Keep canonical schema marker and merge new evidence hints.
  record.schemaVersion = '2';
  const mergedEvidence = normalizeFindingEvidence(
    [...record.evidence, ...incoming.evidence],
    undefined,
  );
  record.evidence = dedupeEvidence(mergedEvidence);
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

function parsePersistedFindingRecord(
  value: unknown,
): { record: FindingRecord; wasMigrated: boolean } | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const obj = value as Record<string, unknown>;
  const category = asString(obj.category);
  const severity = asSeverity(obj.severity);
  const title = asString(obj.title);
  const description = asString(obj.description);
  const fingerprint = asString(obj.fingerprint);
  const detectedAt = asString(obj.detectedAt);

  if (!category || !severity || !title || !description || !fingerprint || !detectedAt) {
    return null;
  }

  const normalizedInput: ObserverFindingInput = {
    schemaVersion: obj.schemaVersion === '2' ? '2' : '1',
    category,
    severity,
    title,
    description,
    evidence: asEvidenceArray(obj.evidence),
    suggestedFix: asString(obj.suggestedFix) ?? undefined,
    relevantFiles: asStringArray(obj.relevantFiles),
  } as ObserverFindingInput;

  const normalized = normalizeObserverFindingInput(normalizedInput);
  const observedInSessions = asStringArray(obj.observedInSessions);
  const additionalSessions = asStringArray(obj.additionalSessions);

  const record: FindingRecord = {
    ...normalized,
    fingerprint,
    observedInSessions,
    detectedAt,
    fixSessionId: asNullableString(obj.fixSessionId),
    fixStatus: asFixStatus(obj.fixStatus) ?? 'pending',
    additionalSessions,
  };

  const hadSchemaV2 = obj.schemaVersion === '2';
  const legacyHadOnlySuggestedFix = typeof obj.suggestedFix === 'string' && !Array.isArray(obj.evidence);
  const wasMigrated = !hadSchemaV2 || legacyHadOnlySuggestedFix;

  return { record, wasMigrated };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNullableString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function asEvidenceArray(value: unknown): Array<{ text: string }> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parsed = value
    .filter((entry): entry is { text: string } => {
      if (!entry || typeof entry !== 'object') return false;
      const text = (entry as Record<string, unknown>).text;
      return typeof text === 'string' && text.trim().length > 0;
    })
    .map((entry) => ({ text: entry.text.trim() }));

  return parsed.length > 0 ? parsed : undefined;
}

function asSeverity(value: unknown): FindingSeverity | undefined {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'critical') {
    return value;
  }
  return undefined;
}

function asFixStatus(value: unknown): FindingRecord['fixStatus'] | undefined {
  if (value === 'pending' || value === 'spawned' || value === 'completed' || value === 'failed') {
    return value;
  }
  return undefined;
}

function dedupeEvidence(evidence: Array<{ text: string }>): Array<{ text: string }> {
  const seen = new Set<string>();
  const deduped: Array<{ text: string }> = [];

  for (const entry of evidence) {
    const normalized = entry.text.trim();
    if (normalized.length === 0) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({ text: normalized });
  }

  return deduped;
}