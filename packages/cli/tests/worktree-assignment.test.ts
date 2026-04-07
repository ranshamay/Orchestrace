import { describe, expect, it } from 'vitest';
import {
  assertWorkspaceIsClean,
  classifyWorkspacePathSessionIdRelation,
} from '../src/ui-server.js';

describe('worktree assignment helpers', () => {
  it('classifies matching session id in workspace path', () => {
    const result = classifyWorkspacePathSessionIdRelation(
      '8e4734f4-1111-2222-3333-444455556666',
      '/repo/.worktrees/session-8e4734f4-1111-2222-3333-444455556666',
    );
    expect(result.relation).toBe('match');
    expect(result.pathSessionId).toBe('8e4734f4-1111-2222-3333-444455556666');
  });

  it('classifies mismatched session id in workspace path', () => {
    const result = classifyWorkspacePathSessionIdRelation(
      '8e4734f4-1111-2222-3333-444455556666',
      '/repo/.worktrees/session-a3f297a1-7777-8888-9999-000011112222',
    );
    expect(result.relation).toBe('mismatch');
    expect(result.pathSessionId).toBe('a3f297a1-7777-8888-9999-000011112222');
  });

  it('returns none when workspace path has no session token', () => {
    const result = classifyWorkspacePathSessionIdRelation('abc', '/repo/.worktrees/feature-branch');
    expect(result.relation).toBe('none');
    expect(result.pathSessionId).toBeUndefined();
  });

  it('throws when workspace is dirty at session start', async () => {
    await expect(
      assertWorkspaceIsClean('/repo/.worktrees/session-abc', async () => ({
        hasUncommittedChanges: true,
        hasStagedChanges: false,
        hasUntrackedChanges: true,
        dirtySummary: ['M package.json', '?? temp.txt'],
      })),
    ).rejects.toThrow(/Workspace is not clean at session start/);
  });

  it('passes when workspace is clean at session start', async () => {
    await expect(
      assertWorkspaceIsClean('/repo/.worktrees/session-abc', async () => ({
        hasUncommittedChanges: false,
        hasStagedChanges: false,
        hasUntrackedChanges: false,
        dirtySummary: [],
      })),
    ).resolves.toBeUndefined();
  });
});