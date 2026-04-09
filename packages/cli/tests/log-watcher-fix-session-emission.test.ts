import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EventStore } from '@orchestrace/store';
import { DEFAULT_OBSERVER_CONFIG } from '../src/observer/types.js';
import { ObserverDaemon } from '../src/observer/daemon.js';
import { LogWatcher } from '../src/observer/log-watcher.js';

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
        llm: { complete: vi.fn() } as unknown as any,
        startSession,
        resolveApiKey: async () => undefined,
      });

      await daemon.updateConfig({ enabled: true, maxConcurrentFixSessions: 0 });

      const first = await daemon.ingestSessionObserverFindings('session-123', [
        {
          category: 'architecture',
          severity: 'high',
          severityRationale: 'Repeated unsafe mutations can cause sustained user-visible failures.',
          title: 'Unsafe cross-session mutable state',
          issueSummary: 'Multiple sessions mutate a shared singleton without locks.',
          evidence: ['Multiple sessions mutate shared singleton', 'No synchronization observed in trace'],
          relevantFiles: ['packages/cli/src/ui-server.ts'],
        },
      ]);

      expect(first).toEqual({ registered: 1, spawned: 1 });
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(startSession.mock.calls[0]?.[0].source).toBe('observer');
      expect(startSession.mock.calls[0]?.[0].prompt).toContain('[Observer Fix] Unsafe cross-session mutable state');

      const duplicate = await daemon.ingestSessionObserverFindings('session-123', [
        {
          category: 'architecture',
          severity: 'high',
          severityRationale: 'Repeated unsafe mutations can cause sustained user-visible failures.',
          title: 'Unsafe cross-session mutable state',
          issueSummary: 'Multiple sessions mutate a shared singleton without locks.',
          evidence: ['Multiple sessions mutate shared singleton', 'No synchronization observed in trace'],
        },
      ]);

      expect(duplicate).toEqual({ registered: 0, spawned: 0 });
      expect(startSession).toHaveBeenCalledTimes(1);
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
        llm: { complete: vi.fn() } as unknown as any,
        startSession,
        resolveApiKey: async () => undefined,
      });

      await daemon.updateConfig({ enabled: true, maxConcurrentFixSessions: 0 });

      const first = await daemon.ingestLogWatcherFindings([
        {
          category: 'error-pattern',
          severity: 'high',
          severityRationale: 'Repeated crash loops break request handling for users.',
          title: 'Crash loop in API handler',
          issueSummary: 'Handler retries endlessly when upstream returns malformed payload.',
          evidence: ['Malformed payload appears repeatedly', 'Retries continue after non-retryable parse failures'],
          relevantFiles: ['packages/cli/src/ui-server.ts'],
        },
      ]);

      expect(first).toEqual({ registered: 1, spawned: 1 });
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(startSession.mock.calls[0]?.[0].source).toBe('observer');
      expect(startSession.mock.calls[0]?.[0].prompt).toContain('[Observer Fix] Crash loop in API handler');
      expect(startSession.mock.calls[0]?.[0].prompt).toContain('## Issue Summary');
      expect(startSession.mock.calls[0]?.[0].prompt).toContain('\n## Evidence\n');
      expect(daemon.getFindings()[0]?.category).toBe('code-quality');

      const duplicate = await daemon.ingestLogWatcherFindings([
        {
          category: 'error-pattern',
          severity: 'high',
          severityRationale: 'Repeated crash loops break request handling for users.',
          title: 'Crash loop in API handler',
          issueSummary: 'Handler retries endlessly when upstream returns malformed payload.',
          evidence: ['Malformed payload appears repeatedly', 'Retries continue after non-retryable parse failures'],
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
          evidence: ['Status endpoint polled in tight loop', 'Load spikes correlate with polling bursts'],
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
            severityRationale: 'Repeated timeout pattern causes sustained request failures.',
            title: 'Repeated timeout',
            issueSummary: 'Service call times out repeatedly.',
            evidence: ['timeout after 30000ms appears repeatedly', 'Retries cluster without jitter'],
            logSnippet: 'timeout after 30000ms',
          },
        ],
      }),
    }));

    const emitted: string[] = [];
    const watcher = new LogWatcher({
      llm: { complete } as unknown as any,
      config: DEFAULT_OBSERVER_CONFIG,
      logger: logger as unknown as any,
      resolveApiKey: async () => undefined,
      batchSize: 1,
      timeWindowMs: 60_000,
      onFindings: (findings) => {
        emitted.push(...findings.map((finding) => finding.title));
      },
    });

    try {
      watcher.start(logger as unknown as any);
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
            evidence: ['Historical evidence item 1', 'Historical evidence item 2'],
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
        llm: { complete: vi.fn() } as unknown as any,
        startSession,
        resolveApiKey: async () => undefined,
      });

      await daemon.start();
      await daemon.updateConfig({ maxConcurrentFixSessions: 2 });

      const first = await daemon.ingestLogWatcherFindings([
        {
          category: 'error-pattern',
          severity: 'high',
          severityRationale: 'Recurring issue affects live request handling.',
          title: 'Fresh issue A',
          issueSummary: 'New issue A from current process.',
          evidence: ['Issue A evidence item 1', 'Issue A evidence item 2'],
        },
      ]);

      const second = await daemon.ingestLogWatcherFindings([
        {
          category: 'error-pattern',
          severity: 'high',
          severityRationale: 'Recurring issue affects live request handling.',
          title: 'Fresh issue B',
          issueSummary: 'New issue B from current process.',
          evidence: ['Issue B evidence item 1', 'Issue B evidence item 2'],
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
