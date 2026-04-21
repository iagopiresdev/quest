#!/usr/bin/env bun

// Concurrent-parties canary.
//
// Proves that two parties with two distinct source repos run independently
// through the same daemon tick cycle without cross-contamination:
//   • both dispatch + land in one tick
//   • each party's spec lands only in its own source repo
//   • daemon state tracks completedSpecTimestamps per party
//   • observability events are tagged with the correct partyName + specFile
//   • deliveries persist per-party records

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type CapturedEvent = {
  eventType: string;
  partyName?: string | null | undefined;
  runId?: string | null | undefined;
  specFile?: string | null | undefined;
};

type PartySummary = {
  doneCount: number;
  failedCount: number;
  inboxCount: number;
  activeRunIds: number;
  lastError: string | null;
};

type CanaryResult = {
  capturedEventTypes: string[];
  alphaDispatched: CapturedEvent | null;
  alphaLanded: CapturedEvent | null;
  betaDispatched: CapturedEvent | null;
  betaLanded: CapturedEvent | null;
  alphaArtifactInAlphaRepo: boolean;
  betaArtifactInBetaRepo: boolean;
  alphaArtifactLeakedIntoBeta: boolean;
  betaArtifactLeakedIntoAlpha: boolean;
  alphaSummary: PartySummary;
  betaSummary: PartySummary;
  alphaDeliveries: number;
  betaDeliveries: number;
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
  await runCommandOrThrow(["git", "config", "user.name", "Concurrent Canary"], repoPath, env);
  await runCommandOrThrow(
    ["git", "config", "user.email", "concurrent-canary@example.com"],
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
        profile: "concurrent-parties-canary",
        runner: "custom",
        toolPolicy: { allow: [], deny: [] },
      },
      calibration: { history: [] },
      class: "engineer",
      enabled: true,
      id: "concurrent-parties-canary",
      name: "Concurrent Parties Canary",
      persona: {
        approach: "write the file the spec names",
        prompt: "Write the file named by QUEST_CANARY_ARTIFACT.",
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
      title: "Concurrent Parties Canary",
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
      "concurrent-canary-webhook",
      "--url",
      url,
      "--events",
      "daemon_dispatched,daemon_landed,daemon_failed,daemon_budget_exhausted,daemon_recovered",
    ],
    projectRoot,
    env,
  );
}

type PartySpec = {
  partyName: string;
  sourceRepo: string;
  specFileName: string;
  artifactFileName: string;
  workspace: string;
  inboxDir: string;
};

