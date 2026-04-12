import { describe, expect, it } from 'vitest';
import {
  OBSERVER_SYSTEM_PROMPT,
  REALTIME_OBSERVER_SYSTEM_PROMPT,
} from '../src/observer/prompts.js';

describe('observer prompt severity calibration', () => {
  it('includes strict severity calibration language in batch observer prompt', () => {
    expect(OBSERVER_SYSTEM_PROMPT).toContain('Severity calibration (apply strictly)');
    expect(OBSERVER_SYSTEM_PROMPT).toContain('Default to medium/low unless evidence clearly justifies high/critical');
    expect(OBSERVER_SYSTEM_PROMPT).toContain('Respond ONLY with valid JSON matching the requested schema.');
  });

  it('includes strict severity calibration language in realtime observer prompt', () => {
    expect(REALTIME_OBSERVER_SYSTEM_PROMPT).toContain('Severity calibration (apply strictly)');
    expect(REALTIME_OBSERVER_SYSTEM_PROMPT).toContain('Default to medium/low unless evidence clearly justifies high/critical');
    expect(REALTIME_OBSERVER_SYSTEM_PROMPT).toContain('Respond ONLY with valid JSON matching the requested schema.');
  });
});