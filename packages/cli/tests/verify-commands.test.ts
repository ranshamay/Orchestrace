import { describe, expect, it } from 'vitest';
import { parseAndSanitizeVerifyCommands, sanitizeVerifyCommand } from '../src/verify-commands.js';

describe('verify command sanitization', () => {
  it('removes --runInBand from vitest commands', () => {
    expect(sanitizeVerifyCommand('vitest run --runInBand')).toBe('vitest run');
    expect(sanitizeVerifyCommand('pnpm vitest --runInBand run')).toBe('pnpm vitest run');
    expect(sanitizeVerifyCommand('vitest --runinband run')).toBe('vitest run');
  });

    it('rewrites filtered pnpm test commands to forward args after --', () => {
    expect(sanitizeVerifyCommand('pnpm test -t "name"')).toBe('pnpm test -- -t "name"');
    expect(sanitizeVerifyCommand('pnpm test --testNamePattern "name"')).toBe('pnpm test -- --testNamePattern "name"');
  });

  it('keeps already-forwarded pnpm test filter args unchanged', () => {
    expect(sanitizeVerifyCommand('pnpm test -- -t "name"')).toBe('pnpm test -- -t "name"');
  });

  it('keeps non-vitest/non-filter commands unchanged', () => {
    expect(sanitizeVerifyCommand('pnpm test --runInBand')).toBe('pnpm test --runInBand');
    expect(sanitizeVerifyCommand('pnpm typecheck')).toBe('pnpm typecheck');
  });

  it('parses env command list and sanitizes vitest/filtered test entries', () => {
    const commands = parseAndSanitizeVerifyCommands('pnpm typecheck; pnpm vitest run --runInBand; pnpm test -t fast');
    expect(commands).toEqual(['pnpm typecheck', 'pnpm vitest run', 'pnpm test -- -t fast']);
  });


  it('returns default commands when env input is missing', () => {
    expect(parseAndSanitizeVerifyCommands(undefined)).toEqual(['pnpm typecheck', 'pnpm test']);
  });
});