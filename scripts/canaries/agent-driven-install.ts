#!/usr/bin/env bun
// Canary: "AI agent installs Quest Runner on a machine that already runs OpenClaw / Hermes".
//
// Verifies the non-interactive install flow an AI assistant would follow end-to-end:
//   1. `quest doctor --json` reports healthy binary + writable state root.
//   2. `quest observability telegram upsert --parse-mode HTML` wires the sink, pointed at a real
//      local HTTP server pretending to be the Telegram Bot API.
//   3. `quest party create` triggers a `daemon_party_created` event that flows through the
//      dispatcher → Telegram handler → our fake API. The canary asserts the captured payload is
//      an HTML card with the RPG flavor copy.
//
// The canary uses `--bot-token-env` instead of `--bot-token-secret-ref` so it doesn't have to
// touch the macOS Keychain (the secret-store path is covered by `test/setup-detection.test.ts`
// and the unit tests under `test/telegram-sink-plan.test.ts`).
//
// Runs against the installed `quest` binary on `$PATH`. For a hermetic build, run
// `bun run install:local` first.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

type CanaryResult = {
  capturedSamples: string[];
  doctorExit: number;
  htmlCardDelivered: boolean;
  partyCreateExit: number;
  partyRemoveExit: number;
  sinkUpsertExit: number;
  stateRoot: string;
};

async function reserveLocalPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const tmp = createServer();
    tmp.listen(0, "127.0.0.1", () => {
      const addr = tmp.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("unable to reserve port"));
        return;
      }
      const port = addr.port;
      tmp.close(() => resolve(port));
    });
    tmp.once("error", reject);
  });
}

async function runQuest(
  args: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn({
    cmd: ["quest", ...args],
    env: { ...Bun.env, ...env },
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function main(): Promise<CanaryResult> {
  console.error("[canary] booting");
  const root = mkdtempSync(join(tmpdir(), "quest-agent-install-"));
  const stateRoot = join(root, "state");
  const captured: Array<{ body: string; path: string }> = [];

  mkdirSync(stateRoot, { recursive: true });

  const port = await reserveLocalPort();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    captured.push({
      body: Buffer.concat(chunks).toString("utf8"),
      path: request.url ?? "/",
    });
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  try {
    const env: Record<string, string> = {
      QUEST_RUNNER_STATE_ROOT: stateRoot,
      QUEST_AGENT_CANARY_TOKEN: "999:AGENT-CANARY-TOKEN",
    };

    console.error("[canary] step 1: doctor");
    const doctor = await runQuest(["doctor", "--json", "--state-root", stateRoot], env);
    console.error(`[canary] doctor exit=${doctor.exitCode}`);

    console.error("[canary] step 2: telegram sink upsert (HTML cards)");
    const sinkUpsert = await runQuest(
      [
        "observability",
        "telegram",
        "upsert",
        "--id",
        "agent-telegram",
        "--chat-id",
        "123456789",
        "--bot-token-env",
        "QUEST_AGENT_CANARY_TOKEN",
        "--api-base-url",
        `http://127.0.0.1:${port}`,
        "--parse-mode",
        "HTML",
        "--events",
        "daemon_party_created,daemon_party_resting,daemon_party_resumed",
        "--state-root",
        stateRoot,
      ],
      env,
    );
    console.error(`[canary] sink upsert exit=${sinkUpsert.exitCode}`);
    if (sinkUpsert.exitCode !== 0) {
      console.error(`[canary] sink upsert stderr: ${sinkUpsert.stderr.slice(0, 400)}`);
    }

    console.error("[canary] step 3: party create (emits daemon_party_created)");
    const repoPath = join(root, "repo");
    mkdirSync(repoPath, { recursive: true });
    const partyCreate = await runQuest(
      [
        "party",
        "create",
        "--name",
        "agent-canary",
        "--source-repo",
        repoPath,
        "--target-ref",
        "main",
        "--state-root",
        stateRoot,
      ],
      env,
    );
    console.error(`[canary] party create exit=${partyCreate.exitCode}`);

    // Give the async delivery a tick to flush through the handler + our server's async handler.
    await Bun.sleep(300);

    console.error("[canary] step 4: party remove (cleanup)");
    const partyRemove = await runQuest(
      ["party", "remove", "--name", "agent-canary", "--state-root", stateRoot],
      env,
    );
    console.error(`[canary] party remove exit=${partyRemove.exitCode}`);

    const htmlCards = captured.filter((c) => c.body.includes("<b>Party Assembled</b>"));

    return {
      capturedSamples: captured.slice(0, 3).map((c) => c.body.slice(0, 280)),
      doctorExit: doctor.exitCode,
      htmlCardDelivered: htmlCards.length > 0,
      partyCreateExit: partyCreate.exitCode,
      partyRemoveExit: partyRemove.exitCode,
      sinkUpsertExit: sinkUpsert.exitCode,
      stateRoot,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { force: true, recursive: true });
  }
}

let result: CanaryResult;
try {
  result = await main();
} catch (err) {
  console.error(
    `[canary] main() threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(2);
}

const allGood =
  result.doctorExit === 0 &&
  result.sinkUpsertExit === 0 &&
  result.partyCreateExit === 0 &&
  result.partyRemoveExit === 0 &&
  result.htmlCardDelivered;

console.log("Agent-Driven Install Canary");
console.log(`  doctor: exit=${result.doctorExit}`);
console.log(`  telegram sink upsert: exit=${result.sinkUpsertExit}`);
console.log(`  party create: exit=${result.partyCreateExit}`);
console.log(`  party remove: exit=${result.partyRemoveExit}`);
console.log(`  HTML card delivered to fake Telegram: ${result.htmlCardDelivered}`);
if (!allGood && result.capturedSamples.length > 0) {
  console.log(`  captured samples (first 3):`);
  for (const sample of result.capturedSamples) {
    console.log(`    - ${sample}`);
  }
}

if (!allGood) {
  process.exit(1);
}
