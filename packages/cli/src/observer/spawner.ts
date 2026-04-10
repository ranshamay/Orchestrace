// ---------------------------------------------------------------------------
// Observer — Fix Session Spawner
// ---------------------------------------------------------------------------
// Creates new Orchestrace sessions from observer findings, using the same
// session creation pipeline as the UI server.
// ---------------------------------------------------------------------------

import type { FindingRecord, ObserverConfig } from './types.js';
import type { FindingRegistry } from './registry.js';

/** The subset of startWorkSession that the observer needs. */
export type StartSessionFn = (request: {
  workspaceId?: string;
  prompt: unknown;
  provider: string;
  model: string;
  autoApprove: boolean;
  creationReason?: 'start' | 'retry';
  sourceSessionId?: string;
  source?: 'user' | 'observer';
  routingAuditContext?: {
    eventType: 'observer_fix_prompt_conversion';
    findingFingerprint: string;
    findingTitle: string;
    findingCategory: string;
    findingSeverity: string;
    observedSessionCount: number;
    relevantFileCount: number;
    promptCharLength: number;
    routeIntent: 'code_change';
    reason: string;
  };
}) => Promise<
  { id: string }
  | { error: string; statusCode: number; code?: string; details?: Record<string, unknown> }
>;

/**
 * Spawn fix sessions for all pending findings, respecting maxConcurrentFixSessions.
 * @param activeFixSessionCount - number of observer fix sessions currently in progress
 * Returns the number of sessions successfully spawned.
 */
export async function spawnFixSessions(
  registry: FindingRegistry,
  config: ObserverConfig,
  startSession: StartSessionFn,
  activeFixSessionCount = 0,
  ignoreLimit = false,
): Promise<number> {
  const pending = registry.getPending();
  const limit = ignoreLimit
    ? Infinity
    : (config.maxConcurrentFixSessions > 0 ? config.maxConcurrentFixSessions : Infinity);
  const canSpawn = Math.max(0, limit - activeFixSessionCount);
  if (canSpawn === 0) return 0;

  const toSpawn = ignoreLimit ? pending : pending.slice(0, canSpawn);
  let spawned = 0;

  for (const finding of toSpawn) {
    const sessionId = await spawnFixSession(finding, config, startSession);
    if (sessionId) {
      registry.markSpawned(finding.fingerprint, sessionId);
      spawned++;
    }
  }

  if (spawned > 0) {
    await registry.save();
  }

  return spawned;
}

async function spawnFixSession(
  finding: FindingRecord,
  config: ObserverConfig,
  startSession: StartSessionFn,
): Promise<string | null> {
  const prompt = buildFixPrompt(finding);

  try {
    const result = await startSession({
      prompt,
      provider: config.fixProvider,
      model: config.fixModel,
      autoApprove: config.fixAutoApprove,
      creationReason: 'start',
      source: 'observer',
      routingAuditContext: {
        eventType: 'observer_fix_prompt_conversion',
        findingFingerprint: finding.fingerprint,
        findingTitle: finding.title,
        findingCategory: finding.category,
        findingSeverity: finding.severity,
        observedSessionCount: finding.observedInSessions.length + finding.additionalSessions.length,
        relevantFileCount: finding.relevantFiles?.length ?? 0,
        promptCharLength: prompt.length,
        routeIntent: 'code_change',
        reason: 'Observer finding converted into implementation prompt; forcing observer source and planning pipeline intent.',
      },
    });

    if ('error' in result) {
      console.error(
        `[orchestrace][observer] Failed to spawn fix session for "${finding.title}": ${result.error}`,
      );
      return null;
    }

    console.log(
      `[orchestrace][observer] Spawned fix session ${result.id} for "${finding.title}"`,
    );
    return result.id;
  } catch (err) {
    console.error(`[orchestrace][observer] Error spawning fix session:`, err);
    return null;
  }
}

function buildFixPrompt(finding: FindingRecord): string {
  const parts: string[] = [];

  parts.push(`[Observer Fix] ${finding.title}`);
  parts.push('');
  parts.push(`Category: ${finding.category} | Severity: ${finding.severity}`);
  parts.push('');
  parts.push('## Issue');
  parts.push(finding.description);
  parts.push('');
    parts.push('## Task');
  parts.push(finding.issueSummary);

  if (finding.evidence && finding.evidence.length > 0) {
    parts.push('');
    parts.push('## Evidence');
    for (const item of finding.evidence) {
      parts.push(`- ${item}`);
    }
  }

  if (finding.relevantFiles && finding.relevantFiles.length > 0) {
    parts.push('');
    parts.push('## Relevant Files');
    for (const f of finding.relevantFiles) {
      parts.push(`- ${f}`);
    }
  }

  parts.push('');
  parts.push(
    `(This task was automatically created by the Orchestrace observer agent based on analysis of ${finding.observedInSessions.length + finding.additionalSessions.length} session(s).)`,
  );

  return parts.join('\n');
}
