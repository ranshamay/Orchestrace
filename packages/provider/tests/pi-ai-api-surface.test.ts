import { describe, expect, it } from 'vitest';
import { Type, validateToolCall } from '@mariozechner/pi-ai';

describe('@mariozechner/pi-ai API surface', () => {
  it('does not expose Value export and validates tool calls via validateToolCall', async () => {
    const moduleExports = await import('@mariozechner/pi-ai');
    expect('Value' in moduleExports).toBe(false);

    const tools = [
      {
        name: 'sum',
        description: 'Add two numbers',
        parameters: Type.Object({
          a: Type.Number(),
          b: Type.Number(),
        }),
      },
    ];

    const validCall = {
      id: 'call-valid',
      name: 'sum',
      arguments: { a: 1, b: 2 },
    };
    const validated = validateToolCall(tools, validCall);
    expect(validated).toEqual({ a: 1, b: 2 });

    const invalidCall = {
      id: 'call-invalid',
      name: 'sum',
      arguments: { a: '1', b: 2 },
    };
    expect(() => validateToolCall(tools, invalidCall)).toThrowError();
  });
});