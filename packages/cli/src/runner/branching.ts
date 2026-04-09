export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface WorktreeDirtySummary {
  hasUncommittedChanges: boolean;
  hasStagedChanges: boolean;
  hasUntrackedChanges: boolean;
  dirtySummary: string[];
}

function formatGitFailure(result: GitRunResult): string {
  return (result.error ?? result.stderr).trim() || 'unknown git failure';
}

export async function ensureCleanAndSyncedBaseBranch(params: {
  baseBranch: string;
  timeoutMs: number;
  runGit: (args: string[], timeoutMs: number) => Promise<GitRunResult>;
  getWorktreeDirtySummary: () => Promise<WorktreeDirtySummary>;
}): Promise<void> {
  const dirty = await params.getWorktreeDirtySummary();
  if (dirty.hasUncommittedChanges || dirty.hasStagedChanges || dirty.hasUntrackedChanges) {
    const details = dirty.dirtySummary.slice(0, 10).join('\n');
    throw new Error(
      [
        'Working tree must be clean before syncing base branch for delivery.',
        details ? `Dirty entries:\n${details}` : undefined,
      ].filter(Boolean).join('\n\n'),
    );
  }

  const fetchRes = await params.runGit(['fetch', 'origin'], params.timeoutMs);
  if (!fetchRes.ok) {
    throw new Error(`git fetch origin failed: ${formatGitFailure(fetchRes)}`);
  }

  const checkoutRes = await params.runGit(['checkout', params.baseBranch], params.timeoutMs);
  if (!checkoutRes.ok) {
    throw new Error(`git checkout ${params.baseBranch} failed: ${formatGitFailure(checkoutRes)}`);
  }

  const pullRes = await params.runGit(['pull', '--ff-only', 'origin', params.baseBranch], params.timeoutMs);
  if (!pullRes.ok) {
    throw new Error(`git pull --ff-only origin ${params.baseBranch} failed: ${formatGitFailure(pullRes)}`);
  }
}

export async function createBranchFromBase(params: {
  preferredBranchName: string;
  fallbackBranchName: string;
  baseBranch: string;
  timeoutMs: number;
  runGit: (args: string[], timeoutMs: number) => Promise<GitRunResult>;
}): Promise<string> {
  const primary = await params.runGit(
    ['checkout', '-B', params.preferredBranchName, params.baseBranch],
    params.timeoutMs,
  );
  if (primary.ok) {
    return params.preferredBranchName;
  }

  const fallback = await params.runGit(
    ['checkout', '-B', params.fallbackBranchName, params.baseBranch],
    params.timeoutMs,
  );
  if (fallback.ok) {
    return params.fallbackBranchName;
  }

  throw new Error(
    `Unable to create delivery branch from ${params.baseBranch}: ${(fallback.error ?? fallback.stderr).trim() || 'git checkout failed'}`,
  );
}