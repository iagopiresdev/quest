#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type CanaryResult = {
  finalRescueStatus: string;
  pendingEventSeen: boolean;
  rescuedEventSeen: boolean;
  root: string;
  runId: string;
  runStatus: string;
  stateRoot: string;
};

const projectRoot = resolve(import.meta.dir, "..", "..");

function runCommandOrThrow(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
  input?: string,
): string {
  const result = Bun.spawnSync({
    cmd,
    cwd,
    env,
    stdin: input ? new TextEncoder().encode(input) : "ignore",
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

function runCommandExpectFailure(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
): { exitCode: number | null; stderr: string; stdout: string } {
  const result = Bun.spawnSync({
    cmd,
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: new TextDecoder().decode(result.stderr),
    stdout: new TextDecoder().decode(result.stdout),
  };
}

function registerRescueWorker(workerScriptPath: string, env: Record<string, string>): void {
  runCommandOrThrow(
    ["./bin/quest", "workers", "upsert", "--stdin"],
    projectRoot,
    env,
    JSON.stringify({
      backend: {
        adapter: "local-command",
        command: ["bun", workerScriptPath],
        profile: "rescue-canary",
        runner: "custom",
        toolPolicy: { allow: [], deny: [] },
      },
      calibration: { history: [] },
      class: "engineer",
      enabled: true,
      id: "rescue-canary",
      name: "Rescue Canary",
      persona: {
        approach: "ship minimal change",
        prompt: "Write the file.",
        voice: "direct",
      },
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
      title: "Rescue Canary",
      trust: { calibratedAt: new Date().toISOString(), rating: 0.8 },
    }),
  );
}

function buildRescueSpec(): unknown {
  return {
    acceptanceChecks: [],
    execution: { preInstall: false, shareSourceDependencies: true, timeoutMinutes: 20 },
    featureDoc: { enabled: false },
    hotspots: [],
    maxParallel: 1,
    slices: [
      {
        acceptanceChecks: [{ argv: ["bash", "-c", "test -f does-not-exist.ts"], env: {} }],
        contextHints: [],
        dependsOn: [],
        discipline: "coding",
        goal: "Write a file that won't satisfy the impossible acceptance check.",
        id: "only",
        owns: ["written.txt"],
        title: "Only",
      },
    ],
    title: "Rescue Flow Canary",
    version: 1,
    workspace: "rescue-canary",
  };
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "quest-rescue-canary-"));
  const stateRoot = join(root, "state");
  const workerScriptPath = join(root, "rescue-worker.ts");
  mkdirSync(stateRoot, { recursive: true });

  const env = {
    ...Bun.env,
    QUEST_STATE_ROOT: stateRoot,
  } as Record<string, string>;

  writeFileSync(workerScriptPath, "await Bun.write('written.txt', 'ok\\n');\n", "utf8");

  try {
    registerRescueWorker(workerScriptPath, env);
    const spec = buildRescueSpec();
    const created = JSON.parse(
      runCommandOrThrow(["./bin/quest", "run", "--stdin"], projectRoot, env, JSON.stringify(spec)),
    ) as { run: { id: string } };
    const runId = created.run.id;

    // Execute must fail because the acceptance check can't pass.
    const executeAttempt = runCommandExpectFailure(
      ["./bin/quest", "runs", "execute", "--id", runId],
      projectRoot,
      env,
    );
    if (executeAttempt.exitCode === 0) {
      throw new Error("Expected execute to fail on impossible acceptance check");
    }

    // Confirm run is failed.
    const afterExecute = JSON.parse(
      runCommandOrThrow(["./bin/quest", "runs", "status", "--id", runId], projectRoot, env),
    ) as { run: { status: string } };
    if (afterExecute.run.status !== "failed") {
      throw new Error(`Expected run status=failed, got ${afterExecute.run.status}`);
    }

    // Rescue: pending.
    const pending = JSON.parse(
      runCommandOrThrow(
        [
          "./bin/quest",
          "runs",
          "rescue",
          "--id",
          runId,
          "--status",
          "pending",
          "--note",
          "needs manual investigation",
        ],
        projectRoot,
        env,
      ),
    ) as { run: { events: Array<{ type: string }>; integrationRescueStatus: string } };
    const pendingEventSeen = pending.run.events.some(
      (event) => event.type === "run_rescue_status_updated",
    );
    if (!pendingEventSeen || pending.run.integrationRescueStatus !== "pending") {
      throw new Error(
        `Expected pending rescue, got status=${pending.run.integrationRescueStatus} event=${pendingEventSeen}`,
      );
    }

    // Rescue: rescued.
    const rescued = JSON.parse(
      runCommandOrThrow(
        [
          "./bin/quest",
          "runs",
          "rescue",
          "--id",
          runId,
          "--status",
          "rescued",
          "--note",
          "handled manually",
        ],
        projectRoot,
        env,
      ),
    ) as { run: { events: Array<{ type: string }>; integrationRescueStatus: string } };
    const rescueEvents = rescued.run.events.filter(
      (event) => event.type === "run_rescue_status_updated",
    );
    const rescuedEventSeen = rescueEvents.length >= 2;
    if (!rescuedEventSeen || rescued.run.integrationRescueStatus !== "rescued") {
      throw new Error(
        `Expected rescued status after second call, got status=${rescued.run.integrationRescueStatus} events=${rescueEvents.length}`,
      );
    }

    const result: CanaryResult = {
      finalRescueStatus: rescued.run.integrationRescueStatus,
      pendingEventSeen,
      rescuedEventSeen,
      root,
      runId,
      runStatus: afterExecute.run.status,
      stateRoot,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

await main();
