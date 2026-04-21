#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type CanaryResult = {
  finalRevision: string;
  initialRevision: string;
  landEventSeen: boolean;
  landRefusedWithCode: string;
  refreshEventSeen: boolean;
  root: string;
  runId: string;
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

function gitHead(repo: string, env: Record<string, string>): string {
  return runCommandOrThrow(["git", "rev-parse", "HEAD"], repo, env).trim();
}

function setupCommittedRepo(repoRoot: string, env: Record<string, string>): string {
  runCommandOrThrow(["git", "init"], repoRoot, env);
  runCommandOrThrow(["git", "config", "user.name", "Drift Canary"], repoRoot, env);
  runCommandOrThrow(["git", "config", "user.email", "drift-canary@example.com"], repoRoot, env);
  writeFileSync(join(repoRoot, "seed.txt"), "seed\n", "utf8");
  runCommandOrThrow(["git", "add", "seed.txt"], repoRoot, env);
  runCommandOrThrow(["git", "commit", "-m", "Initial commit"], repoRoot, env);
  return gitHead(repoRoot, env);
}

function registerDriftWorker(workerScriptPath: string, env: Record<string, string>): void {
  runCommandOrThrow(
    ["./bin/quest", "workers", "upsert", "--stdin"],
    projectRoot,
    env,
    JSON.stringify({
      backend: {
        adapter: "local-command",
        command: ["bun", workerScriptPath],
        profile: "drift-canary",
        runner: "custom",
        toolPolicy: { allow: [], deny: [] },
      },
      calibration: { history: [] },
      class: "engineer",
      enabled: true,
      id: "drift-canary",
      name: "Drift Canary",
      persona: {
        approach: "touch one file",
        prompt: "Write the single owned path.",
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
      title: "Drift Canary",
      trust: { calibratedAt: new Date().toISOString(), rating: 0.8 },
    }),
  );
}

function buildSpec(): unknown {
  return {
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
        goal: "Write tracked.txt so land has something to deliver.",
        id: "write",
        owns: ["tracked.txt"],
        title: "Write tracked file",
      },
    ],
    title: "Drift Recovery Canary",
    version: 1,
    workspace: "drift-canary",
  };
}

function driftMain(repoRoot: string, env: Record<string, string>): string {
  writeFileSync(join(repoRoot, "unrelated.txt"), "drifted\n", "utf8");
  runCommandOrThrow(["git", "add", "unrelated.txt"], repoRoot, env);
  runCommandOrThrow(["git", "commit", "-m", "Simulated drift"], repoRoot, env);
  return gitHead(repoRoot, env);
}

function assertLandRefusedOnDrift(
  runId: string,
  repoRoot: string,
  env: Record<string, string>,
): string {
  const attempt = runCommandExpectFailure(
    [
      "./bin/quest",
      "runs",
      "land",
      "--id",
      runId,
      "--source-repo",
      repoRoot,
      "--target-ref",
      "HEAD",
    ],
    projectRoot,
    env,
  );
  if (attempt.exitCode === 0) {
    throw new Error(
      `Expected land to refuse after drift but it succeeded. stdout:\n${attempt.stdout}`,
    );
  }
  const raw = attempt.stdout.trim() || attempt.stderr.trim();
  const payload = JSON.parse(raw) as { error?: string };
  if (payload.error !== "quest_run_not_landable") {
    throw new Error(`Expected error quest_run_not_landable, got: ${JSON.stringify(payload)}`);
  }
  return payload.error;
}

function runRefreshBase(runId: string, repoRoot: string, env: Record<string, string>): boolean {
  const refreshed = JSON.parse(
    runCommandOrThrow(
      [
        "./bin/quest",
        "runs",
        "refresh-base",
        "--id",
        runId,
        "--source-repo",
        repoRoot,
        "--target-ref",
        "HEAD",
      ],
      projectRoot,
      env,
    ),
  ) as { run: { events: Array<{ type: string }> } };
  return refreshed.run.events.some((event) => event.type === "run_base_refreshed");
}

function runLand(runId: string, repoRoot: string, env: Record<string, string>): boolean {
  const landed = JSON.parse(
    runCommandOrThrow(
      [
        "./bin/quest",
        "runs",
        "land",
        "--id",
        runId,
        "--source-repo",
        repoRoot,
        "--target-ref",
        "HEAD",
      ],
      projectRoot,
      env,
    ),
  ) as { run: { events: Array<{ type: string }> } };
  return landed.run.events.some((event) => event.type === "run_landed");
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "quest-drift-canary-"));
  const stateRoot = join(root, "state");
  const repoRoot = join(root, "source-repo");
  const workerScriptPath = join(root, "drift-worker.ts");
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(repoRoot, { recursive: true });

  const env = {
    ...Bun.env,
    QUEST_STATE_ROOT: stateRoot,
  } as Record<string, string>;

  writeFileSync(
    workerScriptPath,
    "await Bun.write('tracked.txt', 'drift-canary-change\\n');\n",
    "utf8",
  );

  try {
    const initialRevision = setupCommittedRepo(repoRoot, env);
    registerDriftWorker(workerScriptPath, env);
    const created = JSON.parse(
      runCommandOrThrow(
        ["./bin/quest", "run", "--stdin", "--source-repo", repoRoot],
        projectRoot,
        env,
        JSON.stringify(buildSpec()),
      ),
    ) as { run: { id: string } };
    const runId = created.run.id;

    runCommandOrThrow(
      [
        "./bin/quest",
        "runs",
        "execute",
        "--id",
        runId,
        "--source-repo",
        repoRoot,
        "--auto-integrate",
        "--target-ref",
        "HEAD",
      ],
      projectRoot,
      env,
    );

    const driftedRevision = driftMain(repoRoot, env);
    if (driftedRevision === initialRevision) {
      throw new Error("drift setup failed: HEAD did not advance");
    }

    const landRefusedWithCode = assertLandRefusedOnDrift(runId, repoRoot, env);
    const refreshEventSeen = runRefreshBase(runId, repoRoot, env);
    if (!refreshEventSeen) {
      throw new Error("Expected run_base_refreshed event after refresh-base");
    }
    const landEventSeen = runLand(runId, repoRoot, env);
    if (!landEventSeen) {
      throw new Error("Expected run_landed event after successful land");
    }

    const finalRevision = gitHead(repoRoot, env);
    if (finalRevision === driftedRevision) {
      throw new Error("Expected HEAD to advance past the drifted revision after land");
    }

    const tracked = readFileSync(join(repoRoot, "tracked.txt"), "utf8");
    if (tracked !== "drift-canary-change\n") {
      throw new Error(`tracked.txt content mismatch: ${JSON.stringify(tracked)}`);
    }

    const result: CanaryResult = {
      finalRevision,
      initialRevision,
      landEventSeen,
      landRefusedWithCode,
      refreshEventSeen,
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
