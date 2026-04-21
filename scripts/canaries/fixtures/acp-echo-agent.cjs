#!/usr/bin/env node

// Minimal ACP echo agent for canary testing.
// Implements enough of the JSON-RPC protocol over stdio to satisfy
// quest's AcpRunnerAdapter lifecycle:
//   initialize → notifications/initialized → session/new → session/prompt → session/close
//
// On session/prompt, writes "fixed" into status.ts and returns a text summary.

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendNotification(method, params) {
  send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
}

function sendResponse(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

rl.on("line", (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (!msg.method) {
    return;
  }

  switch (msg.method) {
    case "initialize": {
      sendResponse(msg.id, {
        capabilities: {},
        protocolVersion: 1,
        serverInfo: { name: "acp-echo-agent", version: "0.0.1" },
      });
      break;
    }

    case "notifications/initialized": {
      break;
    }

    case "session/new": {
      sendResponse(msg.id, {
        sessionId: "echo-session-1",
      });
      break;
    }

    case "session/prompt": {
      try {
        const cwd = msg.params?.cwd ?? process.cwd();
        fs.writeFileSync(path.join(cwd, "status.ts"), 'export const status = "fixed";\n');
      } catch {
        // Write failure still reports completion.
      }

      sendNotification("session/update", {
        update: {
          content: [{ text: "ACP echo agent updated status.ts", type: "text" }],
        },
      });

      sendResponse(msg.id, {
        content: [{ text: "Echo agent finished: status.ts set to fixed.", type: "text" }],
      });

      break;
    }

    case "session/close": {
      sendResponse(msg.id, {});
      break;
    }

    default: {
      if (msg.id !== undefined) {
        sendError(msg.id, -32601, `Method not found: ${msg.method}`);
      }
      break;
    }
  }
});

rl.on("close", () => {
  process.exit(0);
});
