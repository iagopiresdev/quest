#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type CanaryResult = {
  cancelExitCode: number;
  executeExitCode: number | null;
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

async function waitForActiveProcess(
  env: Record<string, string>,
  runId: string,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = JSON.parse(
      runCommandOrThrow(["./bin/quest", "runs", "status", "--id", runId], projectRoot, env),
    ) as { run: { activeProcesses?: unknown[] } };
    if ((status.run.activeProcesses ?? []).length > 0) {
      return;
    }
    await Bun.sleep(100);
  }

  throw new Error(`Timed out waiting for active process on ${runId}`);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "quest-cancel-canary-"));
  const stateRoot = join(root, "state");
  const workerScriptPath = join(root, "sleep-worker.ts");
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(workerScriptPath, "await Bun.sleep(30_000);\n", "utf8");

  const env = {
    ...Bun.env,
    QUEST_RUNNER_STATE_ROOT: stateRoot,
  } as Record<string, string>;

  try {
    runCommandOrThrow(
      ["./bin/quest", "workers", "upsert", "--stdin"],
      projectRoot,
      env,
      JSON.stringify(
        {
          backend: {
            adapter: "local-command",
            command: ["bun", workerScriptPath],
            profile: "cancel-canary",
            runner: "custom",
            toolPolicy: { allow: [], deny: [] },
          },
          calibration: { history: [] },
          class: "engineer",
          enabled: true,
          id: "cancel-canary",
          name: "Cancel Canary",
          persona: {
            approach: "sleep until cancelled",
            prompt: "Keep the command alive.",
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
          title: "Cancel Canary",
          trust: { calibratedAt: new Date().toISOString(), rating: 0.8 },
        },
        null,
        2,
      ),
    );

    const spec = {
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
          goal: "Keep the worker alive long enough to test cancel.",
          id: "sleep",
          owns: ["sleep.txt"],
          title: "Sleep",
        },
      ],
      title: "Cancel Canary",
      version: 1,
      workspace: "cancel-canary",
    };
    const created = JSON.parse(
      runCommandOrThrow(["./bin/quest", "run", "--stdin"], projectRoot, env, JSON.stringify(spec)),
    ) as { run: { id: string } };
    const runId = created.run.id;

    const execute = Bun.spawn({
      cmd: ["./bin/quest", "runs", "execute", "--id", runId],
      cwd: projectRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    await waitForActiveProcess(env, runId, 10_000);

    const cancelOutput = runCommandOrThrow(
      ["./bin/quest", "runs", "cancel", "--id", runId],
      projectRoot,
      env,
    );
    const cancelled = JSON.parse(cancelOutput) as { run: { status: string } };
    const executeExitCode = await execute.exited;
    const finalRun = JSON.parse(
      runCommandOrThrow(["./bin/quest", "runs", "status", "--id", runId], projectRoot, env),
    ) as { run: { status: string } };

    const result: CanaryResult = {
      cancelExitCode: 0,
      executeExitCode,
      root,
      runId,
      runStatus: finalRun.run.status,
      stateRoot,
    };
    if (cancelled.run.status !== "aborted" || finalRun.run.status !== "aborted") {
      throw new Error(JSON.stringify(result, null, 2));
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

await main();
