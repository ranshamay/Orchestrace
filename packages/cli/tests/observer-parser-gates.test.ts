import { describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@orchestrace/store';
import { analyzeSessionSummaries } from '../src/observer/analyzer.js';
import { DEFAULT_OBSERVER_CONFIG } from '../src/observer/types.js';
import { LogWatcher } from '../src/observer/log-watcher.js';
import { SessionObserver } from '../src/observer/session-observer.js';
import {
  OBSERVER_SYSTEM_PROMPT,
  REALTIME_OBSERVER_SYSTEM_PROMPT,
} from '../src/observer/prompts.js';

describe('observer prompt severity calibration', () => {
  it('classifies implementation-phase re-audit loops with no writes as high severity guidance', () => {
    expect(OBSERVER_SYSTEM_PROMPT).toContain('implementation-phase loops that repeatedly re-audit without code changes');
    expect(REALTIME_OBSERVER_SYSTEM_PROMPT).toContain('implementation-phase loops that repeatedly re-audit without code changes');
  });
});

describe('observer parser validation gates', () => {
  it('analyzer drops malformed findings and keeps only valid allowed-category entries', async () => {
    const llm = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({
          findings: [
            {
              category: 'invalid-category',
              severity: 'high',
              title: 'Should be dropped',
              description: 'Invalid category should be gated out',
              evidence: [{ text: 'do x' }],
            },
            {
              category: 'agent-efficiency',
              severity: 'high',
              title: '   ',
              description: 'blank title should be dropped',
              evidence: [{ text: 'do y' }],
            },
            {
              category: 'agent-efficiency',
              severity: 'high',
              title: 'No evidence or suggested fix',
              description: 'Should be dropped by candidate gate',
            },
            {
              category: 'agent-efficiency',
              severity: 'high',
              title: 'Implementation loop with no writes',
              description: 'Agent re-read files repeatedly without editing.',
              evidence: [{ text: 'Add parser guard and enforce write progression.' }],
              relevantFiles: ['  packages/cli/src/observer/analyzer.ts  '],
            },
          ],
        }),
      })),
    };

    const result = await analyzeSessionSummaries(
      llm as never,
      DEFAULT_OBSERVER_CONFIG,
            [
        {
          sessionId: 's1',
          config: {
            prompt: 'Analyze observer efficiency regressions',
            provider: 'github-copilot',
            model: 'gpt-5',
            workspacePath: '/tmp/ws',
            autoApprove: false,
          },
          status: 'completed',
          error: undefined,
          output: undefined,
          llmStatusHistory: [],
          dagEvents: [],
          toolCalls: [],
          agentGraph: [],
          todos: [],
          streamedText: '',
          totalEvents: 10,
          durationMs: 60_000,
        },
      ],
      undefined,
      async () => undefined,
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.category).toBe('agent-efficiency');
    expect(result.findings[0]?.title).toBe('Implementation loop with no writes');
    expect(result.findings[0]?.relevantFiles).toEqual(['packages/cli/src/observer/analyzer.ts']);
  });

  it('session observer emits findings only for valid realtime parser payloads', async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];

    const llm = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({
          findings: [
            {
              category: 'invalid-category',
              severity: 'high',
              title: 'Drop me',
              description: 'invalid category',
              evidence: [{ text: 'bad' }],
            },
            {
              category: 'agent-efficiency',
              severity: 'medium',
              title: 'Valid realtime finding',
              description: 'Repeated implementation audit loop without edits.',
              evidence: [{ text: 'Enforce parse gates before adding findings.' }],
            },
          ],
        }),
      })),
    };

    let watcherHandler: ((event: SessionEvent) => void) | null = null;
    const eventStore = {
      watch: (_sessionId: string, _fromSeq: number, handler: (event: SessionEvent) => void) => {
        watcherHandler = handler;
        return () => {
          watcherHandler = null;
        };
      },
    };

    const observer = new SessionObserver({
      sessionId: 's2',
      eventStore: eventStore as never,
      llm: llm as never,
      config: DEFAULT_OBSERVER_CONFIG,
      emit: (event) => emitted.push(event),
      resolveApiKey: async () => undefined,
    });

    observer.start();

    watcherHandler?.({
      type: 'session:created',
      time: '2026-01-01T00:00:00.000Z',
      seq: 1,
      sessionId: 's2',
      payload: {
        config: {
          prompt: 'test',
          provider: 'github-copilot',
          model: 'gpt-5',
        },
      },
    } as SessionEvent);

    watcherHandler?.({
      type: 'session:llm-status-change',
      time: '2026-01-01T00:00:01.000Z',
      seq: 2,
      sessionId: 's2',
      payload: {
        llmStatus: {
          state: 'implementing',
          phase: 'implementation',
        },
      },
    } as SessionEvent);

    watcherHandler?.({
      type: 'session:status-change',
      time: '2026-01-01T00:00:02.000Z',
      seq: 3,
      sessionId: 's2',
      payload: {
        status: 'completed',
      },
    } as SessionEvent);

    await vi.waitFor(() => {
      expect(emitted.some((event) => event.type === 'session:observer-finding')).toBe(true);
    });

    const findingEvents = emitted.filter((event) => event.type === 'session:observer-finding');
    expect(findingEvents).toHaveLength(1);
    const finding = findingEvents[0]?.payload.finding as { title: string; category: string };
    expect(finding.title).toBe('Valid realtime finding');
    expect(finding.category).toBe('agent-efficiency');

    observer.stop();
  });

  it('log watcher parser gate ignores malformed categories and accepts valid findings', async () => {
    let onLineHandler: ((line: string) => void) | null = null;
    const logger = {
      onLine(handler: (line: string) => void) {
        onLineHandler = handler;
        return () => {
          onLineHandler = null;
        };
      },
    };

    const watcher = new LogWatcher({
      llm: {
        complete: vi.fn(async () => ({
          text: JSON.stringify({
            findings: [
              {
                category: 'not-real',
                severity: 'high',
                title: 'Invalid category finding',
                description: 'should be dropped',
                suggestedFix: 'noop',
                logSnippet: 'x',
              },
              {
                category: 'error-pattern',
                severity: 'high',
                title: 'Tool error retry storm',
                description: 'Repeated observer parser failures in logs.',
                evidence: [{ text: 'Add parser schema validation guard.' }],
                logSnippet: 'task:tool-call [error] search_files',
              },
            ],
          }),
        })),
      } as never,
      config: DEFAULT_OBSERVER_CONFIG,
      logger: logger as never,
      resolveApiKey: async () => undefined,
      batchSize: 1,
      timeWindowMs: 60_000,
    });

    try {
      watcher.start(logger as never);
      onLineHandler?.('trigger batch');

      await vi.waitFor(() => {
        expect(watcher.getFindings().length).toBe(1);
      });

      expect(watcher.getFindings()[0]?.title).toBe('Tool error retry storm');
      expect(watcher.getFindings()[0]?.category).toBe('error-pattern');
    } finally {
      watcher.stop();
    }
  });
});