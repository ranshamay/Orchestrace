import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execMock, accessMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  accessMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  exec: execMock,
}));

vi.mock('node:fs/promises', () => ({
  access: accessMock,
}));

import { validate } from '../../src/validation/validator.js';
import type { TaskOutput, ValidationConfig } from '../../src/dag/types.js';

function makeOutput(): TaskOutput {
  return {
    taskId: 'task-1',
    status: 'completed',
    response: 'ok',
    durationMs: 1,
    retries: 0,
  };
}

function mockExecSequence(steps: Array<{ err?: Error | null; stdout?: string; stderr?: string }>) {
  let index = 0;
  execMock.mockImplementation((command: string, _options: unknown, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
    const step = steps[index++] ?? { err: null, stdout: '', stderr: '' };
    callback(step.err ?? null, step.stdout ?? '', step.stderr ?? '');
    return {};
  });
}

describe('validate dependency guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs pnpm install before validations when lockfile exists and node_modules is missing', async () => {
    accessMock.mockImplementation(async (path: string) => {
      if (path.endsWith('pnpm-lock.yaml')) {
        return;
      }
      throw new Error('missing');
    });

    mockExecSequence([
      { err: null, stdout: 'installed\n' },
      { err: null, stdout: 'lint ok\n' },
    ]);

    const config: ValidationConfig = { commands: ['pnpm lint'] };
    const results = await validate(makeOutput(), config, '/tmp/repo');

    expect(results).toHaveLength(1);
    expect(results[0]?.passed).toBe(true);
    expect(execMock).toHaveBeenNthCalledWith(
      1,
      'pnpm install --frozen-lockfile',
      expect.objectContaining({ cwd: '/tmp/repo' }),
      expect.any(Function),
    );
    expect(execMock).toHaveBeenNthCalledWith(
      2,
      'pnpm lint',
      expect.objectContaining({ cwd: '/tmp/repo' }),
      expect.any(Function),
    );
  });

  it('skips pnpm install when node_modules exists', async () => {
    accessMock.mockResolvedValue(undefined);
    mockExecSequence([{ err: null, stdout: 'test ok\n' }]);

    const config: ValidationConfig = { commands: ['pnpm test'] };
    const results = await validate(makeOutput(), config, '/tmp/repo');

    expect(results).toHaveLength(1);
    expect(results[0]?.passed).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledWith(
      'pnpm test',
      expect.objectContaining({ cwd: '/tmp/repo' }),
      expect.any(Function),
    );
  });

  it('returns failed validation results when dependency bootstrap fails', async () => {
    accessMock.mockImplementation(async (path: string) => {
      if (path.endsWith('pnpm-lock.yaml')) {
        return;
      }
      throw new Error('missing');
    });

    mockExecSequence([
      { err: new Error('install failed'), stdout: '', stderr: 'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL' },
    ]);

    const config: ValidationConfig = { commands: ['pnpm lint', 'pnpm test'] };
    const results = await validate(makeOutput(), config, '/tmp/repo');

    expect(results).toHaveLength(2);
    expect(results.every((result) => !result.passed)).toBe(true);
    expect(results[0]?.output).toContain('pnpm install --frozen-lockfile failed');
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('preserves retry-once behavior for validation commands', async () => {
    accessMock.mockImplementation(async () => {
      throw new Error('missing');
    });
    mockExecSequence([
      { err: new Error('fail'), stdout: '', stderr: 'flake' },
      { err: null, stdout: 'lint ok\n' },
    ]);

    const config: ValidationConfig = { commands: ['pnpm lint'] };
    const results = await validate(makeOutput(), config, '/tmp/repo-no-lockfile');

    expect(results).toHaveLength(1);
    expect(results[0]?.passed).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock).toHaveBeenNthCalledWith(
      1,
      'pnpm lint',
      expect.objectContaining({ cwd: '/tmp/repo-no-lockfile' }),
      expect.any(Function),
    );
    expect(execMock).toHaveBeenNthCalledWith(
      2,
      'pnpm lint',
      expect.objectContaining({ cwd: '/tmp/repo-no-lockfile' }),
      expect.any(Function),
    );
  });
});