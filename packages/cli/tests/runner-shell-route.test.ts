import { describe, expect, it, vi } from 'vitest';
import { runShellCommandRouteWithDeps, runShellCommandWithTimeoutWithDeps } from '../src/runner.js';

describe('runner shell execution guard', () => {
  it('runShellCommandRouteWithDeps rejects invalid markdown input and never executes process', async () => {
    const execFile = vi.fn();
    const logError = vi.fn();

    const outputs = await runShellCommandRouteWithDeps('## Task: run git status', '/tmp/workspace', {
      execFile: execFile as never,
      logError,
    });

    const task = outputs.get('task');
    expect(task?.status).toBe('failed');
    expect(task?.error).toBe('shell_input_validation_failed');
    expect(task?.response).toContain('markdown/instructional');
    expect(execFile).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]?.[0]).toContain('[shell-guard] rejected shell execution at runner.runShellCommandRoute');
  });

  it('runShellCommandRouteWithDeps executes parsed argv for valid command', async () => {
    const execFile = vi.fn(async () => ({ stdout: 'status\n', stderr: '' }));
    const logError = vi.fn();

    const outputs = await runShellCommandRouteWithDeps('git status', '/tmp/workspace', {
      execFile: execFile as never,
      logError,
    });

    const task = outputs.get('task');
    expect(task?.status).toBe('completed');
    expect(task?.response).toContain('status');
    expect(execFile).toHaveBeenCalledWith('git', ['status'], { cwd: '/tmp/workspace' });
    expect(logError).not.toHaveBeenCalled();
  });

  it('runShellCommandWithTimeoutWithDeps rejects invalid prose and never executes process', async () => {
    const execFile = vi.fn();
    const logError = vi.fn();

    const result = await runShellCommandWithTimeoutWithDeps(
      'please investigate why tests are failing',
      '/tmp/workspace',
      2000,
      {
        execFile: execFile as never,
        logError,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('no executable command was found');
    expect(execFile).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]?.[0]).toContain('[shell-guard] rejected shell execution at runner.runShellCommandWithTimeout');
  });

  it('runShellCommandWithTimeoutWithDeps executes parsed argv with timeout for valid command', async () => {
    const execFile = vi.fn(async () => ({ stdout: 'ok\n', stderr: '' }));
    const logError = vi.fn();

    const result = await runShellCommandWithTimeoutWithDeps('run pnpm test', '/tmp/workspace', 1500, {
      execFile: execFile as never,
      logError,
    });

    expect(result).toEqual({ ok: true, stdout: 'ok\n', stderr: '' });
    expect(execFile).toHaveBeenCalledWith('pnpm', ['test'], {
      cwd: '/tmp/workspace',
      timeout: 1500,
      maxBuffer: 5 * 1024 * 1024,
    });
    expect(logError).not.toHaveBeenCalled();
  });
});