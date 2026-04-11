import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QuestDomainError } from "../src/core/errors";
import { QuestRunStore } from "../src/core/run-store";
import { createSlice, createSpec, createWorkerForRunner } from "./helpers";

test("run store creates a planned run and lists it", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const store = new QuestRunStore(root, root);

  try {
    const run = await store.createRun(createSpec({ maxParallel: 2 }), [
      createWorkerForRunner("ember"),
    ]);
    expect(run.status).toBe("planned");
    expect(run.workspaceRoot).toBe(join(root, run.id));
    expect(run.slices[0]?.workspacePath).toBe(join(root, run.id, "slices", "parser"));
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

    const initialLogs = await store.getRunLogs(run.id);
    expect(initialLogs.slices).toEqual([
      {
        sliceId: "parser",
        status: "pending",
        title: "Parser",
        wave: 1,
        workspacePath: join(root, run.id, "slices", "parser"),
        lastError: undefined,
        lastOutput: undefined,
      },
    ]);
    expect(initialLogs.workspaceRoot).toBe(join(root, run.id));

    const aborted = await store.abortRun(run.id);
    expect(aborted.status).toBe("aborted");
    expect(aborted.slices[0]?.status).toBe("aborted");
    expect(aborted.events.some((event) => event.type === "run_aborted")).toBe(true);
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
    expect(hydratedRun.workspaceRoot).toBe(join(workspacesRoot, run.id));
    expect(hydratedRun.slices[0]?.workspacePath).toBe(
      join(workspacesRoot, run.id, "slices", "parser"),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
