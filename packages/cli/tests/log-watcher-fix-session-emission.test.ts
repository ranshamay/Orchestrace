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
          title: 'Unsafe cross-session mutable state',
          description: 'Multiple sessions mutate a shared singleton without locks.',
          suggestedFix: 'Scope mutable state per session and guard shared writes with synchronization.',
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
          title: 'Unsafe cross-session mutable state',
          description: 'Multiple sessions mutate a shared singleton without locks.',
          suggestedFix: 'Scope mutable state per session and guard shared writes with synchronization.',
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
          title: 'Crash loop in API handler',
          description: 'Handler retries endlessly when upstream returns malformed payload.',
          suggestedFix: 'Add schema guard and stop retrying on non-retryable errors.',
          relevantFiles: ['packages/cli/src/ui-server.ts'],
        },
      ]);

      expect(first).toEqual({ registered: 1, spawned: 1 });
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(startSession.mock.calls[0]?.[0].source).toBe('observer');
      expect(startSession.mock.calls[0]?.[0].prompt).toContain('[Observer Fix] Crash loop in API handler');
      expect(startSession.mock.calls[0]?.[0].prompt).toContain('## Issue');
      expect(startSession.mock.calls[0]?.[0].prompt).toContain('\n## Task\n');
      expect(daemon.getFindings()[0]?.category).toBe('code-quality');

      const duplicate = await daemon.ingestLogWatcherFindings([
        {
          category: 'error-pattern',
          severity: 'high',
          title: 'Crash loop in API handler',
          description: 'Handler retries endlessly when upstream returns malformed payload.',
          suggestedFix: 'Add schema guard and stop retrying on non-retryable errors.',
        },
      ]);

      expect(duplicate).toEqual({ registered: 0, spawned: 0 });
      expect(startSession).toHaveBeenCalledTimes(1);

      const performance = await daemon.ingestLogWatcherFindings([
        {
          category: 'performance',
          severity: 'medium',
          title: 'Excessive log polling',
          description: 'Loop polls status endpoint too frequently under load.',
          suggestedFix: 'Back off polling frequency and debounce updates.',
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
            description: 'Service call times out repeatedly.',
            suggestedFix: 'Increase timeout guard and add jittered retry cap.',
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
            description: 'Old finding kept as spawned from a prior process.',
            suggestedFix: 'Historical fix',
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
          title: 'Fresh issue A',
          description: 'New issue A from current process.',
          suggestedFix: 'Fix issue A.',
        },
      ]);

      const second = await daemon.ingestLogWatcherFindings([
        {
          category: 'error-pattern',
          severity: 'high',
          title: 'Fresh issue B',
          description: 'New issue B from current process.',
          suggestedFix: 'Fix issue B.',
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
