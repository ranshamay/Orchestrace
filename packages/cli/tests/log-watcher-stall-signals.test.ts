import { describe, expect, it, vi } from 'vitest';
import { LogWatcher } from '../src/observer/log-watcher.js';
import { DEFAULT_OBSERVER_CONFIG } from '../src/observer/types.js';

type LogWatcherOptions = ConstructorParameters<typeof LogWatcher>[0];

describe('log watcher stall signals', () => {
  it('adds observer stall metrics to analysis prompt for discovery-heavy batches', async () => {
    let onLineHandler: ((line: string) => void) | null = null;
    const logger = {
      onLine(handler: (line: string) => void) {
        onLineHandler = handler;
        return () => {
          onLineHandler = null;
        };
      },
    };

    let capturedPrompt = '';
    const watcher = new LogWatcher({
      llm: {
        complete: vi.fn(async (request: { prompt?: string }) => {
          capturedPrompt = String(request.prompt ?? '');
          return { text: JSON.stringify({ findings: [] }) };
        }),
      } as LogWatcherOptions['llm'],
      config: DEFAULT_OBSERVER_CONFIG,
      logger: logger as LogWatcherOptions['logger'],
      resolveApiKey: async () => undefined,
      batchSize: 20,
      timeWindowMs: 60_000,
    });

    try {
      watcher.start(logger as LogWatcherOptions['logger']);

      for (let i = 0; i < 20; i += 1) {
        onLineHandler?.(`Tool read_file input {\"path\":\"file-${i}.ts\"}`);
      }

      await vi.waitFor(() => {
        expect(capturedPrompt).toContain('Observer Stall Signals:');
      });

      expect(capturedPrompt).toContain('discoveryCalls=20');
      expect(capturedPrompt).toContain('writeCalls=0');
      expect(capturedPrompt).toContain('possibleStall=yes');
    } finally {
      watcher.stop();
    }
  });
});