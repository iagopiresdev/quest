// ACP stdio bridge — run under Node.js (not Bun) because Bun can't read
// Python asyncio stdout pipes. This script talks to the ACP agent via
// stdio and prints responses to stdout as NDJSON.
// Input: NDJSON on stdin (JSON-RPC requests)
// Output: NDJSON on stdout (JSON-RPC responses + notifications)

import { spawn } from "child_process";

const agentProc = spawn(process.argv[2], process.argv.slice(3), {
  stdio: ["pipe", "pipe", "pipe"],
});

// Forward agent stdout → our stdout
agentProc.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
});

// Forward agent stderr → our stderr (for diagnostics)
agentProc.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

// Forward our stdin → agent stdin
process.stdin.on("data", (chunk) => {
  agentProc.stdin.write(chunk);
});

process.stdin.on("end", () => {
  agentProc.stdin.end();
});

agentProc.on("exit", (code) => {
  process.exit(code ?? 0);
});