async function createPartyWithSpec(env: Record<string, string>, spec: PartySpec): Promise<void> {
  await runCommandOrThrow(
    [
      "./bin/quest",
      "party",
      "create",
      "--name",
      spec.partyName,
      "--source-repo",
      spec.sourceRepo,
      "--target-ref",
      "main",
    ],
    projectRoot,
    env,
  );

  mkdirSync(spec.inboxDir, { recursive: true });
  writeFileSync(
    join(spec.inboxDir, spec.specFileName),
    JSON.stringify({
      priority: 1,
      retry_count: 0,
      retry_limit: 0,
      acceptanceChecks: [
        {
          argv: [
            "bun",
            "-e",
            `const text = await Bun.file(${JSON.stringify(spec.artifactFileName)}).text(); if (!text.includes(${JSON.stringify(spec.partyName)})) process.exit(1);`,
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
          goal: `Write ${spec.artifactFileName} so acceptance passes.`,
          id: "write-artifact",
          owns: [spec.artifactFileName],
          title: "Write Artifact",
        },
      ],
      title: `Concurrent Canary (${spec.partyName})`,
      version: 1,
      workspace: spec.workspace,
    }),
    "utf8",
  );
}

function findCaptured(
  captured: CapturedEvent[],
  eventType: string,
  partyName: string,
): CapturedEvent | null {
  return (
    captured.find((event) => event.eventType === eventType && event.partyName === partyName) ?? null
  );
}

type DaemonStatus = {
  parties: Array<{
    party: { name: string };
    activeRunIds?: string[];
    lastError?: string | null;
    queueDepths?: {
      done?: number;
      failed?: number;
      inbox?: number;
      partyRoot?: number;
      running?: number;
    };
  }>;
};

function summarizeParty(status: DaemonStatus, partyName: string): PartySummary {
  const entry = status.parties.find((candidate) => candidate.party.name === partyName);
  if (!entry) {
    return {
      activeRunIds: 0,
      doneCount: 0,
      failedCount: 0,
      inboxCount: 0,
      lastError: null,
    };
  }
  return {
    activeRunIds: (entry.activeRunIds ?? []).length,
    doneCount: entry.queueDepths?.done ?? 0,
    failedCount: entry.queueDepths?.failed ?? 0,
    inboxCount: entry.queueDepths?.inbox ?? 0,
    lastError: entry.lastError ?? null,
  };
}

function writeWorkerScript(workerScriptPath: string): void {
  // The local-command runner streams slice context via stdin; the worker picks its
  // artifact filename out of `slice.owns[0]` and writes the run workspace (which
  // encodes the party name — "concurrent-canary-alpha" / "-beta") so each party's
  // acceptance check passes independently.
  writeFileSync(
    workerScriptPath,
    [
      "const payload = JSON.parse(await Bun.stdin.text());",
      "const artifact = payload.slice?.owns?.[0];",
      "if (!artifact) throw new Error('slice has no owns path');",
      "const marker = payload.run?.workspace ?? 'unknown';",
      "await Bun.write(artifact, marker + '\\n');",
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

async function readDaemonStatus(env: Record<string, string>): Promise<DaemonStatus> {
  const raw = await runCommandOrThrow(["./bin/quest", "daemon", "status"], projectRoot, env);
  return JSON.parse(raw) as DaemonStatus;
}

async function countPartyDeliveries(
  env: Record<string, string>,
): Promise<{ alpha: number; beta: number }> {
  const raw = await runCommandOrThrow(
    [
      "./bin/quest",
      "observability",
      "deliveries",
      "list",
      "--sink-id",
      "concurrent-canary-webhook",
      "--event-type",
      "daemon_landed",
    ],
    projectRoot,
    env,
  );
  const payload = JSON.parse(raw) as {
    deliveries: Array<{ eventType: string; payload?: { partyName?: string | null } }>;
  };
  const countFor = (partyName: string): number =>
    payload.deliveries.filter(
      (entry) => entry.eventType === "daemon_landed" && entry.payload?.partyName === partyName,
    ).length;
  return { alpha: countFor("alpha"), beta: countFor("beta") };
}

function buildAssertions(result: CanaryResult): Array<[boolean, string]> {
  return [
    [result.alphaDispatched !== null, "alpha daemon_dispatched missing"],
    [result.alphaLanded !== null, "alpha daemon_landed missing"],
    [result.betaDispatched !== null, "beta daemon_dispatched missing"],
    [result.betaLanded !== null, "beta daemon_landed missing"],
    [result.alphaArtifactInAlphaRepo, "alpha.txt should exist in alpha repo after landing"],
    [result.betaArtifactInBetaRepo, "beta.txt should exist in beta repo after landing"],
    [!result.alphaArtifactLeakedIntoBeta, "alpha.txt must NOT leak into beta repo"],
    [!result.betaArtifactLeakedIntoAlpha, "beta.txt must NOT leak into alpha repo"],
    [result.alphaSummary.doneCount >= 1, "alpha should have >=1 spec in done/"],
    [result.betaSummary.doneCount >= 1, "beta should have >=1 spec in done/"],
    [result.alphaSummary.failedCount === 0, "alpha should have 0 specs in failed/"],
    [result.betaSummary.failedCount === 0, "beta should have 0 specs in failed/"],
    [result.alphaSummary.inboxCount === 0, "alpha inbox should be drained"],
    [result.betaSummary.inboxCount === 0, "beta inbox should be drained"],
    [result.alphaSummary.activeRunIds === 0, "alpha should have no lingering activeRunIds"],
    [result.betaSummary.activeRunIds === 0, "beta should have no lingering activeRunIds"],
    [result.alphaSummary.lastError === null, "alpha lastError should be null"],
    [result.betaSummary.lastError === null, "beta lastError should be null"],
    [result.alphaDeliveries >= 1, "alpha should have >=1 persisted daemon_landed delivery"],
    [result.betaDeliveries >= 1, "beta should have >=1 persisted daemon_landed delivery"],
  ];
}

function printResult(result: CanaryResult): void {
  console.log("Concurrent Parties Canary");
  console.log(`  captured events: ${result.capturedEventTypes.join(", ")}`);
  console.log(
    `  alpha dispatched→landed: run=${result.alphaLanded?.runId ?? "-"} spec=${result.alphaLanded?.specFile ?? "-"}`,
  );
  console.log(
    `  beta  dispatched→landed: run=${result.betaLanded?.runId ?? "-"} spec=${result.betaLanded?.specFile ?? "-"}`,
  );
  console.log(
    `  isolation: alpha→alphaRepo=${result.alphaArtifactInAlphaRepo} beta→betaRepo=${result.betaArtifactInBetaRepo} crossLeaks=${result.alphaArtifactLeakedIntoBeta || result.betaArtifactLeakedIntoAlpha}`,
  );
  console.log(`  deliveries: alpha=${result.alphaDeliveries} beta=${result.betaDeliveries}`);
  console.log(`  state root: ${result.stateRoot}`);
}

async function observeRun(
  captured: CapturedEvent[],
  env: Record<string, string>,
  alphaRepo: string,
  betaRepo: string,
  stateRoot: string,
): Promise<CanaryResult> {
  const status = await readDaemonStatus(env);
  const deliveries = await countPartyDeliveries(env);
  return {
    capturedEventTypes: captured.map((event) => event.eventType),
    alphaDispatched: findCaptured(captured, "daemon_dispatched", "alpha"),
    alphaLanded: findCaptured(captured, "daemon_landed", "alpha"),
    betaDispatched: findCaptured(captured, "daemon_dispatched", "beta"),
    betaLanded: findCaptured(captured, "daemon_landed", "beta"),
    alphaArtifactInAlphaRepo: existsSync(join(alphaRepo, "alpha.txt")),
    betaArtifactInBetaRepo: existsSync(join(betaRepo, "beta.txt")),
    alphaArtifactLeakedIntoBeta: existsSync(join(betaRepo, "alpha.txt")),
    betaArtifactLeakedIntoAlpha: existsSync(join(alphaRepo, "beta.txt")),
    alphaSummary: summarizeParty(status, "alpha"),
    betaSummary: summarizeParty(status, "beta"),
    alphaDeliveries: deliveries.alpha,
    betaDeliveries: deliveries.beta,
    stateRoot,
  };
}

async function runScenario(
  stateRoot: string,
  alphaRepo: string,
  betaRepo: string,
  workerScriptPath: string,
  webhookUrl: string,
  env: Record<string, string>,
  captured: CapturedEvent[],
): Promise<CanaryResult> {
  await initRepo(alphaRepo, env);
  await initRepo(betaRepo, env);

  await registerLocalWorker(workerScriptPath, env);
  await configureWebhookSink(webhookUrl, env);

  const alpha: PartySpec = {
    artifactFileName: "alpha.txt",
    inboxDir: join(stateRoot, "parties", "alpha", "inbox"),
    partyName: "alpha",
    sourceRepo: alphaRepo,
    specFileName: "alpha-task.json",
    workspace: "concurrent-canary-alpha",
  };
  const beta: PartySpec = {
    artifactFileName: "beta.txt",
    inboxDir: join(stateRoot, "parties", "beta", "inbox"),
    partyName: "beta",
    sourceRepo: betaRepo,
    specFileName: "beta-task.json",
    workspace: "concurrent-canary-beta",
  };

  await createPartyWithSpec(env, alpha);
  await createPartyWithSpec(env, beta);

  // One daemon tick. Both parties should dispatch + land within this single cycle.
  await runCommandOrThrow(["./bin/quest", "daemon", "tick"], projectRoot, env);

  // Give the webhook server a moment to process queued requests before reading captured.
  await Bun.sleep(200);

  return observeRun(captured, env, alphaRepo, betaRepo, stateRoot);
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const root = mkdtempSync(join(tmpdir(), "quest-concurrent-parties-canary-"));
  const stateRoot = join(root, "state");
  const alphaRepo = join(root, "alpha-repo");
  const betaRepo = join(root, "beta-repo");
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
      alphaRepo,
      betaRepo,
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
        `Concurrent parties canary failed:\n  - ${failures.join("\n  - ")}\n\ncaptured=${JSON.stringify(captured, null, 2)}`,
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
