import { describe, expect, it } from 'vitest';
import {
  OBSERVER_SYSTEM_PROMPT,
  REALTIME_OBSERVER_SYSTEM_PROMPT,
} from '../src/observer/prompts.js';

describe('observer implementation-phase efficiency guidance', () => {
  it('includes implementation rediscovery anti-pattern in realtime prompt', () => {
    expect(REALTIME_OBSERVER_SYSTEM_PROMPT).toContain('implementation');
    expect(REALTIME_OBSERVER_SYSTEM_PROMPT).toContain('repeated list/read/search');
        expect(REALTIME_OBSERVER_SYSTEM_PROMPT).toContain('without write_file/edit_file progress');
  });

  it('includes implementation rediscovery anti-pattern in offline prompt', () => {
    expect(OBSERVER_SYSTEM_PROMPT).toContain('implementation');
    expect(OBSERVER_SYSTEM_PROMPT).toContain('repeated list/read/search');
        expect(OBSERVER_SYSTEM_PROMPT).toContain('with no write_file/edit_file progress');
  });
});