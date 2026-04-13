import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('NewPromptModal wiring regression checks', () => {
  it('includes escape close handling and prompt reset callback', () => {
    const source = readFileSync(resolve(process.cwd(), 'packages/ui/src/app/components/overlays/NewPromptModal.tsx'), 'utf8');

    expect(source).toContain("const closeModal = useCallback(() => {");
    expect(source).toContain("setPrompt('');");
    expect(source).toContain('onClose();');
    expect(source).toContain("if (event.key === 'Escape') {");
    expect(source).toContain('closeModal();');
    expect(source).toContain("window.addEventListener('keydown', onKeyDown);");
    expect(source).toContain("window.removeEventListener('keydown', onKeyDown);");
  });

  it('submits trimmed prompt only and blocks empty/submitting', () => {
    const source = readFileSync(resolve(process.cwd(), 'packages/ui/src/app/components/overlays/NewPromptModal.tsx'), 'utf8');

    expect(source).toContain('const value = prompt.trim();');
    expect(source).toContain('if (!value || isSubmitting) {');
    expect(source).toContain('void onSubmit(value);');
    expect(source).toContain('disabled={isSubmitting || prompt.trim().length === 0}');
    expect(source).toContain('if (event.target === event.currentTarget && !isSubmitting) {');
  });
});