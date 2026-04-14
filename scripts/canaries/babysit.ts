#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type CanaryResult = {
  actionTaken: string | null;
  babysatCount: number;
  finalStatus: string;
  reason: string | null;
  root: string;
  runId: string;
  stateRoot: string;
};

const projectRoot = resolve(import.meta.dir, "..", "..");

function runCommandOrThrow(cmd: string[], cwd: string, env: Record<string, string>): string {
  const result = Bun.spawnSync({
    cmd,
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${cmd.join(" ")}):\nstdout:\n${new TextDecoder().decode(result.stdout)}\nstderr:\n${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}

function registerBabysitWorker(workerScriptPath: string, env: Record<string, string>): void {
  const result = Bun.spawnSync({
    cmd: ["./bin/quest", "workers", "upsert", "--stdin"],
    cwd: projectRoot,
    env,
    stdin: new TextEncoder().encode(
      JSON.stringify({
        backend: {
          adapter: "local-command",
          command: ["bun", workerScriptPath],
          profile: "babysit-canary",
          runner: "custom",
          toolPolicy: { allow: [], deny: [] },
        },
        calibration: { history: [] },
        class: "engineer",
        enabled: true,
        id: "babysit-canary",
        name: "Babysit Canary",
        persona: { approach: "exit fast", prompt: "Noop.", voice: "direct" },
        progression: { level: 1, xp: 0 },
        role: "hybrid",
        resources: { cpuCost: 1, gpuCost: 0, maxParallel: 1, memoryCost: 1 },
        stats: {
          coding: 60,
          contextEndurance: 60,
          docs: 20,
          mergeSafety: 60,
          research: 20,
          speed: 20,
          testing: 60,
        },
        tags: ["canary"],
        title: "Babysit Canary",
        trust: { calibratedAt: new Date().toISOString(), rating: 0.8 },
      }),
    ),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`worker upsert failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}

function createBabysitRun(env: Record<string, string>): string {
  const result = Bun.spawnSync({
    cmd: ["./bin/quest", "run", "--stdin"],
    cwd: projectRoot,
    env,
    stdin: new TextEncoder().encode(
      JSON.stringify({
        acceptanceChecks: [],
        execution: { preInstall: false, shareSourceDependencies: true, timeoutMinutes: 20 },
        featureDoc: { enabled: false },
        hotspots: [],
        maxParallel: 1,
        slices: [
          {
            acceptanceChecks: [],
            contextHints: [],
            dependsOn: [],
            discipline: "coding",
            goal: "Dummy slice for babysit canary.",
            id: "sleeper",
            owns: ["noop.txt"],
            title: "Sleeper",
          },
        ],
        title: "Babysit Canary",
        version: 1,
        workspace: "babysit-canary",
      }),
    ),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`run creation failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout)) as { run: { id: string } };
  return parsed.run.id;
}

function tamperRunToStale(runPath: string, workerScriptPath: string, deadPid: number): void {
  const doc = JSON.parse(readFileSync(runPath, "utf8")) as {
    activeProcesses?: Array<{
      command: string[];
      kind: string;
      pid: number;
      sliceId?: string;
      startedAt: string;
      workerId?: string;
    }>;
    executionHeartbeatAt?: string;
    executionHostPid?: number;
    executionStage?: string;
    status?: string;
    updatedAt?: string;
  };
  doc.status = "running";
  doc.updatedAt = "2020-01-01T00:00:00.000Z";
  doc.executionHostPid = deadPid;
  doc.executionHeartbeatAt = "2020-01-01T00:00:00.000Z";
  doc.executionStage = "execute";
  doc.activeProcesses = [
    {
      command: ["bun", workerScriptPath],
      kind: "runner",
      pid: deadPid,
      sliceId: "sleeper",
      startedAt: "2020-01-01T00:00:00.000Z",
      workerId: "babysit-canary",
    },
  ];
  writeFileSync(runPath, JSON.stringify(doc, null, 2), "utf8");
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "quest-babysit-canary-"));
  const stateRoot = join(root, "state");
  const runsRoot = join(stateRoot, "runs");
  const workerScriptPath = join(root, "babysit-worker.ts");
  mkdirSync(runsRoot, { recursive: true });

  const env = {
    ...Bun.env,
    QUEST_RUNNER_STATE_ROOT: stateRoot,
  } as Record<string, string>;

  writeFileSync(workerScriptPath, "await Bun.sleep(10);\n", "utf8");

  try {
    registerBabysitWorker(workerScriptPath, env);
    const runId = createBabysitRun(env);
    const runPath = join(runsRoot, `${runId}.json`);
    const deadPid = 999999; // Unlikely to be alive on the canary host.
    tamperRunToStale(runPath, workerScriptPath, deadPid);

    // Babysit should see the stale host and mark the run orphaned.
    const babysat = JSON.parse(
      runCommandOrThrow(
        ["./bin/quest", "runs", "babysit", "--id", runId, "--stale-minutes", "1"],
        projectRoot,
        env,
      ),
    ) as {
      results: Array<{
        action: string;
        reason: string;
        run: { status: string };
      }>;
    };
    if (babysat.results.length !== 1) {
      throw new Error(`Expected exactly one babysit result, got ${babysat.results.length}`);
    }
    const entry = babysat.results[0];
    if (!entry || entry.action !== "marked_orphaned") {
      throw new Error(`Expected action=marked_orphaned, got ${entry?.action}`);
    }
    if (entry.run.status !== "orphaned") {
      throw new Error(`Expected run status=orphaned, got ${entry.run.status}`);
    }

    // Confirm persistence via a status read.
    const afterStatus = JSON.parse(
      runCommandOrThrow(["./bin/quest", "runs", "status", "--id", runId], projectRoot, env),
    ) as { run: { status: string; activeProcesses: unknown[] } };
    if (afterStatus.run.status !== "orphaned") {
      throw new Error(`Expected persisted status=orphaned, got ${afterStatus.run.status}`);
    }
    if ((afterStatus.run.activeProcesses ?? []).length !== 0) {
      throw new Error("Expected activeProcesses to be cleared after orphaning");
    }

    const result: CanaryResult = {
      actionTaken: entry.action,
      babysatCount: babysat.results.length,
      finalStatus: afterStatus.run.status,
      reason: entry.reason,
      root,
      runId,
      stateRoot,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

await main();
