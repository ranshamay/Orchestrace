import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OBSERVER_SYSTEM_PROMPT,
  REALTIME_OBSERVER_SYSTEM_PROMPT,
} from '../src/observer/prompts.js';

describe('observer efficiency guidance prompts', () => {
  it('includes implementation-phase anti-redundant-read instructions in both system prompts', () => {
    for (const prompt of [OBSERVER_SYSTEM_PROMPT, REALTIME_OBSERVER_SYSTEM_PROMPT]) {
      expect(prompt).toContain('reuse planning-phase file context when available');
      expect(prompt).toContain('one consolidated `read_files`');
      expect(prompt).toContain('immediately');
      expect(prompt).toContain('write/edit');
    }
  });

  it('requires analyzer-generated evidence to be execution-ready for redundant read findings', () => {
    const analyzerPath = join(process.cwd(), 'src', 'observer', 'analyzer.ts');
    const analyzerSource = readFileSync(analyzerPath, 'utf-8');

    expect(analyzerSource).toContain('Evidence quality requirements');
    expect(analyzerSource).toContain('implementation-ready and directly executable');
        expect(analyzerSource).toContain('reuse planning-phase file context when available');
    expect(analyzerSource).toContain('one consolidated \\`read_files\\` batch');
    expect(analyzerSource).toContain('no read-think loop');
  });
});
