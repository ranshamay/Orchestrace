import { describe, expect, it } from 'vitest';
import { isContentOnlyFileSet } from '../../src/validation/validator.js';

describe('isContentOnlyFileSet', () => {
  it('returns false for undefined filesChanged', () => {
    expect(isContentOnlyFileSet(undefined)).toBe(false);
  });

  it('returns false for empty array', () => {
    expect(isContentOnlyFileSet([])).toBe(false);
  });

  it('returns true when all files are markdown', () => {
    expect(isContentOnlyFileSet([
      'knowledge-base/README.md',
      'knowledge-base/typescript.md',
      'docs/guide.md',
    ])).toBe(true);
  });

  it('returns true for mixed content-only extensions', () => {
    expect(isContentOnlyFileSet([
      'docs/intro.md',
      'assets/logo.png',
      'notes/changelog.txt',
      'images/diagram.svg',
    ])).toBe(true);
  });

  it('returns false when any file is a code file', () => {
    expect(isContentOnlyFileSet([
      'knowledge-base/README.md',
      'packages/core/src/index.ts',
    ])).toBe(false);
  });

  it('returns false for JSON files (can affect config/tests)', () => {
    expect(isContentOnlyFileSet([
      'docs/guide.md',
      'package.json',
    ])).toBe(false);
  });

  it('returns false for files without extensions', () => {
    expect(isContentOnlyFileSet([
      'Makefile',
    ])).toBe(false);
  });

  it('is case-insensitive on extensions', () => {
    expect(isContentOnlyFileSet([
      'README.MD',
      'image.PNG',
    ])).toBe(true);
  });
});
