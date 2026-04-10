import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

async function seedWorkspaceFiles(orchestraceDir: string, relativePaths: string[]): Promise<void> {
  const workspaceRoot = dirname(orchestraceDir);
  for (const relativePath of relativePaths) {
    const absolutePath = join(workspaceRoot, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(
      absolutePath,
      `// fixture: ${relativePath}\nexport const fixture = true;\n`,
      'utf-8',
    );
  }
}

function createVerifierLlmStub(): ObserverDaemonOptions['llm'] {
  return {
    complete: vi.fn(async (request: { prompt: unknown }) => {
      const promptText = typeof request.prompt === 'string' ? request.prompt : '';
      const matchedPath = promptText.match(/###\s+([^\n]+)/)?.[1]?.trim();
      const file = matchedPath && matchedPath.length > 0
        ? matchedPath
        : 'packages/cli/src/ui-server.ts';

      return {
        text: JSON.stringify({
          verified: true,
          reason: 'Issue confirmed against current source snapshot.',
          evidence: [
            {
              file,
              currentCode: 'const sharedState = globalThis.__sharedState;',
              problem: 'Shared mutable state can leak between sessions.',
              suggestedChange: 'Scope state per session and guard shared writes.',
            },
          ],
        }),
      };
    }),
  } as ObserverDaemonOptions['llm'];
}

describe('log watcher fix-session emission', () => {
  it('registers realtime session observer findings and spawns fix sessions', async () => {
    const orchestraceDir = await mkdtemp(join(tmpdir(), 'orchestrace-observer-'));

    try {
      await seedWorkspaceFiles(orchestraceDir, [
        'packages/cli/src/ui-server.ts',
        'packages/cli/src/observer/daemon.ts',
      ]);

      const startSession = vi.fn(async () => ({ id: `fix-${String(startSession.mock.calls.length + 1)}` }));
      const daemon = new ObserverDaemon({
        orchestraceDir,
        eventStore: createEventStoreStub(),
        llm: createVerifierLlmStub(),
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
          evidence: [],
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

      const duplicate = await daemon.ingestSessionObserverFindings('session-123', [
        {
          category: 'architecture',
          severity: 'high',
          title: 'Unsafe cross-session mutable state',
          description: 'Multiple sessions mutate a shared singleton without locks.',
          suggestedFix: 'Scope mutable state per session and guard shared writes with synchronization.',
          evidence: [],
        },
      ]);

      expect(duplicate).toEqual({ registered: 0, spawned: 0 });
      expect(startSession).toHaveBeenCalledTimes(1);

      const equivalentQueued = await daemon.ingestSessionObserverFindings('session-456', [
        {
          category: 'architecture',
          severity: 'critical',
          title: 'Unsafe cross session mutable state',
          description: 'Completely different wording for body should still merge by equivalent queue title.',
          suggestedFix: 'Apply synchronization and isolate state.',
          evidence: [],
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

  it('builds grounded fix prompt from verified evidence', async () => {
    const orchestraceDir = await mkdtemp(join(tmpdir(), 'orchestrace-observer-'));

    try {
      await seedWorkspaceFiles(orchestraceDir, ['packages/cli/src/observer/registry.ts']);

      const startSession = vi.fn(async () => ({ id: `fix-${String(startSession.mock.calls.length + 1)}` }));
      const daemon = new ObserverDaemon({
        orchestraceDir,
        eventStore: createEventStoreStub(),
        llm: createVerifierLlmStub(),
        startSession,
        resolveApiKey: async () => undefined,
      });

      await daemon.updateConfig({ enabled: true, maxConcurrentFixSessions: 0 });

      const result = await daemon.ingestSessionObserverFindings('session-v2', [
        {
          schemaVersion: '2',
          category: 'architecture',
          severity: 'high',
          title: 'Missing migration strategy for schema transition',
          description: 'Existing persisted records are not normalized before consumers read them.',
          evidence: [
            { text: 'Normalize legacy suggestedFix payloads into evidence[] at registry load time.' },
            { text: 'Stamp schemaVersion=2 before persistence and API emission.' },
          ],
          relevantFiles: ['packages/cli/src/observer/registry.ts'],
        },
      ]);

      expect(result).toEqual({ registered: 1, spawned: 1 });
      expect(startSession).toHaveBeenCalledTimes(1);
      const prompt = String(startSession.mock.calls[0]?.[0].prompt ?? '');
      expect(prompt).toContain('## Verified Evidence');
      expect(prompt).toContain('Suggested change:');
      expect(prompt).toContain('Issue already resolved');
    } finally {
      await rm(orchestraceDir, { recursive: true, force: true });
    }
  });

  it('registers log findings and spawns fix sessions immediately', async () => {
    const orchestraceDir = await mkdtemp(join(tmpdir(), 'orchestrace-observer-'));

    try {
      await seedWorkspaceFiles(orchestraceDir, ['packages/cli/src/ui-server.ts']);

      const startSession = vi.fn(async () => ({ id: `fix-${String(startSession.mock.calls.length + 1)}` }));
      const daemon = new ObserverDaemon({
        orchestraceDir,
        eventStore: createEventStoreStub(),
        llm: createVerifierLlmStub(),
        startSession,
        resolveApiKey: async () => undefined,
      });

      await daemon.updateConfig({
        enabled: true,
        maxConcurrentFixSessions: 0,
        minSeverityForAutoFix: 'medium',
      });

      const first = await daemon.ingestLogWatcherFindings([
        {
          category: 'error-pattern',
          severity: 'high',
          title: 'Crash loop in API handler',
          description: 'Handler retries endlessly when upstream returns malformed payload.',
          suggestedFix: 'Add schema guard and stop retrying on non-retryable errors.',
          evidence: [],
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
      expect(firstPrompt).toContain('## Verified Evidence');
      const shellValidation = validateShellExecutionPrompt(firstPrompt);
      expect(shellValidation.ok).toBe(false);
      expect(shellValidation.command).toBeUndefined();
      expect(daemon.getFindings()[0]?.category).toBe('code-quality');

      const duplicate = await daemon.ingestLogWatcherFindings([
        {
          category: 'error-pattern',
          severity: 'high',
          title: 'Crash loop in API handler',
          description: 'Handler retries endlessly when upstream returns malformed payload.',
          suggestedFix: 'Add schema guard and stop retrying on non-retryable errors.',
          evidence: [],
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
          evidence: [],
          relevantFiles: ['packages/cli/src/ui-server.ts'],
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
            evidence: [],
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

  it('parses runtime log-finding schema fields and legacy compatibility fallbacks', async () => {
    let onLineHandler: ((line: string) => void) | null = null;
    const logger = {
      onLine(handler: (line: string) => void) {
        onLineHandler = handler;
        return () => {
          onLineHandler = null;
        };
      },
    };

    const emitted: Array<{
      title: string;
      category: string;
      severity: string;
      suggestedFix?: string;
      evidence?: Array<{ text: string }>;
      relevantFiles?: string[];
      logSnippet: string;
      detectedAt: string;
    }> = [];

    const watcher = new LogWatcher({
      llm: {
        complete: vi.fn(async () => ({
          text: JSON.stringify({
            findings: [
              {
                category: 'performance',
                severity: 'high',
                title: 'Legacy issueSummary finding',
                description: 'Legacy fields should still map into watcher output.',
                issueSummary: 'Fallback to issueSummary while rollout is in progress.',
                evidence: [
                  { text: 'Throttle repeated watcher analysis invocations.' },
                  { text: 'Persist schemaVersion=2-compatible evidence payloads.' },
                ],
                relevantFiles: ['packages/cli/src/observer/log-watcher.ts'],
                logSnippet: 'poll loop exceeded expected frequency',
              },
            ],
          }),
        })),
      } as LogWatcherOptions['llm'],
      config: DEFAULT_OBSERVER_CONFIG,
      logger: logger as LogWatcherOptions['logger'],
      resolveApiKey: async () => undefined,
      batchSize: 1,
      timeWindowMs: 60_000,
      onFindings: (findings) => {
        emitted.push(...findings.map((finding) => ({
          title: finding.title,
          category: finding.category,
          severity: finding.severity,
          suggestedFix: finding.suggestedFix,
          evidence: finding.evidence,
          relevantFiles: finding.relevantFiles,
          logSnippet: finding.logSnippet,
          detectedAt: finding.detectedAt,
        })));
      },
    });

    try {
      watcher.start(logger as LogWatcherOptions['logger']);
      onLineHandler?.('trigger parsing');

      await vi.waitFor(() => {
        expect(emitted).toHaveLength(1);
      });

      expect(emitted[0]).toEqual(expect.objectContaining({
        title: 'Legacy issueSummary finding',
        category: 'performance',
        severity: 'high',
        suggestedFix: 'Fallback to issueSummary while rollout is in progress.',
        evidence: [
          { text: 'Throttle repeated watcher analysis invocations.' },
          { text: 'Persist schemaVersion=2-compatible evidence payloads.' },
        ],
        relevantFiles: ['packages/cli/src/observer/log-watcher.ts'],
        logSnippet: 'poll loop exceeded expected frequency',
      }));
      expect(emitted[0]?.detectedAt).toBeTypeOf('string');
    } finally {
      watcher.stop();
    }
  });


  it('does not merge into completed findings when matching equivalent tasks', async () => {
    const orchestraceDir = await mkdtemp(join(tmpdir(), 'orchestrace-observer-'));

    try {
      await seedWorkspaceFiles(orchestraceDir, ['packages/cli/src/observer/daemon.ts']);

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
            description: 'Old equivalent finding already completed.',
            issueSummary: 'Historical fix',
            evidence: [],
            relevantFiles: ['packages/cli/src/observer/daemon.ts'],
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
        llm: createVerifierLlmStub(),
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
          description: 'Fresh finding should become a new queued task because prior one is completed.',
          suggestedFix: 'Apply synchronization and isolate state.',
          evidence: [],
          relevantFiles: ['packages/cli/src/observer/daemon.ts'],
        },
      ]);

      expect(created).toEqual({ registered: 1, spawned: 1 });
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(daemon.getFindings()).toHaveLength(2);
      const historical = daemon.getFindings().find((f) => f.fingerprint === 'completed-finding-1');
      expect(historical?.schemaVersion).toBe('2');
      expect(historical?.evidence?.[0]?.text).toBe('Historical fix');
    } finally {
      await rm(orchestraceDir, { recursive: true, force: true });
    }
  });

  it('does not count historical spawned findings against current process concurrency', async () => {
    const orchestraceDir = await mkdtemp(join(tmpdir(), 'orchestrace-observer-'));

    try {
      await seedWorkspaceFiles(orchestraceDir, ['packages/cli/src/ui-server.ts']);

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
            issueSummary: 'Historical fix',
            evidence: [],
            relevantFiles: ['packages/cli/src/ui-server.ts'],
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
        llm: createVerifierLlmStub(),
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
          evidence: [],
          relevantFiles: ['packages/cli/src/ui-server.ts'],
        },
      ]);

      const second = await daemon.ingestLogWatcherFindings([
        {
          category: 'error-pattern',
          severity: 'high',
          title: 'Fresh issue B',
          description: 'New issue B from current process.',
          suggestedFix: 'Fix issue B.',
          evidence: [],
          relevantFiles: ['packages/cli/src/ui-server.ts'],
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
