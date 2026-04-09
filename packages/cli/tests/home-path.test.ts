import { describe, expect, it, vi, beforeEach } from 'vitest';

const homedirMock = vi.fn<() => string>();

vi.mock('node:os', () => ({
  homedir: homedirMock,
}));

describe('resolveGitHubAuthFilePath', () => {
  beforeEach(() => {
    vi.resetModules();
    homedirMock.mockReset();
  });

  it('builds ~/.orchestrace/github-auth.json from a valid home directory', async () => {
    homedirMock.mockReturnValue('/tmp/test-home');

    const { resolveGitHubAuthFilePath } = await import('../src/home-path.js');

    expect(resolveGitHubAuthFilePath()).toBe('/tmp/test-home/.orchestrace/github-auth.json');
  });

  it('throws a clear error when home directory cannot be determined', async () => {
    homedirMock.mockReturnValue('   ');

    const { resolveGitHubAuthFilePath } = await import('../src/home-path.js');

    expect(() => resolveGitHubAuthFilePath()).toThrow(
      'Unable to determine the user home directory for GitHub auth storage.',
    );
  });
});