import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BackendLogger } from '../src/observer/backend-logger.js';
import { LOG_REDACTION_MARKERS } from '../src/runner/log-sanitizer.js';

describe('backend logger sanitization', () => {
  it('sanitizes runner lines before persistence and listener fan-out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orchestrace-backend-log-'));
    const logger = new BackendLogger({ orchestraceDir: root });
    const received: string[] = [];

    try {
      logger.start();
      logger.onLine((line) => received.push(line));

      const secret = 'ghp_123456789012345678901234567890123456';
      const line = JSON.stringify({
        prompt: 'full prompt body should never be logged',
        fileSnippets: [{ path: 'src/x.ts', content: 'TOP-SECRET-FILE-CONTENT' }],
        token: secret,
        toolName: 'read_file',
      });

      logger.appendRunnerLine('session-1', 'stdout', line);
      logger.appendRunnerLine('session-1', 'stderr', `Bearer ${secret}`);
      logger.stop();

      const logPath = logger.getLogPath();
      let persisted = '';
      await vi.waitFor(async () => {
        persisted = await readFile(logPath, 'utf8');
        expect(persisted.length).toBeGreaterThan(0);
      });
      const streamed = received.join('\n');

      for (const output of [persisted, streamed]) {
        expect(output).toContain('[runner:session-1]');
        expect(output).toContain(LOG_REDACTION_MARKERS.secret);
        expect(output).toContain(LOG_REDACTION_MARKERS.prompt);
        expect(output).toContain(LOG_REDACTION_MARKERS.fileSnippet);
        expect(output).toContain('toolName');

        expect(output).not.toContain(secret);
        expect(output).not.toContain('full prompt body should never be logged');
        expect(output).not.toContain('TOP-SECRET-FILE-CONTENT');
      }
    } finally {
      logger.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});