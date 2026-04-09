import { describe, expect, it } from 'vitest';
import { parseAndSanitizeVerifyCommands, sanitizeVerifyCommand } from '../src/verify-commands.js';

describe('verify command sanitization', () => {
  it('removes --runInBand from vitest commands', () => {
    expect(sanitizeVerifyCommand('vitest run --runInBand')).toBe('vitest run');
    expect(sanitizeVerifyCommand('pnpm vitest --runInBand run')).toBe('pnpm vitest run');
    expect(sanitizeVerifyCommand('vitest --runinband run')).toBe('vitest run');
  });

  it('keeps non-vitest commands unchanged', () => {
    expect(sanitizeVerifyCommand('pnpm test --runInBand')).toBe('pnpm test --runInBand');
    expect(sanitizeVerifyCommand('pnpm typecheck')).toBe('pnpm typecheck');
  });

  it('parses env command list and sanitizes vitest entries only', () => {
    const commands = parseAndSanitizeVerifyCommands('pnpm typecheck; pnpm vitest run --runInBand; pnpm test --runInBand');
    expect(commands).toEqual(['pnpm typecheck', 'pnpm vitest run', 'pnpm test --runInBand']);
  });

  it('returns default commands when env input is missing', () => {
    expect(parseAndSanitizeVerifyCommands(undefined)).toEqual(['pnpm typecheck', 'pnpm test']);
  });
});