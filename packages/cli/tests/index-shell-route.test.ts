import { describe, expect, it, vi } from 'vitest';
import { runShellCommandRouteWithDeps } from '../src/index.js';

describe('index shell route guard', () => {
  it('rejects invalid shell input, logs deterministic message, and never executes process', async () => {
    const execFile = vi.fn();
    const stdoutWrite = vi.fn();
    const stderrWrite = vi.fn();
    const logError = vi.fn();

    const exitCode = await runShellCommandRouteWithDeps(
      '## Task: run git status',
      '/tmp/workspace',
      {
        execFile: execFile as never,
        stdoutWrite,
        stderrWrite,
        logError,
      },
    );

    expect(exitCode).toBe(1);
    expect(execFile).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
        expect(logError).toHaveBeenCalledTimes(2);
    expect(logError.mock.calls[0]?.[0]).toContain('[shell-guard] rejected shell execution at cli.runShellCommandRoute');
    expect(logError.mock.calls[0]?.[0]).toContain('markdown/instructional');
    expect(logError.mock.calls[1]?.[0]).toContain('[command-audit] route=cli.runShellCommandRoute');
    expect(logError.mock.calls[1]?.[0]).toContain('decision=rejected');

  });

  it('executes parsed argv for validated command and streams stdout/stderr', async () => {
    const execFile = vi.fn(async () => ({ stdout: 'ok\n', stderr: 'warn\n' }));
    const stdoutWrite = vi.fn();
    const stderrWrite = vi.fn();
    const logError = vi.fn();

    const exitCode = await runShellCommandRouteWithDeps(
      'run git status',
      '/tmp/workspace',
      {
        execFile: execFile as never,
        stdoutWrite,
        stderrWrite,
        logError,
      },
    );

    expect(exitCode).toBe(0);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith('git', ['status'], { cwd: '/tmp/workspace' });
    expect(stdoutWrite).toHaveBeenCalledWith('ok\n');
    expect(stderrWrite).toHaveBeenCalledWith('warn\n');
        expect(logError).toHaveBeenCalledTimes(2);
    expect(logError.mock.calls[0]?.[0]).toContain('[command-audit] route=cli.runShellCommandRoute');
    expect(logError.mock.calls[0]?.[0]).toContain('decision=allowed');
    expect(logError.mock.calls[1]?.[0]).toContain('exitCode=0');

  });
});