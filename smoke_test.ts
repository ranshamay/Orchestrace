import { FileEventStore } from './packages/store/src/event-store';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

async function main() {
  const timestamp = Date.now();
  const sessionId = \`smoke-port-\${timestamp}\`;
  const workspaceRoot = process.cwd();
  const storePath = join(workspaceRoot, '.orchestrace', 'sessions');
  const eventStore = new FileEventStore(storePath);

  console.log(\`Creating session: \${sessionId}\`);
  
  const routePrompt = \`
ORCHESTRACE_UI_PORT: \${process.env.ORCHESTRACE_UI_PORT || 'MISSING'}
PLAYWRIGHT_BASE_URL: \${process.env.PLAYWRIGHT_BASE_URL || 'MISSING'}
\`.trim();

  // 1) Create session
  // Note: FileEventStore.saveEvents takes (sessionId, events)
  // According to packages/store/src/types.ts or event-store.ts, the structure might be different.
  // Let's use the actual payload format from the runner.ts inspection.
  
  await eventStore.saveEvents(sessionId, [
    {
      type: 'session:created',
      payload: {
        sessionId,
        prompt: routePrompt,
        testingPorts: { basePort: 46100, apiPort: 46101, uiPort: 46102 },
        config: {
          taskRouting: {
            default: 'shell_command'
          },
          workspacePath: workspaceRoot
        }
      },
      time: new Date().toISOString(),
    }
  ]);

  // 2) Run runner
  console.log('Running runner for that session...');
  try {
    // Run the runner via CLI as intended
    execSync(\`ORCHESTRACE_TASK_ROUTE=shell_command node --import tsx packages/cli/src/runner.ts \${sessionId} \${workspaceRoot}\`, {
      stdio: 'inherit',
      env: { ...process.env, ORCHESTRACE_TASK_ROUTE: 'shell_command' }
    });
  } catch (e) {
    console.log('Runner finished (possibly with non-zero exit code, which is expected if it fails but we still want to read events)');
  }

  // 3) Read session events
  const events = await eventStore.read(sessionId);
  
  let finalStatus = 'UNKNOWN';
  let outputText = 'NOT FOUND';

  for (const event of events) {
    if (event.type === 'session:status-change') {
      finalStatus = event.payload.status;
    }
    if (event.type === 'session:output-set') {
        outputText = event.payload.output;
    }
  }

  console.log(\`Final session status: \${finalStatus}\`);
  console.log(\`Output text from session:output-set: \${outputText}\`);

  // 4) Delete session
  console.log(\`Deleting session: \${sessionId}\`);
  await eventStore.deleteSession(sessionId);
}

main().catch(console.error);
