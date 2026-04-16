#!/usr/bin/env bun

// Daemon observability events canary.
//
// Proves end-to-end that a real daemon tick emits the five v1 lifecycle events
// and that they reach a configured webhook sink through the shared dispatcher.
//
// Steps:
//   1. Spawn a local webhook server that captures every POSTed event.
//   2. Register a local-command worker that writes a trivial file.
//   3. Configure a webhook sink subscribed to the 5 daemon events + run_failed.
//   4. Create a party and drop a valid spec into its inbox.
//   5. Run a single-shot `quest daemon tick` and assert the webhook captured
//      daemon_dispatched and daemon_landed for the processed spec.
//   6. Verify the daemon_landed event is persisted in the deliveries store.
//   7. Re-run the tick with an invalid spec to prove daemon_failed fires.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type CapturedEvent = {
  eventType: string;
  kind?: string | undefined;
  partyName?: string | null | undefined;
  runId?: string | null | undefined;
  specFile?: string | null | undefined;
};

type CanaryResult = {
  capturedEventTypes: string[];
  dispatchedEvent: CapturedEvent | null;
  landedEvent: CapturedEvent | null;
  failedEvent: CapturedEvent | null;
  landedDeliveryFound: boolean;
  stateRoot: string;
};

const projectRoot = resolve(import.meta.dir, "..", "..");

const DEBUG = process.env.QUEST_CANARY_DEBUG === "1";

