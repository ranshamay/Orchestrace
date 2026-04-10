import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EventStore } from '@orchestrace/store';
import { DEFAULT_OBSERVER_CONFIG } from '../src/observer/types.js';
import { ObserverDaemon } from '../src/observer/daemon.js';
import { LogWatcher } from '../src/observer/log-watcher.js';
import { validateShellExecutionPrompt } from '../src/task-routing.js';

type ObserverDaemonOptions = ConstructorParameters<typeof ObserverDaemon>[0];
type LogWatcherOptions = ConstructorParameters<typeof LogWatcher>[0];

function createEventStoreStub(): EventStore {
  return {
    append: async () => 0,
    appendBatch: async () => 0,
    read: async () => [],
    watch: () => () => {},
    triggerPoll: () => {},
    listSessions: async () => [],
    getMetadata: async () => null,
    setMetadata: async () => {},
    deleteSession: async () => {},
  };
}

describe('log watcher fix-session emission', () => {
    it('registers realtime session observer findings and spawns fix sessions', async () => {
    const orchestraceDir = await mkdtemp(join(tmpdir(), 'orchestrace-observer-'));

    try {
      const startSession = vi.fn(async () => ({ id: `fix-${String(startSession.mock.calls.length + 1)}` }));
      const daemon = new ObserverDaemon({
        orchestraceDir,
        eventStore: createEventStoreStub(),
        llm: { complete: vi.fn() } as ObserverDaemonOptions['llm'],
        startSession,
        resolveApiKey: async () => undefined,
      });

      await daemon.updateConfig({ enabled: true, maxConcurrentFixSessions: 0 });

      const first = await daemon.ingestSessionObserverFindings('session-123', [
        {
          category: 'architecture',
          severity: 'high',
          title: 'Unsafe cross-session mutable state',
          issueSummary: 'Multiple sessions mutate a shared singleton without locks.',
                    severityRationale: 'Concurrent mutable state can corrupt cross-session behavior and cause hard-to-reproduce failures.',
          evidence: [
            'Singleton state is shared across sessions.',
            'No synchronization guards concurrent writes.',
          ],
          relevantFiles: ['packages/cli/src/ui-server.ts'],
        },
      ]);

      expect(first).toEqual({ registered: 1, spawned: 1 });
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(startSession.mock.calls[0]?.[0].source).toBe('observer');
      expect(startSession.mock.calls[0]?.[0].prompt).toContain('[Observer Fix] Unsafe cross-session mutable state');
      const sessionRequest = startSession.mock.calls[0]?.[0];
      expect(sessionRequest?.routingAuditContext).toEqual(expect.objectContaining({
        eventType: 'observer_fix_prompt_conversion',
        findingTitle: 'Unsafe cross-session mutable state',
        findingCategory: 'architecture',
        findingSeverity: 'high',
        routeIntent: 'code_change',
      }));
      expect(sessionRequest?.routingAuditContext?.reason).toContain('Observer finding converted');
      expect(sessionRequest?.routingAuditContext?.promptCharLength).toBeGreaterThan(0);

      const duplicate = await daemon.ingestSessionObserverFindings('session-123', [
        {
          category: 'architecture',
          severity: 'high',
          title: 'Unsafe cross-session mutable state',
          issueSummary: 'Multiple sessions mutate a shared singleton without locks.',
                    severityRationale: 'Concurrent mutable state can corrupt cross-session behavior and cause hard-to-reproduce failures.',
          evidence: [
            'Duplicate report confirms the same unsafe shared state pattern.',
            'No lock/ownership boundary is described for writes.',
          ],
        },
      ]);

      expect(duplicate).toEqual({ registered: 0, spawned: 0 });
      expect(startSession).toHaveBeenCalledTimes(1);

      const equivalentQueued = await daemon.ingestSessionObserverFindings('session-456', [
        {
          category: 'architecture',
          severity: 'critical',
          title: 'Unsafe cross session mutable state',
          issueSummary: 'Completely different wording for body should still merge by equivalent queue title.',
                    severityRationale: 'Equivalent architecture hazard remains severe and warrants immediate remediation.',
          evidence: [
            'Equivalent title indicates the same shared-state defect class.',
            'Severity escalates because impact can affect multiple active sessions.',
          ],
          relevantFiles: ['packages/cli/src/observer/daemon.ts'],
        },
      ]);

      expect(equivalentQueued).toEqual({ registered: 0, spawned: 0 });
      expect(startSession).toHaveBeenCalledTimes(1);
      const findings = daemon.getFindings();
      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe('critical');
      expect(findings[0]?.additionalSessions).toContain('session-456');
      expect(findings[0]?.relevantFiles).toEqual(expect.arrayContaining([
        'packages/cli/src/ui-server.ts',
        'packages/cli/src/observer/daemon.ts',
      ]));
    } finally {
      await rm(orchestraceDir, { recursive: true, force: true });
    }
  });


  it('registers log findings and spawns fix sessions immediately', async () => {
    const orchestraceDir = await mkdtemp(join(tmpdir(), 'orchestrace-observer-'));

    try {
      const startSession = vi.fn(async () => ({ id: `fix-${String(startSession.mock.calls.length + 1)}` }));
      const daemon = new ObserverDaemon({
        orchestraceDir,
        eventStore: createEventStoreStub(),
        llm: { complete: vi.fn() } as ObserverDaemonOptions['llm'],
        startSession,
        resolveApiKey: async () => undefined,
      });

      await daemon.updateConfig({ enabled: true, maxConcurrentFixSessions: 0 });

      const first = await daemon.ingestLogWatcherFindings([
        {
          category: 'error-pattern',
          severity: 'high',
          title: 'Crash loop in API handler',
          issueSummary: 'Handler retries endlessly when upstream returns malformed payload.',
                    severityRationale: 'Unbounded retries can degrade service availability and amplify failure cascades.',
          evidence: [
            'Malformed upstream payload is retried repeatedly.',
            'Retry loop keeps handler active instead of failing fast.',
          ],
          relevantFiles: ['packages/cli/src/ui-server.ts'],
        },
      ]);

      expect(first).toEqual({ registered: 1, spawned: 1 });
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(startSession.mock.calls[0]?.[0].source).toBe('observer');
      const firstRequest = startSession.mock.calls[0]?.[0];
      const firstPrompt = firstRequest?.prompt ?? '';
      expect(firstPrompt).toContain('[Observer Fix] Crash loop in API handler');
      expect(firstRequest?.routingAuditContext).toEqual(expect.objectContaining({
        eventType: 'observer_fix_prompt_conversion',
        findingTitle: 'Crash loop in API handler',
        findingCategory: 'code-quality',
        findingSeverity: 'high',
        routeIntent: 'code_change',
      }));
            expect(firstPrompt).toContain('## Issue');
      expect(firstPrompt).toContain('\n## Evidence\n');
      expect(firstPrompt).toContain('\n## Severity Rationale\n');
      const shellValidation = validateShellExecutionPrompt(firstPrompt);
      expect(shellValidation.ok).toBe(false);
      expect(shellValidation.command).toBeUndefined();
      expect(daemon.getFindings()[0]?.category).toBe('code-quality');

      const duplicate = await daemon.ingestLogWatcherFindings([
        {
          category: 'error-pattern',
          severity: 'high',
          title: 'Crash loop in API handler',
          issueSummary: 'Handler retries endlessly when upstream returns malformed payload.',
                    severityRationale: 'Unbounded retries can degrade service availability and amplify failure cascades.',
          evidence: [
            'Same crash-loop signature appears again.',
            'Non-retryable malformed payload continues to trigger retries.',
          ],
        },
      ]);

      expect(duplicate).toEqual({ registered: 0, spawned: 0 });
      expect(startSession).toHaveBeenCalledTimes(1);

      const performance = await daemon.ingestLogWatcherFindings([
        {
          category: 'performance',
          severity: 'medium',
          title: 'Excessive log polling',
          issueSummary: 'Loop polls status endpoint too frequently under load.',
                    severityRationale: 'Excessive polling can increase system load and reduce responsiveness under traffic spikes.',
          evidence: [
            'Status endpoint is polled too frequently under load.',
            'Polling cadence lacks backoff/debouncing protections.',
          ],
        },
      ]);

      expect(performance).toEqual({ registered: 1, spawned: 1 });
      expect(startSession).toHaveBeenCalledTimes(2);
      const perfFinding = daemon.getFindings().find((finding) => finding.title === 'Excessive log polling');
      expect(perfFinding?.category).toBe('performance');
    } finally {
      await rm(orchestraceDir, { recursive: true, force: true });
    }
  });

  it('emits only newly detected findings from log watcher batches', async () => {
    let onLineHandler: ((line: string) => void) | null = null;
    const logger = {
      onLine(handler: (line: string) => void) {
        onLineHandler = handler;
        return () => {
          onLineHandler = null;
        };
      },
    };

    const complete = vi.fn(async () => ({
      text: JSON.stringify({
        findings: [
          {
            category: 'error-pattern',
            severity: 'high',
            title: 'Repeated timeout',
            issueSummary: 'Service call times out repeatedly.',
                        severityRationale: 'Repeated timeout pattern indicates a high-impact reliability issue affecting request success.',
            evidence: [
              'Log line shows timeout after 30000ms.',
              'Timeouts recur in the analyzed batch.',
            ],
            logSnippet: 'timeout after 30000ms',
          },
        ],
      }),
    }));

    const emitted: string[] = [];
    const watcher = new LogWatcher({
      llm: { complete } as LogWatcherOptions['llm'],
      config: DEFAULT_OBSERVER_CONFIG,
      logger: logger as LogWatcherOptions['logger'],
      resolveApiKey: async () => undefined,
      batchSize: 1,
      timeWindowMs: 60_000,
      onFindings: (findings) => {
        emitted.push(...findings.map((finding) => finding.title));
      },
    });

    try {
      watcher.start(logger as LogWatcherOptions['logger']);
      onLineHandler?.('first line');
      await vi.waitFor(() => {
        expect(emitted).toEqual(['Repeated timeout']);
      });

      onLineHandler?.('second line');
      await vi.waitFor(() => {
        expect(complete).toHaveBeenCalledTimes(2);
      });
      expect(emitted).toEqual(['Repeated timeout']);
    } finally {
      watcher.stop();
    }
  });

    it('does not merge into completed findings when matching equivalent tasks', async () => {
    const orchestraceDir = await mkdtemp(join(tmpdir(), 'orchestrace-observer-'));

    try {
      const observerDir = join(orchestraceDir, 'observer');
      await mkdir(observerDir, { recursive: true });
      await writeFile(
        join(observerDir, 'findings.json'),
        JSON.stringify([
          {
            fingerprint: 'completed-finding-1',
            category: 'architecture',
            severity: 'medium',
            title: 'Unsafe cross-session mutable state',
            issueSummary: 'Old equivalent finding already completed.',
                        severityRationale: 'Historical fix',
            evidence: [
              'Historical completed record should remain immutable.',
              'Equivalent new finding must not merge into completed status.',
            ],
            observedInSessions: ['legacy-session'],
            detectedAt: new Date().toISOString(),
            fixSessionId: 'legacy-fix-session',
            fixStatus: 'completed',
            additionalSessions: [],
          },
        ], null, 2),
        'utf-8',
      );

      const startSession = vi.fn(async () => ({ id: `fix-${String(startSession.mock.calls.length + 1)}` }));
      const daemon = new ObserverDaemon({
        orchestraceDir,
        eventStore: createEventStoreStub(),
        llm: { complete: vi.fn() } as ObserverDaemonOptions['llm'],
        startSession,
        resolveApiKey: async () => undefined,
      });

      await daemon.start();
      await daemon.updateConfig({ maxConcurrentFixSessions: 0 });

      const created = await daemon.ingestSessionObserverFindings('fresh-session', [
        {
          category: 'architecture',
          severity: 'high',
          title: 'Unsafe cross session mutable state',
          issueSummary: 'Fresh finding should become a new queued task because prior one is completed.',
                    severityRationale: 'New equivalent issue is still high-impact and should trigger a fresh remediation task.',
          evidence: [
            'Equivalent title to prior finding indicates recurring defect class.',
            'Prior finding is completed, so new occurrence must be tracked separately.',
          ],
        },
      ]);

      expect(created).toEqual({ registered: 1, spawned: 1 });
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(daemon.getFindings()).toHaveLength(2);
    } finally {
      await rm(orchestraceDir, { recursive: true, force: true });
    }
  });

  it('does not count historical spawned findings against current process concurrency', async () => {

    const orchestraceDir = await mkdtemp(join(tmpdir(), 'orchestrace-observer-'));

    try {
      const observerDir = join(orchestraceDir, 'observer');
      await mkdir(observerDir, { recursive: true });
      await writeFile(
        join(observerDir, 'findings.json'),
        JSON.stringify([
          {
            fingerprint: 'historical-finding-1',
            category: 'code-quality',
            severity: 'medium',
            title: 'Historical spawned finding',
            issueSummary: 'Old finding kept as spawned from a prior process.',
                        severityRationale: 'Historical fix',
            evidence: [
              'Historical spawned finding originated in a prior daemon process.',
              'Historical spawned entries should not consume current-process concurrency slots.',
            ],
            observedInSessions: ['legacy-session'],
            detectedAt: new Date().toISOString(),
            fixSessionId: 'legacy-fix-session',
            fixStatus: 'spawned',
            additionalSessions: [],
          },
        ], null, 2),
        'utf-8',
      );

      const startSession = vi.fn(async () => ({ id: `fix-${String(startSession.mock.calls.length + 1)}` }));
      const daemon = new ObserverDaemon({
        orchestraceDir,
        eventStore: createEventStoreStub(),
        llm: { complete: vi.fn() } as ObserverDaemonOptions['llm'],
        startSession,
        resolveApiKey: async () => undefined,
      });

      await daemon.start();
      await daemon.updateConfig({ maxConcurrentFixSessions: 2 });

      const first = await daemon.ingestLogWatcherFindings([
        {
          category: 'error-pattern',
          severity: 'high',
          title: 'Fresh issue A',
          issueSummary: 'New issue A from current process.',
                    severityRationale: 'Fresh high-severity issue should consume one current-process concurrency slot.',
          evidence: [
            'Issue A is newly ingested in this process.',
            'No prior deduplicated finding matches issue A.',
          ],
        },
      ]);

      const second = await daemon.ingestLogWatcherFindings([
        {
          category: 'error-pattern',
          severity: 'high',
          title: 'Fresh issue B',
          issueSummary: 'New issue B from current process.',
                    severityRationale: 'Second fresh high-severity issue should still spawn under configured concurrency.',
          evidence: [
            'Issue B is distinct from issue A.',
            'Historical spawned record should not block second current spawn.',
          ],
        },
      ]);

      expect(first).toEqual({ registered: 1, spawned: 1 });
      expect(second).toEqual({ registered: 1, spawned: 1 });
      expect(startSession).toHaveBeenCalledTimes(2);
    } finally {
      await rm(orchestraceDir, { recursive: true, force: true });
    }
  });
});
