// ---------------------------------------------------------------------------
// Observer — Finding Registry
// ---------------------------------------------------------------------------
// Persists findings to disk with fingerprint-based deduplication.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { FindingRecord, FindingCategory, FindingSeverity } from './types.js';

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
    },
    sessionIds: string[],
  ): { fingerprint: string; isNew: boolean } {
    const fingerprint = computeFingerprint(finding.category, finding.title, finding.description);
    const existing = this.findings.find((f) => f.fingerprint === fingerprint);

    if (existing) {
      // Merge session IDs that aren't already tracked
      for (const sid of sessionIds) {
        if (
          !existing.observedInSessions.includes(sid) &&
          !existing.additionalSessions.includes(sid)
        ) {
          existing.additionalSessions.push(sid);
        }
      }
      this.dirty = true;
      return { fingerprint, isNew: false };
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

/**
 * Compute a deterministic fingerprint for deduplication.
 * Uses category + normalized title + first 200 chars of description.
 */
function computeFingerprint(category: string, title: string, description: string): string {
  const normalized = `${category}::${title.toLowerCase().trim()}::${description.slice(0, 200).toLowerCase().trim()}`;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}