// Bun.spawnSync hangs when a subprocess shells out to grandchildren that inherit pipes.
// The async path reads the streams to completion while still letting us throw on non-zero exits.
async function runCommandOrThrow(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
  input?: string,
): Promise<string> {
  if (DEBUG) {
    console.error(`[canary] $ ${cmd.join(" ")}`);
  }
  const proc = Bun.spawn({
    cmd,
    cwd,
    env,
    stdin: input ? new TextEncoder().encode(input) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Command failed (${cmd.join(" ")}):\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  if (DEBUG) {
    console.error(`[canary] ← exit=0 stderrBytes=${stderr.length} stdoutBytes=${stdout.length}`);
  }
  return stdout;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

async function registerLocalWorker(
  workerScriptPath: string,
  env: Record<string, string>,
): Promise<void> {
  await runCommandOrThrow(
    ["./bin/quest", "workers", "upsert", "--stdin"],
    projectRoot,
    env,
    JSON.stringify({
      backend: {
        adapter: "local-command",
        command: ["bun", workerScriptPath],
        profile: "daemon-events-canary",
        runner: "custom",
        toolPolicy: { allow: [], deny: [] },
      },
      calibration: { history: [] },
      class: "engineer",
      enabled: true,
      id: "daemon-events-canary",
      name: "Daemon Events Canary",
      persona: { approach: "write the file", prompt: "Write hello.txt.", voice: "direct" },
      progression: { level: 1, xp: 0 },
      role: "hybrid",
      resources: { cpuCost: 1, gpuCost: 0, maxParallel: 1, memoryCost: 1 },
      stats: {
        coding: 70,
        contextEndurance: 50,
        docs: 20,
        mergeSafety: 70,
        research: 20,
        speed: 40,
        testing: 60,
      },
      tags: ["canary"],
      title: "Daemon Events Canary",
      trust: { calibratedAt: new Date().toISOString(), rating: 0.8 },
    }),
  );
}

async function configureWebhookSink(url: string, env: Record<string, string>): Promise<void> {
  await runCommandOrThrow(
    [
      "./bin/quest",
      "observability",
      "webhook",
      "upsert",
      "--id",
      "daemon-canary-webhook",
      "--url",
      url,
      "--events",
      "daemon_dispatched,daemon_landed,daemon_failed,daemon_budget_exhausted,daemon_recovered",
    ],
    projectRoot,
    env,
  );
}

async function createPartyAndSpec(
  env: Record<string, string>,
  sourceRepo: string,
  inboxDir: string,
): Promise<void> {
  await runCommandOrThrow(
    [
      "./bin/quest",
      "party",
      "create",
      "--name",
      "alpha",
      "--source-repo",
      sourceRepo,
      "--target-ref",
      "main",
    ],
    projectRoot,
    env,
  );

  writeFileSync(
    join(inboxDir, "hello.json"),
    JSON.stringify({
      priority: 1,
      retry_count: 0,
      retry_limit: 0,
      acceptanceChecks: [
        {
          argv: [
            "bun",
            "-e",
            "const text = await Bun.file('hello.txt').text(); if (!text.includes('canary')) process.exit(1);",
          ],
          env: {},
        },
      ],
      execution: {
        preInstall: false,
        shareSourceDependencies: true,
        testerSelectionStrategy: "balanced",
        timeoutMinutes: 10,
      },
      featureDoc: { enabled: false },
      hotspots: [],
      maxParallel: 1,
      slices: [
        {
          acceptanceChecks: [],
          contextHints: [],
          dependsOn: [],
          discipline: "coding",
          goal: "Write hello.txt so acceptance passes.",
          id: "hello",
          owns: ["hello.txt"],
          title: "Hello",
        },
      ],
      title: "Daemon Events Canary",
      version: 1,
      workspace: "daemon-events-canary",
    }),
    "utf8",
  );
}

function findCaptured(
  captured: CapturedEvent[],
  eventType: string,
  specFile: string,
): CapturedEvent | null {
  return (
    captured.find((event) => event.eventType === eventType && event.specFile === specFile) ?? null
  );
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const root = mkdtempSync(join(tmpdir(), "quest-daemon-events-canary-"));
  const stateRoot = join(root, "state");
  const sourceRepo = join(root, "source-repo");
  const workerScriptPath = join(root, "canary-worker.ts");
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(sourceRepo, { recursive: true });
  writeFileSync(workerScriptPath, "await Bun.write('hello.txt', 'canary\\n');\n", "utf8");

  const env = {
    ...Bun.env,
    QUEST_RUNNER_STATE_ROOT: stateRoot,
  } as Record<string, string>;

  const captured: CapturedEvent[] = [];
  const server = Bun.serve({
    async fetch(request) {
      if (request.method !== "POST") {
        return new Response("ok");
      }
      try {
        const body = (await request.json()) as Record<string, unknown>;
        captured.push({
          eventType: String(body.eventType ?? ""),
          kind: typeof body.kind === "string" ? body.kind : undefined,
          partyName: (body.partyName as string | null | undefined) ?? null,
          runId: (body.runId as string | null | undefined) ?? null,
          specFile: (body.specFile as string | null | undefined) ?? null,
        });
      } catch {
        // ignore bad bodies; test verifies what we actually captured
      }
      return new Response("ok");
    },
    port: 0,
  });

  const webhookUrl = `http://127.0.0.1:${server.port}/webhook`;

  try {
    await runCommandOrThrow(["git", "init"], sourceRepo, env);
    await runCommandOrThrow(["git", "config", "user.name", "Daemon Canary"], sourceRepo, env);
    await runCommandOrThrow(
      ["git", "config", "user.email", "daemon-canary@example.com"],
      sourceRepo,
      env,
    );
    writeFileSync(join(sourceRepo, "seed.txt"), "seed\n", "utf8");
    await runCommandOrThrow(["git", "add", "seed.txt"], sourceRepo, env);
    await runCommandOrThrow(["git", "commit", "-m", "Initial commit"], sourceRepo, env);
    await runCommandOrThrow(["git", "branch", "-M", "main"], sourceRepo, env);

    await registerLocalWorker(workerScriptPath, env);
    await configureWebhookSink(webhookUrl, env);

    const inboxDir = join(stateRoot, "parties", "alpha", "inbox");
    mkdirSync(inboxDir, { recursive: true });
    await createPartyAndSpec(env, sourceRepo, inboxDir);

    const partyStatusRaw = await runCommandOrThrow(
      ["./bin/quest", "daemon", "status"],
      projectRoot,
      env,
    );
    const partyStatus = JSON.parse(partyStatusRaw) as {
      parties: Array<{ party: { name: string } }>;
    };
    const alphaParty = partyStatus.parties.find((entry) => entry.party.name === "alpha");
    if (!alphaParty) {
      throw new Error("party alpha was not registered");
    }

    // Trigger one tick. This should plan → run → execute → land for the one spec.
    await runCommandOrThrow(["./bin/quest", "daemon", "tick"], projectRoot, env);

    // Give the webhook server a moment to process queued requests before reading captured.
    await Bun.sleep(150);

    const dispatched = findCaptured(captured, "daemon_dispatched", "hello.json");
    const landed = findCaptured(captured, "daemon_landed", "hello.json");

    // Now drop an unreadable spec to trigger daemon_failed.
    writeFileSync(join(inboxDir, "broken.json"), "{\n", "utf8");
    await runCommandOrThrow(["./bin/quest", "daemon", "tick"], projectRoot, env);
    await Bun.sleep(150);

    const failed = findCaptured(captured, "daemon_failed", "broken.json");

    // Verify the delivery store persisted the daemon_landed webhook delivery.
    const deliveriesRaw = await runCommandOrThrow(
      [
        "./bin/quest",
        "observability",
        "deliveries",
        "list",
        "--sink-id",
        "daemon-canary-webhook",
        "--event-type",
        "daemon_landed",
      ],
      projectRoot,
      env,
    );
    const deliveriesPayload = JSON.parse(deliveriesRaw) as {
      deliveries: Array<{ eventType: string; status: string }>;
    };
    const landedDeliveryFound = deliveriesPayload.deliveries.some(
      (entry) => entry.eventType === "daemon_landed",
    );

    if (!dispatched) {
      throw new Error(
        `daemon_dispatched never hit the webhook. captured=${JSON.stringify(captured)}`,
      );
    }
    if (!landed) {
      throw new Error(`daemon_landed never hit the webhook. captured=${JSON.stringify(captured)}`);
    }
    if (!failed) {
      throw new Error(`daemon_failed never hit the webhook. captured=${JSON.stringify(captured)}`);
    }
    if (!landedDeliveryFound) {
      throw new Error("daemon_landed was not persisted as a delivery record");
    }

    const result: CanaryResult = {
      capturedEventTypes: captured.map((event) => event.eventType),
      dispatchedEvent: dispatched,
      landedEvent: landed,
      failedEvent: failed,
      landedDeliveryFound,
      stateRoot,
    };

    if (hasFlag(args, "--json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log("Daemon Events Canary");
    console.log(`  captured event types: ${result.capturedEventTypes.join(", ")}`);
    console.log(`  daemon_dispatched: ${dispatched.specFile} / run=${dispatched.runId ?? "-"}`);
    console.log(`  daemon_landed:     ${landed.specFile} / run=${landed.runId ?? "-"}`);
    console.log(`  daemon_failed:     ${failed.specFile}`);
    console.log(`  delivery persisted: ${landedDeliveryFound}`);
    console.log(`  state root: ${result.stateRoot}`);
  } finally {
    server.stop();
    if (!hasFlag(args, "--keep")) {
      rmSync(root, { force: true, recursive: true });
    }
  }
}

await main();
