import { describe, expect, it } from 'vitest';
import { resolveAppAuthTokenFromRequestHeaders } from '../src/ui-server.js';

describe('app auth token resolution', () => {
  it('resolves bearer token from authorization header', () => {
    const token = resolveAppAuthTokenFromRequestHeaders({
      authorization: 'Bearer header-token-123',
    });

    expect(token).toBe('header-token-123');
  });

  it('falls back to cookie token when authorization is missing', () => {
    const token = resolveAppAuthTokenFromRequestHeaders({
      cookie: 'foo=bar; orchestrace_app_auth=cookie-token-456; theme=dark',
    });

    expect(token).toBe('cookie-token-456');
  });

  it('prefers authorization header over cookie token', () => {
    const token = resolveAppAuthTokenFromRequestHeaders({
      authorization: 'Bearer preferred-token',
      cookie: 'orchestrace_app_auth=secondary-token',
    });

    expect(token).toBe('preferred-token');
  });

  it('does not read token-like values from URL-ish headers', () => {
    const token = resolveAppAuthTokenFromRequestHeaders({
      cookie: undefined,
      authorization: undefined,
      // @ts-expect-error Extra headers are intentionally ignored.
      referer: 'http://localhost:3000/api/work/sessions/stream?token=query-token-should-not-be-used',
    });

    expect(token).toBeUndefined();
  });
});
