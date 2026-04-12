import { readFileSync, existsSync } from "node:fs";
const sessionId = process.env.SESSION_ID;
const logPath = `/tmp/${sessionId}.runner.log`;
if (existsSync(logPath)) {
    console.log(readFileSync(logPath, "utf-8"));
} else {
    console.log("Log file not found at " + logPath);
}
