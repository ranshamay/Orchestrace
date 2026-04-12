import { describe, expect, it } from 'vitest';
import { formatTimelineEvent } from '../src/app/utils/timeline';

describe('tester timeline summary formatting', () => {
  it('formats structured tester verdict metadata into timeline summary content', () => {
    const formatted = formatTimelineEvent({
      type: 'task:tester-verdict',
      message: '[run:abc] task:',
      taskId: 'task',
      testsPassed: 6,
      testsFailed: 0,
      uiTestsRequired: true,
      uiTestsRun: true,
      screenshotPaths: ['artifacts/ui/home.png', 'artifacts/ui/mobile.png'],
    });

    expect(formatted.title).toBe('Tester Approved');
    expect(formatted.content).toContain('passed=6');
    expect(formatted.content).toContain('failed=0');
    expect(formatted.content).toContain('uiTests=ran');
    expect(formatted.content).toContain('screenshots=2');
  });

  it('includes explicit UI requirement note during testing phase', () => {
    const formatted = formatTimelineEvent({
      type: 'task:testing',
      message: '[run:abc] task:',
      taskId: 'task',
      uiTestsRequired: true,
    });

    expect(formatted.title).toBe('Testing');
    expect(formatted.content).toContain('UI changes detected; UI tests required');
  });
});
