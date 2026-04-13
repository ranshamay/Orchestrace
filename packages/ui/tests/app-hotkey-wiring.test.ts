import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('App global new prompt hotkey wiring', () => {
  it('registers Cmd/Ctrl+K hotkey and opens NewPromptModal with editable guard', () => {
    const appSource = readFileSync(resolve(process.cwd(), 'packages/ui/src/App.tsx'), 'utf8');

    expect(appSource).toContain('(event.metaKey || event.ctrlKey) && event.key.toLowerCase() === \'k\'');
    expect(appSource).toContain('setIsNewPromptModalOpen(true);');
    expect(appSource).toContain('event.preventDefault();');
    expect(appSource).toContain("target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'");
    expect(appSource).toContain("window.addEventListener('keydown', onKeyDown);");
    expect(appSource).toContain("window.removeEventListener('keydown', onKeyDown);");
  });
});