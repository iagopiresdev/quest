#!/usr/bin/env bun

// YAML spec lifecycle canary.
//
// Proves that a YAML-formatted spec dropped into the daemon inbox is parsed,
// planned, executed, and landed end-to-end, with the same observability contract
// as a JSON spec. Closes the "YAML specs: untested end-to-end" gap from
// FEEDBACK → Daemon Testing (2026-04-14).
//
// Steps:
//   1. Spawn a local webhook server that captures posted events.
//   2. Register a local-command worker that writes the artifact named by the slice.
//   3. Configure a webhook sink subscribed to the 5 daemon lifecycle events.
//   4. Create a party and drop a `.yaml` spec into its inbox.
//   5. Trigger one `quest daemon tick`.
//   6. Assert: daemon_dispatched + daemon_landed hit the webhook, the artifact
//      landed in the source repo, the inbox drained, the done/ queue counted, and
//      the delivery store persisted the daemon_landed record.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type CapturedEvent = {
  eventType: string;
  partyName?: string | null | undefined;
  runId?: string | null | undefined;
  specFile?: string | null | undefined;
};

type DaemonStatus = {
  parties: Array<{
    party: { name: string };
    activeRunIds?: string[];
    lastError?: string | null;
    queueDepths?: {
      done?: number;
      failed?: number;
      inbox?: number;
      running?: number;
    };
  }>;
};

type CanaryResult = {
  capturedEventTypes: string[];
  dispatchedEvent: CapturedEvent | null;
  landedEvent: CapturedEvent | null;
  artifactLanded: boolean;
  doneCount: number;
  failedCount: number;
  inboxCount: number;
  activeRunIds: number;
  landedDeliveryFound: boolean;
  stateRoot: string;
};

const projectRoot = resolve(import.meta.dir, "..", "..");

const DEBUG = process.env.QUEST_CANARY_DEBUG === "1";

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
  return stdout;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

async function initRepo(repoPath: string, env: Record<string, string>): Promise<void> {
  mkdirSync(repoPath, { recursive: true });
  await runCommandOrThrow(["git", "init"], repoPath, env);
  await runCommandOrThrow(["git", "config", "user.name", "YAML Canary"], repoPath, env);
  await runCommandOrThrow(
    ["git", "config", "user.email", "yaml-canary@example.com"],
    repoPath,
    env,
  );
  writeFileSync(join(repoPath, "seed.txt"), "seed\n", "utf8");
  await runCommandOrThrow(["git", "add", "seed.txt"], repoPath, env);
  await runCommandOrThrow(["git", "commit", "-m", "Initial commit"], repoPath, env);
  await runCommandOrThrow(["git", "branch", "-M", "main"], repoPath, env);
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
        profile: "yaml-spec-canary",
        runner: "custom",
        toolPolicy: { allow: [], deny: [] },
      },
      calibration: { history: [] },
      class: "engineer",
      enabled: true,
      id: "yaml-spec-canary",
      name: "YAML Spec Canary",
      persona: {
        approach: "write the artifact the slice names",
        prompt: "Write the file named by slice.owns[0].",
        voice: "direct",
      },
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
      title: "YAML Spec Canary",
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
      "yaml-canary-webhook",
      "--url",
      url,
      "--events",
      "daemon_dispatched,daemon_landed,daemon_failed,daemon_budget_exhausted,daemon_recovered",
    ],
    projectRoot,
    env,
  );
}

