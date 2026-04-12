import { describe, expect, it } from 'vitest';
import { buildAuthedSseUrl } from '../src/lib/api';

describe('SSE auth URL builder', () => {
  it('does not append token query parameter for sessions stream', () => {
    const url = buildAuthedSseUrl('/api/work/sessions/stream');
    expect(url).toBe('/api/work/sessions/stream');
    expect(url.includes('token=')).toBe(false);
  });

  it('preserves existing query params without adding auth query token', () => {
    const url = buildAuthedSseUrl('/api/work/stream?id=session-123');
    expect(url).toBe('/api/work/stream?id=session-123');
    expect(url.includes('token=')).toBe(false);
  });
});
