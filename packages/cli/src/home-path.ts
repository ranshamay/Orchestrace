import { homedir } from 'node:os';
import { join } from 'node:path';

const GITHUB_AUTH_FILE_RELATIVE_PATH = ['.orchestrace', 'github-auth.json'] as const;

export function resolveGitHubAuthFilePath(): string {
  const home = homedir();

  if (!isUsableHomeDirectory(home)) {
    throw new Error(
      'Unable to determine the user home directory for GitHub auth storage. Set HOME (or platform equivalent) to a valid path and retry.',
    );
  }

  return join(home, ...GITHUB_AUTH_FILE_RELATIVE_PATH);
}

export function isUsableHomeDirectory(home: string | null | undefined): home is string {
  if (typeof home !== 'string') return false;
  const normalized = home.trim();
  if (normalized.length === 0) return false;
  if (normalized === '~') return false;
  return true;
}