// YAML specs are the whole point: hand-authored YAML (no JSON-to-YAML dump)
// proves the daemon's `Bun.YAML.parse` path, the spec schema coercion, and the
// acceptance command carries through the pipeline unchanged.
const YAML_SPEC_CONTENT = `version: 1
title: YAML Spec Canary
workspace: yaml-spec-canary
priority: 1
retry_count: 0
retry_limit: 0
maxParallel: 1
hotspots: []
featureDoc:
  enabled: false
execution:
  preInstall: false
  shareSourceDependencies: true
  testerSelectionStrategy: balanced
  timeoutMinutes: 10
acceptanceChecks:
  - argv:
      - bun
      - -e
      - |
        const text = await Bun.file('hello-yaml.txt').text();
        if (!text.includes('yaml')) process.exit(1);
    env: {}
slices:
  - id: hello
    title: Hello YAML
    goal: Write hello-yaml.txt so acceptance passes.
    discipline: coding
    owns:
      - hello-yaml.txt
    acceptanceChecks: []
    contextHints: []
    dependsOn: []
`;

function writeYamlSpec(inboxDir: string, fileName: string): void {
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(join(inboxDir, fileName), YAML_SPEC_CONTENT, "utf8");
}

function writeWorkerScript(workerScriptPath: string): void {
  writeFileSync(
    workerScriptPath,
    [
      "const payload = JSON.parse(await Bun.stdin.text());",
      "const artifact = payload.slice?.owns?.[0];",
      "if (!artifact) throw new Error('slice has no owns path');",
      "await Bun.write(artifact, 'yaml\\n');",
      "",
    ].join("\n"),
    "utf8",
  );
}

function startWebhookServer(captured: CapturedEvent[]): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    async fetch(request) {
      if (request.method !== "POST") {
        return new Response("ok");
      }
      try {
        const body = (await request.json()) as Record<string, unknown>;
        captured.push({
          eventType: String(body.eventType ?? ""),
          partyName: (body.partyName as string | null | undefined) ?? null,
          runId: (body.runId as string | null | undefined) ?? null,
          specFile: (body.specFile as string | null | undefined) ?? null,
        });
      } catch {
        // ignore bad bodies; test asserts on what we actually captured
      }
      return new Response("ok");
    },
    port: 0,
  });
}

function findCaptured(captured: CapturedEvent[], eventType: string): CapturedEvent | null {
  return captured.find((event) => event.eventType === eventType) ?? null;
}

async function readDaemonStatus(env: Record<string, string>): Promise<DaemonStatus> {
  const raw = await runCommandOrThrow(["./bin/quest", "daemon", "status"], projectRoot, env);
  return JSON.parse(raw) as DaemonStatus;
}

async function countLandedDeliveries(env: Record<string, string>): Promise<number> {
  const raw = await runCommandOrThrow(
    [
      "./bin/quest",
      "observability",
      "deliveries",
      "list",
      "--sink-id",
      "yaml-canary-webhook",
      "--event-type",
      "daemon_landed",
    ],
    projectRoot,
    env,
  );
  const payload = JSON.parse(raw) as {
    deliveries: Array<{ eventType: string }>;
  };
  return payload.deliveries.filter((entry) => entry.eventType === "daemon_landed").length;
}

function buildAssertions(result: CanaryResult): Array<[boolean, string]> {
  return [
    [result.dispatchedEvent !== null, "daemon_dispatched never hit the webhook"],
    [result.landedEvent !== null, "daemon_landed never hit the webhook"],
    [
      result.dispatchedEvent?.specFile === "hello.yaml",
      `daemon_dispatched specFile should be hello.yaml, got ${String(result.dispatchedEvent?.specFile)}`,
    ],
    [
      result.landedEvent?.specFile === "hello.yaml",
      `daemon_landed specFile should be hello.yaml, got ${String(result.landedEvent?.specFile)}`,
    ],
    [result.artifactLanded, "hello-yaml.txt should exist in source repo after landing"],
    [result.doneCount >= 1, "party should have >=1 spec in done/"],
    [result.failedCount === 0, "party should have 0 specs in failed/"],
    [result.inboxCount === 0, "party inbox should be drained"],
    [result.activeRunIds === 0, "party should have no lingering activeRunIds"],
    [result.landedDeliveryFound, "daemon_landed was not persisted as a delivery record"],
  ];
}

