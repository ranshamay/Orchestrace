import { describe, expect, it } from 'vitest';
import { parsePrMetadataResponse } from '../src/runner.js';

describe('PR metadata generation with observer fix prefix', () => {
  const basicTaskRanges = [
    { todoId: 'task1', todoTitle: 'Add feature A' },
  ];

  describe('parsePrMetadataResponse with observer sessions', () => {
    it('adds [Observer fix] prefix when isObserverSession is true and prefix is missing', () => {
      const jsonResponse = JSON.stringify({
        branchName: 'feat/add-feature-a',
        prTitle: 'feat: add feature A',
        prDescription: '## Summary\nAdds feature A\n\n## Changes\n- File 1\n- File 2',
        taskCommitMessages: [{ todoId: 'task1', message: 'feat: add feature A' }],
        fallbackCommitMessage: 'feat: add feature A',
      });

      const result = parsePrMetadataResponse(jsonResponse, basicTaskRanges, true);

      expect(result).toBeDefined();
      expect(result?.prTitle).toBe('[Observer fix] feat: add feature A');
    });

    it('does not duplicate [Observer fix] prefix if already present in LLM output', () => {
      const jsonResponse = JSON.stringify({
        branchName: 'feat/add-feature-a',
        prTitle: '[Observer fix] feat: add feature A',
        prDescription: '## Summary\nAdds feature A\n\n## Changes\n- File 1',
        taskCommitMessages: [{ todoId: 'task1', message: 'feat: add feature A' }],
        fallbackCommitMessage: 'feat: add feature A',
      });

      const result = parsePrMetadataResponse(jsonResponse, basicTaskRanges, true);

      expect(result).toBeDefined();
      expect(result?.prTitle).toBe('[Observer fix] feat: add feature A');
      expect(result?.prTitle).not.toMatch(/\[Observer fix\].*\[Observer fix\]/);
    });

    it('respects 80 character limit when adding [Observer fix] prefix', () => {
      const jsonResponse = JSON.stringify({
        branchName: 'feat/add-feature-a',
        prTitle: 'feat: add a very long feature title that exceeds the maximum length allowed',
        prDescription: 'Some description',
        taskCommitMessages: [{ todoId: 'task1', message: 'feat: add feature' }],
        fallbackCommitMessage: 'feat: add feature',
      });

      const result = parsePrMetadataResponse(jsonResponse, basicTaskRanges, true);

      expect(result).toBeDefined();
      // After prepending "[Observer fix] " (15 chars), the total should not exceed 80 chars
      const prTitle = result?.prTitle || '';
      expect(prTitle.length).toBeLessThanOrEqual(80);
      expect(prTitle.startsWith('[Observer fix]')).toBe(true);
    });
  });

  describe('parsePrMetadataResponse with user sessions', () => {
    it('does NOT add [Observer fix] prefix when isObserverSession is false', () => {
      const jsonResponse = JSON.stringify({
        branchName: 'feat/add-feature-a',
        prTitle: 'feat: add feature A',
        prDescription: '## Summary\nAdds feature A\n\n## Changes\n- File 1',
        taskCommitMessages: [{ todoId: 'task1', message: 'feat: add feature A' }],
        fallbackCommitMessage: 'feat: add feature A',
      });

      const result = parsePrMetadataResponse(jsonResponse, basicTaskRanges, false);

      expect(result).toBeDefined();
      expect(result?.prTitle).toBe('feat: add feature A');
      expect(result?.prTitle).not.toMatch(/\[Observer fix\]/);
    });

    it('does NOT add [Observer fix] prefix when isObserverSession is undefined', () => {
      const jsonResponse = JSON.stringify({
        branchName: 'feat/add-feature-a',
        prTitle: 'feat: add feature A',
        prDescription: '## Summary\nAdds feature A',
        taskCommitMessages: [{ todoId: 'task1', message: 'feat: add feature A' }],
        fallbackCommitMessage: 'feat: add feature A',
      });

      const result = parsePrMetadataResponse(jsonResponse, basicTaskRanges);

      expect(result).toBeDefined();
      expect(result?.prTitle).toBe('feat: add feature A');
      expect(result?.prTitle).not.toMatch(/\[Observer fix\]/);
    });
  });

  describe('parsePrMetadataResponse with multiple tasks', () => {
    it('correctly processes multiple task commit messages for observer sessions', () => {
      const multipleTaskRanges = [
        { todoId: 'task1', todoTitle: 'Task 1' },
        { todoId: 'task2', todoTitle: 'Task 2' },
      ];

      const jsonResponse = JSON.stringify({
        branchName: 'feat/multi-task',
        prTitle: 'feat: implement multiple changes',
        prDescription: '## Summary\nMultiple changes',
        taskCommitMessages: [
          { todoId: 'task1', message: 'feat: task 1 implementation' },
          { todoId: 'task2', message: 'fix: task 2 bugfix' },
        ],
        fallbackCommitMessage: 'feat: implement multiple changes',
      });

      const result = parsePrMetadataResponse(jsonResponse, multipleTaskRanges, true);

      expect(result).toBeDefined();
      expect(result?.prTitle).toBe('[Observer fix] feat: implement multiple changes');
      expect(result?.taskCommitMessages).toHaveLength(2);
      expect(result?.taskCommitMessages[0].message).toBe('feat: task 1 implementation');
      expect(result?.taskCommitMessages[1].message).toBe('fix: task 2 bugfix');
    });
  });

  describe('parsePrMetadataResponse error handling', () => {
    it('returns undefined for invalid JSON', () => {
      const result = parsePrMetadataResponse('not valid json', basicTaskRanges, true);
      expect(result).toBeUndefined();
    });

    it('returns undefined when prTitle is missing', () => {
      const jsonResponse = JSON.stringify({
        branchName: 'feat/test',
        prDescription: 'Some description',
        fallbackCommitMessage: 'test',
      });

      const result = parsePrMetadataResponse(jsonResponse, basicTaskRanges, true);
      expect(result).toBeUndefined();
    });

    it('returns undefined when fallbackCommitMessage is missing', () => {
      const jsonResponse = JSON.stringify({
        branchName: 'feat/test',
        prTitle: 'test',
        prDescription: 'Some description',
      });

      const result = parsePrMetadataResponse(jsonResponse, basicTaskRanges, true);
      expect(result).toBeUndefined();
    });
  });
});