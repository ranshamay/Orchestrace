import { describe, expect, it } from 'vitest';
import { assessGitHubStatusCheckRollup } from '../src/runner.js';

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
