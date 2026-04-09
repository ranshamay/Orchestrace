import { describe, expect, it } from 'vitest';
import {
  LOG_REDACTION_MARKERS,
  sanitizeLogLine,
  sanitizeToolPayload,
  stringifySanitizedTracePayload,
} from '../src/runner/log-sanitizer.js';

describe('runner log sanitizer', () => {
  it('redacts token-like secrets in plain text', () => {
    const secret = 'ghp_123456789012345678901234567890123456';
    const line = `Authorization: Bearer ${secret} token=${secret}`;

    const sanitized = sanitizeLogLine(line);

    expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain(LOG_REDACTION_MARKERS.secret);
  });

  it('redacts prompt and file snippet content in structured payloads', () => {
    const payload = JSON.stringify({
      prompt: 'full hidden prompt body',
      fileSnippets: [
        { path: 'src/app.ts', content: 'const pwd = "super-secret";' },
      ],
      token: 'sk-verysecrettokenvalue123456789',
      toolName: 'read_file',
    });

    const sanitized = sanitizeLogLine(payload);

    expect(sanitized).toContain(`"prompt":"${LOG_REDACTION_MARKERS.prompt}"`);
    expect(sanitized).toContain(`"fileSnippets":"${LOG_REDACTION_MARKERS.fileSnippet}"`);
    expect(sanitized).toContain(`"token":"${LOG_REDACTION_MARKERS.secret}"`);
    expect(sanitized).toContain('"toolName":"read_file"');
    expect(sanitized).not.toContain('full hidden prompt body');
    expect(sanitized).not.toContain('super-secret');
  });

  it('produces safe payload preview and trace payload output', () => {
    const raw = '{"prompt":"do everything","content":"private file body","apiKey":"sk-abcdef1234567890"}';

    const preview = sanitizeToolPayload(raw, { maxLength: 200 });
    const trace = stringifySanitizedTracePayload(raw);

    expect(preview).toContain(LOG_REDACTION_MARKERS.prompt);
    expect(preview).toContain(LOG_REDACTION_MARKERS.fileSnippet);
    expect(preview).toContain(LOG_REDACTION_MARKERS.secret);
    expect(trace).toContain(LOG_REDACTION_MARKERS.prompt);
    expect(trace).not.toContain('private file body');
  });
});