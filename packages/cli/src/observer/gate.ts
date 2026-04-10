import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { FindingRecord, FindingSeverity, ObserverConfig } from './types.js';

const execFile = promisify(execFileCallback);

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const STOP_WORDS = new Set([
  'fix',
  'observer',
  'issue',
  'task',
  'error',
  'code',
  'with',
  'from',
  'and',
  'the',
]);

export interface ObserverOutcomeStats {
  total: number;
  merged: number;
  closed: number;
  open: number;
  accuracy: number;
}

export interface SpawnGateDecision {
  approved: boolean;
  reason: string;
}

interface EvaluateSpawnGateOptions {
  finding: FindingRecord;
  config: ObserverConfig;
  outcomeStats: ObserverOutcomeStats;
  remoteBranches: string[];
}

export function evaluateSpawnGate(options: EvaluateSpawnGateOptions): SpawnGateDecision {
  if (!meetsSeverityThreshold(options.finding.severity, options.config.minSeverityForAutoFix)) {
    return {
      approved: false,
      reason: `Held for manual review: severity ${options.finding.severity} is below auto-fix threshold ${options.config.minSeverityForAutoFix}.`,
    };
  }

  if (Number.isFinite(options.outcomeStats.accuracy)
    && options.outcomeStats.accuracy < options.config.minAccuracyForAutoSpawn) {
    return {
      approved: false,
      reason: `Auto-spawn paused: observer accuracy ${options.outcomeStats.accuracy.toFixed(2)} below threshold ${options.config.minAccuracyForAutoSpawn.toFixed(2)}.`,
    };
  }

  const overlap = detectBranchOverlap(options.finding, options.remoteBranches);
  if (overlap) {
    return {
      approved: false,
      reason: `Potential duplicate in remote branch ${overlap}.`,
    };
  }

  return {
    approved: true,
    reason: 'approved-for-spawn',
  };
}

export async function listRemoteBranches(workspaceRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFile('git', ['branch', '-r', '--format=%(refname:short)'], {
      cwd: workspaceRoot,
    });

    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function meetsSeverityThreshold(current: FindingSeverity, minimum: FindingSeverity): boolean {
  return SEVERITY_RANK[current] >= SEVERITY_RANK[minimum];
}

function detectBranchOverlap(finding: FindingRecord, branchNames: string[]): string | null {
  if (branchNames.length === 0) {
    return null;
  }

  const titleTokens = finding.title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !STOP_WORDS.has(token));

  if (titleTokens.length === 0) {
    return null;
  }

  for (const branch of branchNames) {
    const branchText = branch.toLowerCase();
    let matches = 0;
    for (const token of titleTokens) {
      if (branchText.includes(token)) {
        matches += 1;
      }
      if (matches >= 2) {
        return branch;
      }
    }
  }

  return null;
}
