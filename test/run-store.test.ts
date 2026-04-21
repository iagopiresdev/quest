import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QuestDomainError } from "../src/core/errors";
import { QuestRunStore } from "../src/core/runs/store";
import { createSlice, createSpec, createWorkerForRunner } from "./helpers";

test("run store creates a planned run and lists it", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const store = new QuestRunStore(root, root);

  try {
    const run = await store.createRun(createSpec({ maxParallel: 2 }), [
      createWorkerForRunner("ember"),
    ]);
    const canonicalRoot = realpathSync(root);
    expect(run.status).toBe("planned");
    expect(run.workspaceRoot).toBe(join(canonicalRoot, run.id));
    expect(run.slices[0]?.workspacePath).toBe(join(canonicalRoot, run.id, "slices", "parser"));
    expect(run.events.length).toBe(1);
    expect(run.events[0]?.type).toBe("run_created");

    const loaded = await store.getRun(run.id);
    expect(loaded.id).toBe(run.id);

    const runs = await store.listRuns();
    expect(runs.length).toBe(1);
    expect(runs[0]?.id).toBe(run.id);
    expect(runs[0]?.waveCount).toBe(1);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run store marks blocked runs when planning leaves slices unassigned", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const store = new QuestRunStore(root, root);

  try {
    const run = await store.createRun(
      createSpec({
        maxParallel: 2,
        slices: [createSlice({ preferredRunner: "openclaw" })],
      }),
      [createWorkerForRunner("ember", "codex")],
    );
    expect(run.status).toBe("blocked");
    expect(run.plan.unassigned.length).toBe(1);
    expect(run.events.at(-1)?.type).toBe("run_blocked");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run store reports missing and invalid run documents as typed errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const store = new QuestRunStore(root, root);

  try {
    try {
      await store.getRun("quest-00000000-deadbeef");
      throw new Error("Expected quest_run_not_found");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_run_not_found");
    }

    const invalidRunPath = join(root, "quest-00000000-deadbeef.json");
    writeFileSync(invalidRunPath, JSON.stringify({ version: 1, bad: true }), "utf8");

    try {
      await store.getRun("quest-00000000-deadbeef");
      throw new Error("Expected invalid_quest_run");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("invalid_quest_run");
    }

    writeFileSync(invalidRunPath, "{", "utf8");

    try {
      await store.getRun("quest-00000000-deadbeef");
      throw new Error("Expected invalid_quest_run");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("invalid_quest_run");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run store skips invalid legacy runs when listing summaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const store = new QuestRunStore(root, root);

  try {
    const run = await store.createRun(createSpec({ maxParallel: 2 }), [
      createWorkerForRunner("ember"),
    ]);
    writeFileSync(join(root, "quest-00000000-deadbeef.json"), "{\n", "utf8");

    const runs = await store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(run.id);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run store reports warnings for legacy runs while listing summaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const store = new QuestRunStore(root, root);

  try {
    const run = await store.createRun(createSpec({ maxParallel: 2 }), [
      createWorkerForRunner("ember"),
    ]);
    writeFileSync(
      join(root, "quest-00000000-deadbeef.json"),
      JSON.stringify({ id: "quest-00000000-deadbeef", version: 0 }),
      "utf8",
    );

    const listed = await store.listRunsWithWarnings();
    expect(listed.runs).toHaveLength(1);
    expect(listed.runs[0]?.id).toBe(run.id);
    expect(listed.warnings).toEqual([
      expect.objectContaining({
        reason: "legacy_run_document",
        runId: "quest-00000000-deadbeef",
      }),
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run store still surfaces drifted v1-shaped runs as invalid", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const store = new QuestRunStore(root, root);

  try {
    await store.createRun(createSpec({ maxParallel: 2 }), [createWorkerForRunner("ember")]);
    writeFileSync(
      join(root, "quest-00000000-drifted1.json"),
      JSON.stringify({
        id: "quest-00000000-drifted1",
        version: 1,
        plan: { warnings: [], waves: [] },
        slices: [],
        spec: { version: 1 },
      }),
      "utf8",
    );

    try {
      await store.listRunsWithWarnings();
      throw new Error("Expected invalid_quest_run");
    } catch (error: unknown) {
      expect((error as QuestDomainError).code).toBe("invalid_quest_run");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run store can validate and quarantine drifted v1-shaped runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const store = new QuestRunStore(root, root);

  try {
    await store.createRun(createSpec({ maxParallel: 2 }), [createWorkerForRunner("ember")]);
    const runId = "quest-00000000-drifted2";
    writeFileSync(
      join(root, `${runId}.json`),
      JSON.stringify({
        id: runId,
        version: 1,
        plan: { warnings: [], waves: [] },
        slices: [],
        spec: { version: 1 },
      }),
      "utf8",
    );

    const validation = await store.validateRunDocument(runId);
    expect(validation.ok).toBe(false);
    expect(validation.reason).toBe("invalid_schema");
    expect(validation.issues).toBeDefined();

    const listed = await store.listRunsWithWarnings({ skipInvalidSchema: true });
    expect(listed.warnings).toEqual([
      expect.objectContaining({
        reason: "invalid_schema",
        runId,
      }),
    ]);

    const quarantine = await store.quarantineRunDocument(runId);
    expect(quarantine.originalPath).toContain(`${runId}.json`);
    expect(quarantine.quarantinedPath).toContain(".quarantine");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run store still surfaces tampered workspace paths when listing summaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const store = new QuestRunStore(root, root);

  try {
    const run = await store.createRun(createSpec({ maxParallel: 2 }), [
      createWorkerForRunner("ember"),
    ]);
    const runPath = join(root, `${run.id}.json`);
    const tampered = JSON.parse(readFileSync(runPath, "utf8")) as {
      integrationWorkspacePath?: string;
      workspaceRoot?: string;
    };
    tampered.workspaceRoot = "/tmp/not-quest-runner";
    writeFileSync(runPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

    await expect(store.listRuns()).rejects.toBeInstanceOf(QuestDomainError);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run store returns slice logs and supports aborting pending runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const store = new QuestRunStore(root, root);

  try {
    const run = await store.createRun(createSpec({ maxParallel: 2 }), [
      createWorkerForRunner("ember"),
    ]);
    const canonicalRoot = realpathSync(root);

    const initialLogs = await store.getRunLogs(run.id);
    expect(initialLogs.slices).toEqual([
      {
        lastChecks: undefined,
        sliceId: "parser",
        status: "pending",
        title: "Parser",
        wave: 1,
        workspacePath: join(canonicalRoot, run.id, "slices", "parser"),
        lastError: undefined,
        lastOutput: undefined,
      },
    ]);
    expect(initialLogs.workspaceRoot).toBe(join(canonicalRoot, run.id));

    const aborted = await store.abortRun(run.id);
    expect(aborted.status).toBe("aborted");
    expect(aborted.slices[0]?.status).toBe("aborted");
    expect(aborted.events.some((event) => event.type === "run_aborted")).toBe(true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run store can cancel a running run and clear execution tracking", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const store = new QuestRunStore(root, root);

  try {
    const run = await store.createRun(createSpec({ maxParallel: 2 }), [
      createWorkerForRunner("ember"),
    ]);
    run.status = "running";
    run.executionHostPid = 999_999;
    run.executionHeartbeatAt = new Date(Date.now() - 60_000).toISOString();
    run.executionStage = "execute";
    run.activeProcesses = [
      {
        command: ["bun", "worker.ts"],
        kind: "runner",
        phase: "build",
        pid: 999_998,
        sliceId: "parser",
        startedAt: new Date().toISOString(),
        workerId: "ember",
      },
    ];
    await store.saveRun(run);

    const cancelled = await store.cancelRun(run.id);
    expect(cancelled.status).toBe("aborted");
    expect(cancelled.activeProcesses).toHaveLength(0);
    expect(cancelled.executionHostPid).toBeUndefined();
    expect(cancelled.events.some((event) => event.type === "run_cancel_requested")).toBe(true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run store can mark stale dead-host runs orphaned", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const store = new QuestRunStore(root, root);

  try {
    const run = await store.createRun(createSpec({ maxParallel: 2 }), [
      createWorkerForRunner("ember"),
    ]);
    run.status = "running";
    run.executionHostPid = 999_997;
    run.executionHeartbeatAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    run.executionStage = "execute";
    await store.saveRun(run);

    const [result] = await store.babysitRuns({ staleMinutes: 15 });
    expect(result?.action).toBe("marked_orphaned");
    expect(result?.run.status).toBe("orphaned");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run store records explicit rescue status changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const store = new QuestRunStore(root, root);

  try {
    const run = await store.createRun(createSpec({ maxParallel: 2 }), [
      createWorkerForRunner("ember"),
    ]);
    const updated = await store.updateIntegrationRescueStatus(run.id, "rescued", "manual merge");
    expect(updated.integrationRescueNote).toBe("manual merge");
    expect(updated.integrationRescueStatus).toBe("rescued");
    expect(updated.events.at(-1)).toMatchObject({
      details: expect.objectContaining({ note: "manual merge", status: "rescued" }),
      type: "run_rescue_status_updated",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run store can reassign a blocked slice into a new executable wave", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const store = new QuestRunStore(root, root);

  try {
    const run = await store.createRun(createSpec({ maxParallel: 1 }), []);
    expect(run.status).toBe("blocked");
    expect(run.plan.unassigned).toHaveLength(1);

    const steered = await store.reassignSlice(run.id, "parser", createWorkerForRunner("ember"));
    expect(steered.status).toBe("planned");
    expect(steered.plan.unassigned).toHaveLength(0);
    expect(steered.plan.waves.at(-1)?.slices[0]?.assignedWorkerId).toBe("ember");
    expect(steered.slices[0]?.status).toBe("pending");
    expect(steered.events.at(-1)?.type).toBe("slice_reassigned");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run store does not reassign dependency-blocked slices ahead of prerequisites", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const store = new QuestRunStore(root, root);

  try {
    const run = await store.createRun(
      createSpec({
        maxParallel: 1,
        slices: [
          createSlice({
            id: "parser",
            owns: ["src/parser.ts"],
            preferredRunner: "openclaw",
            title: "Parser",
          }),
          createSlice({
            dependsOn: ["parser"],
            id: "tests",
            owns: ["test/parser.test.ts"],
            title: "Tests",
          }),
        ],
      }),
      [],
    );
    const worker = createWorkerForRunner("ember");

    await expect(store.reassignSlice(run.id, "tests", worker)).rejects.toMatchObject({
      code: "quest_slice_not_steerable",
    });

    const parserAssigned = await store.reassignSlice(run.id, "parser", worker);
    expect(parserAssigned.plan.waves.map((wave) => wave.slices.map((slice) => slice.id))).toEqual([
      ["parser"],
    ]);

    const testsAssigned = await store.reassignSlice(run.id, "tests", worker);
    expect(testsAssigned.plan.waves.map((wave) => wave.slices.map((slice) => slice.id))).toEqual([
      ["parser"],
      ["tests"],
    ]);
    expect(testsAssigned.slices.find((slice) => slice.sliceId === "parser")?.wave).toBe(1);
    expect(testsAssigned.slices.find((slice) => slice.sliceId === "tests")?.wave).toBe(2);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run store reassignment overrides a stale preferred runner on the persisted spec", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const store = new QuestRunStore(root, root);

  try {
    const run = await store.createRun(
      createSpec({
        maxParallel: 1,
        slices: [createSlice({ id: "parser", preferredRunner: "openclaw" })],
      }),
      [],
    );
    const steered = await store.reassignSlice(run.id, "parser", createWorkerForRunner("ember"));
    expect(steered.spec.slices[0]?.preferredWorkerId).toBe("ember");
    expect(steered.spec.slices[0]?.preferredRunner).toBe("codex");
    expect(steered.plan.warnings).toHaveLength(0);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run store can skip a blocked slice and unblock the run", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const store = new QuestRunStore(root, root);

  try {
    const run = await store.createRun(createSpec({ maxParallel: 1 }), []);
    const steered = await store.skipSlice(run.id, "parser", "not worth doing");
    expect(steered.status).toBe("completed");
    expect(steered.plan.unassigned).toHaveLength(0);
    expect(steered.slices[0]?.status).toBe("skipped");
    expect(steered.slices[0]?.integrationStatus).toBe("noop");
    expect(steered.events.at(-1)?.type).toBe("slice_skipped");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run store hydrates missing workspace paths for legacy run documents", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const store = new QuestRunStore(runsRoot, workspacesRoot);

  try {
    const run = await store.createRun(createSpec({ maxParallel: 2 }), [
      createWorkerForRunner("ember"),
    ]);
    const runPath = join(runsRoot, `${run.id}.json`);
    const rawRun = JSON.parse(readFileSync(runPath, "utf8")) as {
      slices: Array<Record<string, unknown>>;
      workspaceRoot?: string;
    };

    delete rawRun.workspaceRoot;
    rawRun.slices.forEach((slice) => {
      delete slice.workspacePath;
    });
    writeFileSync(runPath, `${JSON.stringify(rawRun, null, 2)}\n`, "utf8");

    const hydratedRun = await store.getRun(run.id);
    const canonicalWorkspacesRoot = join(realpathSync(root), "workspaces");
    expect(hydratedRun.workspaceRoot).toBe(join(canonicalWorkspacesRoot, run.id));
    expect(hydratedRun.slices[0]?.workspacePath).toBe(
      join(canonicalWorkspacesRoot, run.id, "slices", "parser"),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run store rejects tampered workspace paths outside the configured workspaces root", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const store = new QuestRunStore(runsRoot, workspacesRoot);

  try {
    const run = await store.createRun(createSpec({ maxParallel: 2 }), [
      createWorkerForRunner("ember"),
    ]);
    const runPath = join(runsRoot, `${run.id}.json`);
    const rawRun = JSON.parse(readFileSync(runPath, "utf8")) as {
      slices: Array<Record<string, unknown>>;
      workspaceRoot: string;
    };

    rawRun.workspaceRoot = "/tmp/quest-runner-evil";
    rawRun.slices[0] = {
      ...rawRun.slices[0],
      workspacePath: "/tmp/quest-runner-evil/slices/parser",
    };
    writeFileSync(runPath, `${JSON.stringify(rawRun, null, 2)}\n`, "utf8");

    try {
      await store.getRun(run.id);
      throw new Error("Expected quest_workspace_materialization_failed");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_workspace_materialization_failed");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run store rejects tampered integration workspaces outside the run root", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const store = new QuestRunStore(runsRoot, workspacesRoot);

  try {
    const run = await store.createRun(createSpec({ maxParallel: 2 }), [
      createWorkerForRunner("ember"),
    ]);
    const runPath = join(runsRoot, `${run.id}.json`);
    const rawRun = JSON.parse(readFileSync(runPath, "utf8")) as Record<string, unknown>;

    rawRun.integrationWorkspacePath = "/tmp/quest-runner-evil/integration";
    writeFileSync(runPath, `${JSON.stringify(rawRun, null, 2)}\n`, "utf8");

    try {
      await store.getRun(run.id);
      throw new Error("Expected quest_workspace_materialization_failed");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_workspace_materialization_failed");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
