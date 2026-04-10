// ---------------------------------------------------------------------------
// Observer — Finding Registry
// ---------------------------------------------------------------------------
// Persists findings to disk with fingerprint-based deduplication.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type {
  FindingRecord,
  FindingCategory,
  FindingSeverity,
  ObserverFindingEvidence,
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
      if (Array.isArray(parsed)) {
        this.findings = parsed;
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
        finding: {
      category: FindingCategory;
      severity: FindingSeverity;
      title: string;
      description: string;
      suggestedFix: string;
      relevantFiles?: string[];
      evidence: ObserverFindingEvidence;
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

    // New finding
    const record: FindingRecord = {
      ...finding,
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
    evidence: ObserverFindingEvidence;
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

  // Preserve latest/best available evidence summary and merge evidence files/snippets.
  const mergedEvidenceFiles = new Set([
    ...(record.evidence.files ?? []),
    ...(incoming.evidence.files ?? []),
  ]);
  const mergedEvidenceSnippets = new Set([
    ...(record.evidence.snippets ?? []),
    ...(incoming.evidence.snippets ?? []),
  ]);

  record.evidence = {
    ...record.evidence,
    ...incoming.evidence,
    summary: incoming.evidence.summary || record.evidence.summary,
    files: mergedEvidenceFiles.size > 0 ? [...mergedEvidenceFiles] : undefined,
    snippets: mergedEvidenceSnippets.size > 0 ? [...mergedEvidenceSnippets] : undefined,
  };
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

