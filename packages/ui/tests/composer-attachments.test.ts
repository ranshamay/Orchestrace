import { describe, expect, it } from 'vitest';
import { composePrompt, toComposerContentParts } from '../src/app/utils/composer';

describe('composer image attachments', () => {
  const tinyDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

  it('does not embed data URL content into composed prompt text', () => {
    const prompt = composePrompt('Please inspect this image', [
      { name: 'screenshot.png', dataUrl: tinyDataUrl },
    ]);

    expect(prompt).toContain('Please inspect this image');
    expect(prompt).toContain('[attached 1 image: screenshot.png]');
    expect(prompt).not.toContain('data:image/');
    expect(prompt).not.toContain('base64,');
  });

  it('keeps image binary content in promptParts payload', () => {
    const parts = toComposerContentParts('Please inspect this image', [
      { name: 'screenshot.png', dataUrl: tinyDataUrl },
    ]);

    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'text', text: 'Please inspect this image' });
    expect(parts[1]).toMatchObject({ type: 'image', mimeType: 'image/png', name: 'screenshot.png' });
    if (parts[1]?.type === 'image') {
      expect(parts[1].data).toBe('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB');
    }
  });
});
