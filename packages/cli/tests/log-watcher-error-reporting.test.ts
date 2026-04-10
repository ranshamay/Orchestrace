import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_OBSERVER_CONFIG } from '../src/observer/types.js';
import { LogWatcher, type LogWatcherRuntimeError } from '../src/observer/log-watcher.js';

type LogWatcherOptions = ConstructorParameters<typeof LogWatcher>[0];

describe('log watcher runtime error reporting', () => {
  it('emits structured analyze-batch errors through onError', async () => {
    let onLineHandler: ((line: string) => void) | null = null;
    const logger = {
      onLine(handler: (line: string) => void) {
        onLineHandler = handler;
        return () => {
          onLineHandler = null;
        };
      },
    };

    const errors: LogWatcherRuntimeError[] = [];

    const watcher = new LogWatcher({
      llm: {
        complete: vi.fn(async () => {
          throw new Error('analysis exploded');
        }),
      } as LogWatcherOptions['llm'],
      config: DEFAULT_OBSERVER_CONFIG,
      logger: logger as LogWatcherOptions['logger'],
      resolveApiKey: async () => undefined,
      batchSize: 1,
      timeWindowMs: 60_000,
      onError: (error) => {
        errors.push(error);
      },
    });

    try {
      watcher.start(logger as LogWatcherOptions['logger']);
      onLineHandler?.('trigger line');

      await vi.waitFor(() => {
        expect(errors.length).toBeGreaterThanOrEqual(1);
      });

      expect(errors[0]).toEqual(expect.objectContaining({
        source: 'log-watcher',
        operation: 'analyze-batch',
        message: 'analysis exploded',
      }));
      expect(errors[0]?.timestamp).toBeTypeOf('string');
    } finally {
      watcher.stop();
    }
  });

  it('emits structured emit-findings errors when onFindings callback fails', async () => {
    let onLineHandler: ((line: string) => void) | null = null;
    const logger = {
      onLine(handler: (line: string) => void) {
        onLineHandler = handler;
        return () => {
          onLineHandler = null;
        };
      },
    };

    const errors: LogWatcherRuntimeError[] = [];

    const watcher = new LogWatcher({
      llm: {
        complete: vi.fn(async () => ({
          text: JSON.stringify({
            findings: [
              {
                category: 'error-pattern',
                severity: 'high',
                title: 'Tool failure surfaced',
                description: 'A tool failed during analysis',
                suggestedFix: 'Handle tool error path and report upstream',
                logSnippet: 'task:tool-call [error] search_files',
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
      onFindings: async () => {
        throw new Error('ingestion callback failed');
      },
      onError: (error) => {
        errors.push(error);
      },
    });

    try {
      watcher.start(logger as LogWatcherOptions['logger']);
      onLineHandler?.('trigger finding');

      await vi.waitFor(() => {
        expect(errors.find((item) => item.operation === 'emit-findings')).toBeTruthy();
      });

      const callbackError = errors.find((item) => item.operation === 'emit-findings');
      expect(callbackError).toEqual(expect.objectContaining({
        source: 'log-watcher',
        operation: 'emit-findings',
        message: 'ingestion callback failed',
      }));
      expect(callbackError?.context).toEqual(expect.objectContaining({
        findingsCount: 1,
      }));
    } finally {
      watcher.stop();
    }
  });
});