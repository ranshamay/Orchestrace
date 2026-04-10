import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FindingOutcome, FindingRecord } from './types.js';
import type { ObserverOutcomeStats } from './gate.js';

interface ObserverOutcomeRecord {
  fingerprint: string;
  fixSessionId: string | null;
  prUrl?: string;
  outcome: FindingOutcome;
  detectedAt: string;
  spawnedAt?: string;
  resolvedAt?: string;
  updatedAt: string;
}

export class OutcomeTracker {
  private readonly filePath: string;
  private readonly records = new Map<string, ObserverOutcomeRecord>();
  private dirty = false;

  constructor(observerDir: string) {
    this.filePath = join(observerDir, 'outcomes.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }

      for (const value of parsed) {
        const record = parseOutcomeRecord(value);
        if (!record) {
          continue;
        }
        this.records.set(record.fingerprint, record);
      }
    } catch {
      // Ignore missing or malformed state.
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      JSON.stringify([...this.records.values()], null, 2),
      'utf-8',
    );
    this.dirty = false;
  }

  syncFinding(finding: FindingRecord): void {
    const existing = this.records.get(finding.fingerprint);
    const now = new Date().toISOString();

    const record: ObserverOutcomeRecord = existing ?? {
      fingerprint: finding.fingerprint,
      fixSessionId: finding.fixSessionId,
      outcome: finding.outcome ?? inferOutcomeFromFinding(finding),
      detectedAt: finding.detectedAt,
      updatedAt: now,
    };

    record.fixSessionId = finding.fixSessionId;
    if (finding.prUrl) {
      record.prUrl = finding.prUrl;
    }

    if (finding.fixStatus === 'spawned' && !record.spawnedAt) {
      record.spawnedAt = now;
    }

    const inferredOutcome = finding.outcome ?? inferOutcomeFromFinding(finding);
    if (inferredOutcome !== record.outcome) {
      record.outcome = inferredOutcome;
      if (inferredOutcome === 'merged' || inferredOutcome === 'closed') {
        record.resolvedAt = now;
      }
    }

    record.updatedAt = now;
    this.records.set(finding.fingerprint, record);
    this.dirty = true;
  }

  markOutcome(fingerprint: string, outcome: FindingOutcome): void {
    const record = this.records.get(fingerprint);
    if (!record) {
      return;
    }

    if (record.outcome !== outcome) {
      record.outcome = outcome;
      if (outcome === 'merged' || outcome === 'closed') {
        record.resolvedAt = new Date().toISOString();
      }
      record.updatedAt = new Date().toISOString();
      this.dirty = true;
    }
  }

  getStats(windowDays = 30): ObserverOutcomeStats {
    const windowStart = Date.now() - (windowDays * 24 * 60 * 60 * 1000);
    const inWindow = [...this.records.values()].filter((record) => {
      const anchor = record.resolvedAt ?? record.updatedAt;
      const anchorMs = Date.parse(anchor);
      return Number.isFinite(anchorMs) && anchorMs >= windowStart;
    });

    const merged = inWindow.filter((record) => record.outcome === 'merged').length;
    const closed = inWindow.filter((record) => record.outcome === 'closed').length;
    const open = inWindow.filter((record) => record.outcome === 'open').length;
    const resolved = merged + closed;

    return {
      total: inWindow.length,
      merged,
      closed,
      open,
      accuracy: resolved > 0 ? merged / resolved : 1,
    };
  }
}

function parseOutcomeRecord(value: unknown): ObserverOutcomeRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const fingerprint = asString(record.fingerprint);
  const outcome = asOutcome(record.outcome);
  const detectedAt = asString(record.detectedAt);
  if (!fingerprint || !outcome || !detectedAt) {
    return null;
  }

  return {
    fingerprint,
    outcome,
    detectedAt,
    fixSessionId: asNullableString(record.fixSessionId),
    prUrl: asString(record.prUrl),
    spawnedAt: asString(record.spawnedAt),
    resolvedAt: asString(record.resolvedAt),
    updatedAt: asString(record.updatedAt) ?? detectedAt,
  };
}

function inferOutcomeFromFinding(finding: FindingRecord): FindingOutcome {
  if (finding.outcome) {
    return finding.outcome;
  }

  if (finding.fixStatus === 'completed') {
    return 'merged';
  }
  if (finding.fixStatus === 'failed' || finding.fixStatus === 'rejected') {
    return 'closed';
  }

  return 'open';
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asOutcome(value: unknown): FindingOutcome | undefined {
  if (value === 'open' || value === 'merged' || value === 'closed') {
    return value;
  }
  return undefined;
}
