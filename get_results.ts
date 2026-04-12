import path from "node:path";
import { readFileSync } from "node:fs";
import { FileEventStore } from "./packages/store/src/index.ts";
const workspaceRoot = process.cwd();
const sessionId = process.env.SESSION_ID;
if (!sessionId) {
    console.error("missing SESSION_ID");
    process.exit(1);
}
const eventStore = new FileEventStore(path.join(workspaceRoot, ".orchestrace", "sessions"));
async function main() {
    try {
        const events = await eventStore.read(sessionId);
        const statusEvt = [...events].reverse().find((e) => e.type === "session:status-change");
        const outputEvt = [...events].reverse().find((e) => e.type === "session:output-set");
        const errorEvt = [...events].reverse().find((e) => e.type === "session:error-change");
        const text = String(outputEvt?.payload?.output?.text ?? "");
        const pw = text.match(/^PLAYWRIGHT_BASE_URL=.*$/m)?.[0] ?? "PLAYWRIGHT_BASE_URL=missing";
        const ui = text.match(/^ORCHESTRACE_UI_PORT=.*$/m)?.[0] ?? "ORCHESTRACE_UI_PORT=missing";
        console.log("SESSION_STATUS=" + (statusEvt?.payload?.status ?? "missing"));
        console.log(pw);
        console.log(ui);
        console.log("SESSION_ERROR=" + (errorEvt?.payload?.error ?? ""));
        const runnerLog = readFileSync("/tmp/" + sessionId + ".runner.log", "utf-8");
        const routingLine = runnerLog.split("\n").find((line) => line.includes("task:routing") && line.includes("Route selected")) ?? "ROUTE_LINE=missing";
        console.log("ROUTE_LINE=" + routingLine);
    } catch (e) {
        console.error(e);
    }
}
main();
