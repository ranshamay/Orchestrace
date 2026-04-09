import { describe, expect, it } from 'vitest';
import { assessGitHubStatusCheckRollup, formatSessionDeliveryMessage } from '../src/runner.js';

describe('assessGitHubStatusCheckRollup', () => {
  it('returns zero summary for non-array payloads', () => {
    expect(assessGitHubStatusCheckRollup(undefined)).toEqual({
      total: 0,
      passing: 0,
      pending: 0,
      failing: 0,
    });
  });

  it('classifies CheckRun entries by status and conclusion', () => {
    const summary = assessGitHubStatusCheckRollup([
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null },
    ]);

    expect(summary).toEqual({
      total: 3,
      passing: 1,
      pending: 1,
      failing: 1,
    });
  });

  it('classifies StatusContext entries by state', () => {
    const summary = assessGitHubStatusCheckRollup([
      { __typename: 'StatusContext', state: 'SUCCESS' },
      { __typename: 'StatusContext', state: 'FAILURE' },
      { __typename: 'StatusContext', state: 'PENDING' },
    ]);

    expect(summary).toEqual({
      total: 3,
      passing: 1,
      pending: 1,
      failing: 1,
    });
  });

  it('treats unknown entries as pending for fail-safe behavior', () => {
    const summary = assessGitHubStatusCheckRollup([
      { __typename: 'UnknownType', state: 'SUCCESS' },
      'bad-entry',
    ]);

    expect(summary).toEqual({
      total: 2,
      passing: 0,
      pending: 2,
      failing: 0,
    });
  });
});

describe('formatSessionDeliveryMessage', () => {
  it('formats pr-only mode for created PRs', () => {
    const message = formatSessionDeliveryMessage({
      branchName: 'feat/demo',
      prNumber: 17,
      prUrl: 'https://github.com/acme/repo/pull/17',
      prCreated: true,
      deliveryStrategy: 'pr-only',
    });

    expect(message).toContain('PR #17 was created');
    expect(message).toContain('GitHub CI checks passed');
    expect(message).not.toContain('was merged');
  });

  it('formats merge-after-ci mode for reused PRs', () => {
    const message = formatSessionDeliveryMessage({
      branchName: 'fix/demo',
      prNumber: 42,
      prUrl: 'https://github.com/acme/repo/pull/42',
      prCreated: false,
      deliveryStrategy: 'merge-after-ci',
    });

    expect(message).toContain('existing PR #42 was reused');
    expect(message).toContain('was merged');
  });

  it('notes already-merged race fallback in merge-after-ci mode', () => {
    const message = formatSessionDeliveryMessage({
      branchName: 'fix/demo',
      prNumber: 50,
      prUrl: 'https://github.com/acme/repo/pull/50',
      prCreated: true,
      deliveryStrategy: 'merge-after-ci',
      alreadyMerged: true,
    });

    expect(message).toContain('was merged (already merged)');
  });
});
