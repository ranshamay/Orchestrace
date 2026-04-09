import { describe, expect, it } from 'vitest';
import {
  enforceSafeShellDispatch,
  extractShellCommand,
  parseShellCommandToArgv,
  parseTaskRouteOverride,
  resolveTaskRoute,
  validateShellExecutionPrompt,
  validateShellInput,
} from '../src/task-routing.js';


describe('task routing config', () => {
  it('parses valid override values', () => {
    expect(parseTaskRouteOverride('shell_command')).toBe('shell_command');
    expect(parseTaskRouteOverride(' investigation ')).toBe('investigation');
    expect(parseTaskRouteOverride('invalid')).toBeUndefined();
  });

    it('resolves shell command route with direct strategy', () => {
    const route = resolveTaskRoute('run pnpm run test');
    expect(route.result.category).toBe('shell_command');
    expect(route.result.strategy).toBe('direct_shell');
  });

  it('disables validation for investigation route', () => {
    const route = resolveTaskRoute('investigate flaky tests and summarize root causes');
    expect(route.result.category).toBe('investigation');
    expect(route.validationEnabled).toBe(false);
  });

  it('maps refactor route to refactor task type', () => {
    const route = resolveTaskRoute('refactor graph builder internals');
    expect(route.result.category).toBe('refactor');
    expect(route.nodeType).toBe('refactor');
  });

  it('extracts shell command from prompt directives', () => {
    expect(extractShellCommand('run pnpm typecheck')).toBe('pnpm typecheck');
    expect(extractShellCommand('$ git status')).toBe('git status');
    expect(extractShellCommand('git status')).toBe('git status');
    expect(extractShellCommand('   ')).toBeUndefined();
  });

  it('rejects multiline prompts in extractShellCommand', () => {
    const multiline = '[Observer Fix] Auth check\nCategory: architecture\ngit worktree issue';
    expect(extractShellCommand(multiline)).toBeUndefined();
  });

  it('rejects long prose prompts in extractShellCommand', () => {
    const longPrompt = 'Add a provider authentication pre-flight check at session startup before any planning or tool execution begins. In the session runner initialization make a lightweight API call to validate credentials.';
    expect(extractShellCommand(longPrompt)).toBeUndefined();
  });

  it('treats prose mentioning git/worktrees as non-shell work', () => {
    const prompt = 'we want to make sure we will use git worktrees natively (probably by using git tool) each new session when impl starts, make sure we use native approach and not abstraction of worktree';
    const route = resolveTaskRoute(prompt);
    expect(route.result.category).toBe('code_change');
    expect(route.result.strategy).toBe('full_planning_pipeline');
    expect(extractShellCommand(prompt)).toBeUndefined();
  });

  it('rejects observer-style markdown prompts at shell execution boundary', () => {
    const observerPrompt = [
      '[Observer Fix] Task prompt passed directly as shell command',
      '',
      'Category: architecture | Severity: critical',
      '',
      '## Issue',
      'Prompt text was executed via sh -lc.',
      '',
      '## Task',
      'Route to coding agent prompt field.',
    ].join('\n');

    const validation = validateShellExecutionPrompt(observerPrompt);
    expect(validation.ok).toBe(false);
    expect(validation.reason).toContain('Rejected shell execution');
  });

    it('accepts single-line executable commands at shell execution boundary', () => {
    const validation = validateShellExecutionPrompt('run git status');
    expect(validation.ok).toBe(true);
    expect(validation.command).toBe('git status');
    expect(validation.parsed).toEqual({ program: 'git', args: ['status'] });
  });

  it('parses quoted argv safely for direct process execution', () => {
    const parsed = parseShellCommandToArgv('echo "hello world"');
    expect(parsed.ok).toBe(true);
    expect(parsed.parsed).toEqual({ program: 'echo', args: ['hello world'] });
  });

  it('rejects shell operator injection patterns before execution', () => {
    const validation = validateShellInput('git status; rm -rf /');
    expect(validation.ok).toBe(false);
    expect(validation.reason).toContain('shell operators');
  });

    it('rejects shell substitution syntax before execution', () => {
    const validation = validateShellInput('echo $(whoami)');
    expect(validation.ok).toBe(false);
    expect(validation.reason).toContain('shell operators');
  });

  it('rejects carriage-return line breaks before execution', () => {
    const validation = validateShellInput('git status\rwhoami');
    expect(validation.ok).toBe(false);
    expect(validation.reason).toContain('multiple lines');
  });

  it('rejects control characters before execution', () => {
    const validation = validateShellInput('git\u0000status');
    expect(validation.ok).toBe(false);
    expect(validation.reason).toContain('control characters');
  });


  it('rejects commands outside the allowlist', () => {
    const validation = validateShellInput('sh -c "git status"');
    expect(validation.ok).toBe(false);
    expect(validation.reason).toContain('no executable command was found');
  });

      it('rejects disallowed executable when parsed directly', () => {
    const parsed = parseShellCommandToArgv('ruby -v');
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('not in the allowed shell command list');
  });

  it('rejects dangerous git subcommands even when program is allowed', () => {
    const parsed = parseShellCommandToArgv('git checkout main');
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('explicitly blocked');
  });

  it('rejects control characters when parsed directly', () => {
    const parsed = parseShellCommandToArgv('git\u0000status');
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('control characters');
  });


  it('rejects markdown-like single-line payloads through canonical shell validator', () => {

    const validation = validateShellInput('## Task: run git status');
    expect(validation.ok).toBe(false);
    expect(validation.reason).toContain('markdown/instructional');
  });

  it('rejects single-line natural language prompts that are not executable commands', () => {
    const validation = validateShellInput('please investigate why the session fails to start');
    expect(validation.ok).toBe(false);
    expect(validation.reason).toContain('no executable command was found');
  });


    it('keeps validateShellExecutionPrompt aligned with canonical validator', () => {
    const canonical = validateShellInput('run pnpm run test');
    const alias = validateShellExecutionPrompt('run pnpm run test');
    expect(alias).toEqual(canonical);
  });

  it('demotes override-forced shell route to code_change when prompt is prose', () => {
    const prompt = 'we want to make sure we will use git worktrees natively (probably by using git tool) each new session when impl starts';
    const resolved = resolveTaskRoute(prompt, 'shell_command').result;
    expect(resolved.category).toBe('shell_command');
    expect(resolved.source).toBe('override');

    const dispatch = enforceSafeShellDispatch(prompt, resolved, 'user');
    expect(dispatch.shell.ok).toBe(false);
    expect(dispatch.route.category).toBe('code_change');
    expect(dispatch.route.strategy).toBe('full_planning_pipeline');
    expect(dispatch.route.source).toBe('fallback');
  });

  it('keeps explicit shell route when override prompt is a real command', () => {
    const prompt = 'run git status';
    const resolved = resolveTaskRoute(prompt, 'shell_command').result;
    const dispatch = enforceSafeShellDispatch(prompt, resolved, 'user');

    expect(dispatch.route.category).toBe('shell_command');
    expect(dispatch.shell.ok).toBe(true);
    expect(dispatch.shell.command).toBe('git status');
  });

  it('demotes shell route when source is undefined at dispatch boundary', () => {
    const prompt = 'git status';
    const resolved = resolveTaskRoute(prompt, 'shell_command').result;
    const dispatch = enforceSafeShellDispatch(prompt, resolved, undefined);

    expect(dispatch.shell.ok).toBe(false);
    expect(dispatch.shell.reason).toContain('source is undefined');
    expect(dispatch.route.category).toBe('code_change');
    expect(dispatch.route.reason).toContain('source guard');
  });
});
