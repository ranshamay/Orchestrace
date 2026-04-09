import { describe, expect, it } from 'vitest';

const REQUIRED_EXPORTS = [
  'buildSessionSystemPrompt',
  'enforcePlanningToolCallGuard',
  'getSessionPlanningGuardState',
  'isSimpleSessionTaskPrompt',
] as const;

describe('ui-server exports', () => {
  it('exposes required planning and prompt helper exports', async () => {
    const uiServerModule = await import('../src/ui-server.js');

    for (const exportName of REQUIRED_EXPORTS) {
      expect(uiServerModule).toHaveProperty(exportName);
      expect(typeof uiServerModule[exportName]).toBe('function');
    }
  });
});