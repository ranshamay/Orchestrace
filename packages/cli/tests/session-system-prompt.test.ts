import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('implementation prompt coordination guidance strings', () => {
  it('uses context-aware todo/agent-graph guidance in cli prompt builders', async () => {
    const [runnerSource, uiServerSource] = await Promise.all([
      readFile(join(process.cwd(), 'src', 'runner.ts'), 'utf8'),
      readFile(join(process.cwd(), 'src', 'ui-server.ts'), 'utf8'),
    ]);

    const expected = 'Use todo/agent graph state from planning already in session context; call todo_get/agent_graph_get only when state is missing, stale, or ambiguous, then keep todo_update current while implementing.';
    const legacy = 'Read todo_get and agent_graph_get before coding, then keep todo_update current while implementing.';

    expect(runnerSource).toContain(expected);
    expect(uiServerSource).toContain(expected);
    expect(runnerSource).not.toContain(legacy);
    expect(uiServerSource).not.toContain(legacy);
  });
});