function printResult(result: CanaryResult): void {
  console.log("YAML Spec Lifecycle Canary");
  console.log(`  captured events: ${result.capturedEventTypes.join(", ")}`);
  console.log(
    `  daemon_dispatched: ${result.dispatchedEvent?.specFile ?? "-"} / run=${result.dispatchedEvent?.runId ?? "-"}`,
  );
  console.log(
    `  daemon_landed:     ${result.landedEvent?.specFile ?? "-"} / run=${result.landedEvent?.runId ?? "-"}`,
  );
  console.log(`  artifact on disk:  ${result.artifactLanded}`);
  console.log(
    `  queue depths:      done=${result.doneCount} failed=${result.failedCount} inbox=${result.inboxCount} active=${result.activeRunIds}`,
  );
  console.log(`  delivery persisted: ${result.landedDeliveryFound}`);
  console.log(`  state root: ${result.stateRoot}`);
}

async function runScenario(
  stateRoot: string,
  sourceRepo: string,
  workerScriptPath: string,
  webhookUrl: string,
  env: Record<string, string>,
  captured: CapturedEvent[],
): Promise<CanaryResult> {
  await initRepo(sourceRepo, env);
  await registerLocalWorker(workerScriptPath, env);
  await configureWebhookSink(webhookUrl, env);

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

  const inboxDir = join(stateRoot, "parties", "alpha", "inbox");
  writeYamlSpec(inboxDir, "hello.yaml");

  // One daemon tick. The YAML spec should be parsed, planned, executed, landed.
  await runCommandOrThrow(["./bin/quest", "daemon", "tick"], projectRoot, env);

  // Give the webhook server a moment to process queued requests before reading captured.
  await Bun.sleep(200);

  const status = await readDaemonStatus(env);
  const partyEntry = status.parties.find((candidate) => candidate.party.name === "alpha");
  const landedDeliveries = await countLandedDeliveries(env);

  return {
    capturedEventTypes: captured.map((event) => event.eventType),
    dispatchedEvent: findCaptured(captured, "daemon_dispatched"),
    landedEvent: findCaptured(captured, "daemon_landed"),
    artifactLanded: existsSync(join(sourceRepo, "hello-yaml.txt")),
    doneCount: partyEntry?.queueDepths?.done ?? 0,
    failedCount: partyEntry?.queueDepths?.failed ?? 0,
    inboxCount: partyEntry?.queueDepths?.inbox ?? 0,
    activeRunIds: (partyEntry?.activeRunIds ?? []).length,
    landedDeliveryFound: landedDeliveries >= 1,
    stateRoot,
  };
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const root = mkdtempSync(join(tmpdir(), "quest-yaml-spec-canary-"));
  const stateRoot = join(root, "state");
  const sourceRepo = join(root, "source-repo");
  const workerScriptPath = join(root, "canary-worker.ts");
  mkdirSync(stateRoot, { recursive: true });
  writeWorkerScript(workerScriptPath);

  const env = {
    ...Bun.env,
    QUEST_STATE_ROOT: stateRoot,
  } as Record<string, string>;

  const captured: CapturedEvent[] = [];
  const server = startWebhookServer(captured);
  const webhookUrl = `http://127.0.0.1:${server.port}/webhook`;

  try {
    const result = await runScenario(
      stateRoot,
      sourceRepo,
      workerScriptPath,
      webhookUrl,
      env,
      captured,
    );

    const failures = buildAssertions(result)
      .filter(([passed]) => !passed)
      .map(([, msg]) => msg);
    if (failures.length > 0) {
      throw new Error(
        `YAML spec lifecycle canary failed:\n  - ${failures.join("\n  - ")}\n\ncaptured=${JSON.stringify(captured, null, 2)}`,
      );
    }

    if (hasFlag(args, "--json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    printResult(result);
  } finally {
    server.stop();
    if (!hasFlag(args, "--keep")) {
      rmSync(root, { force: true, recursive: true });
    }
  }
}

await main();
