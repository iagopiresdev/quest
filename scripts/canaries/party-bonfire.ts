#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type CanaryResult = {
  dispatchBlockedWithCode: string;
  dispatchBlockedReason: string | null;
  dispatchSucceededAfterResume: boolean;
  freshStatus: string;
  idempotentResume: boolean;
  reasonUpdatedOnRelight: boolean;
  restedStatus: string;
  resumedEventSeen: boolean;
  resumedStatus: string;
  root: string;
  runPlannedStayedPlanned: boolean;
  statusReadableWhileResting: boolean;
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

type PartyStatePayload = {
  partyState: {
    events: Array<{ at: string; reason?: string; type: string }>;
    reason: string | null;
    status: string;
    updatedAt: string;
  };
};

function readPartyStatus(env: Record<string, string>): PartyStatePayload["partyState"] {
  const raw = runCommandOrThrow(["./bin/quest", "party", "status"], projectRoot, env);
  const parsed = JSON.parse(raw) as PartyStatePayload;
  return parsed.partyState;
}

function registerBonfireWorker(workerScriptPath: string, env: Record<string, string>): void {
  runCommandOrThrow(
    ["./bin/quest", "workers", "upsert", "--stdin"],
    projectRoot,
    env,
    JSON.stringify({
      backend: {
        adapter: "local-command",
        command: ["bun", workerScriptPath],
        profile: "bonfire-canary",
        runner: "custom",
        toolPolicy: { allow: [], deny: [] },
      },
      calibration: { history: [] },
      class: "engineer",
      enabled: true,
      id: "bonfire-canary",
      name: "Bonfire Canary",
      persona: { approach: "ship fast", prompt: "Write the file.", voice: "direct" },
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
      title: "Bonfire Canary",
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
        goal: "Write hello.txt so we have something to verify.",
        id: "one",
        owns: ["hello.txt"],
        title: "One",
      },
    ],
    title: "Bonfire Canary",
    version: 1,
    workspace: "bonfire-canary",
  };
}

function assertDispatchBlocked(
  runId: string,
  env: Record<string, string>,
): { code: string; reason: string | null } {
  const attempt = runCommandExpectFailure(
    ["./bin/quest", "runs", "execute", "--id", runId],
    projectRoot,
    env,
  );
  if (attempt.exitCode === 0) {
    throw new Error(
      `Expected execute to be blocked by bonfire but it succeeded:\n${attempt.stdout}`,
    );
  }
  const raw = attempt.stdout.trim() || attempt.stderr.trim();
  const payload = JSON.parse(raw) as {
    error?: string;
    details?: { reason?: string };
    message?: string;
  };
  if (payload.error !== "quest_party_resting") {
    throw new Error(`Expected error quest_party_resting, got: ${JSON.stringify(payload)}`);
  }
  return { code: payload.error, reason: payload.details?.reason ?? null };
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "quest-bonfire-canary-"));
  const stateRoot = join(root, "state");
  const repoRoot = join(root, "source-repo");
  const workerScriptPath = join(root, "bonfire-worker.ts");
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(repoRoot, { recursive: true });

  const env = {
    ...Bun.env,
    QUEST_STATE_ROOT: stateRoot,
  } as Record<string, string>;

  writeFileSync(workerScriptPath, "await Bun.write('hello.txt', 'bonfire\\n');\n", "utf8");

  try {
    // Set up a committed source repo so execute has somewhere real to run.
    runCommandOrThrow(["git", "init"], repoRoot, env);
    runCommandOrThrow(["git", "config", "user.name", "Bonfire Canary"], repoRoot, env);
    runCommandOrThrow(["git", "config", "user.email", "bonfire-canary@example.com"], repoRoot, env);
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n", "utf8");
    runCommandOrThrow(["git", "add", "seed.txt"], repoRoot, env);
    runCommandOrThrow(["git", "commit", "-m", "Initial commit"], repoRoot, env);

    registerBonfireWorker(workerScriptPath, env);

    // Step 1: fresh state must report active with no reason.
    const fresh = readPartyStatus(env);
    const freshStatus = fresh.status;

    // Step 2: light the bonfire with a reason.
    runCommandOrThrow(
      ["./bin/quest", "party", "bonfire", "--reason", "canary rest"],
      projectRoot,
      env,
    );
    const rested = readPartyStatus(env);
    if (rested.status !== "resting" || rested.reason !== "canary rest") {
      throw new Error(`Expected resting with reason=canary rest, got ${JSON.stringify(rested)}`);
    }

    // Step 3: create a run. This should succeed even while resting.
    const created = JSON.parse(
      runCommandOrThrow(
        ["./bin/quest", "run", "--stdin", "--source-repo", repoRoot],
        projectRoot,
        env,
        JSON.stringify(buildSpec()),
      ),
    ) as { run: { id: string; status: string } };
    const runId = created.run.id;
    if (created.run.status !== "planned") {
      throw new Error(`Expected new run to be planned, got ${created.run.status}`);
    }

    // Step 4: `runs status` should still read while resting.
    const statusDuringRest = runCommandOrThrow(
      ["./bin/quest", "runs", "status", "--id", runId],
      projectRoot,
      env,
    );
    const statusReadableWhileResting = statusDuringRest.includes(runId);

    // Step 5: execute must be blocked with quest_party_resting + reason echoed.
    const blocked = assertDispatchBlocked(runId, env);

    // Step 6: run must still be planned (not advanced by the blocked attempt).
    const afterBlock = JSON.parse(
      runCommandOrThrow(["./bin/quest", "runs", "status", "--id", runId], projectRoot, env),
    ) as { run: { status: string } };
    const runPlannedStayedPlanned = afterBlock.run.status === "planned";

    // Step 7: re-light with a new reason. Current behavior updates reason and emits event.
    runCommandOrThrow(
      ["./bin/quest", "party", "bonfire", "--reason", "relit with new reason"],
      projectRoot,
      env,
    );
    const relit = readPartyStatus(env);
    const reasonUpdatedOnRelight = relit.reason === "relit with new reason";

    // Step 8: resume lifts the bonfire.
    runCommandOrThrow(["./bin/quest", "party", "resume"], projectRoot, env);
    const resumed = readPartyStatus(env);
    const resumedStatus = resumed.status;
    const resumedEventSeen = resumed.events.some((event) => event.type === "party_resumed");

    // Step 9: second resume must be idempotent — event count should not grow.
    const eventCountBeforeDoubleResume = resumed.events.length;
    runCommandOrThrow(["./bin/quest", "party", "resume"], projectRoot, env);
    const afterDoubleResume = readPartyStatus(env);
    const idempotentResume = afterDoubleResume.events.length === eventCountBeforeDoubleResume;

    // Step 10: execute should now succeed end-to-end.
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
      ],
      projectRoot,
      env,
    );
    const afterExecute = JSON.parse(
      runCommandOrThrow(["./bin/quest", "runs", "status", "--id", runId], projectRoot, env),
    ) as { run: { status: string } };
    const dispatchSucceededAfterResume = afterExecute.run.status === "completed";

    const result: CanaryResult = {
      dispatchBlockedReason: blocked.reason,
      dispatchBlockedWithCode: blocked.code,
      dispatchSucceededAfterResume,
      freshStatus,
      idempotentResume,
      reasonUpdatedOnRelight,
      restedStatus: rested.status,
      resumedEventSeen,
      resumedStatus,
      root,
      runPlannedStayedPlanned,
      statusReadableWhileResting,
      stateRoot,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

await main();
