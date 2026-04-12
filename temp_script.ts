import { FileEventStore } from './packages/store/src/file-event-store';
import { EventStore } from './packages/store/src/event-store';
import { OrchestraceStore } from './packages/store/src/orchestrace-store';
import { OrchestraceRunner } from './packages/runner/src/orchestrace-runner';
import path from 'path';
import fs from 'fs';

async function run() {
    const timestamp = Date.now();
    const sessionId = `smoke-port-${timestamp}`;
    const storagePath = path.join(process.cwd(), '.orchestrace-test');
    
    if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
    }

    const eventStore = new FileEventStore({ storagePath });
    const store = new OrchestraceStore(eventStore);

    // 1) Create session
    await store.createSession(sessionId, {
        testingPorts: { basePort: 46100, apiPort: 46101, uiPort: 46102 }
    });

    // 2) Set prompt
    const prompt = 'node -e "console.log([\'UI=\'+(process.env.ORCHESTRACE_UI_PORT||\'MISSING\'),\'PW=\'+(process.env.PLAYWRIGHT_BASE_URL||\'MISSING\'),\'CY=\'+(process.env.CYPRESS_BASE_URL||\'MISSING\')].join(\'|\'))"';
    await store.updateSession(sessionId, { prompt });

    // 3) Run runner
    process.env.ORCHESTRACE_TASK_ROUTE = 'shell_command';
    const runner = new OrchestraceRunner(store);
    await runner.run(sessionId);

    // 4) Read events and prints
    const events = await eventStore.getEvents(sessionId);
    
    const statusEvent = [...events].reverse().find(e => e.type === 'session:status-change');
    const outputEvent = [...events].reverse().find(e => e.type === 'session:output-set');

    console.log(`RESULT_STATUS=${statusEvent?.data?.status}`);
    console.log(`RESULT_OUTPUT=${outputEvent?.data?.output?.replace(/\n/g, ' ')}`);

    // 5) Delete the session
    await store.deleteSession(sessionId);
}

run().catch(console.error);
