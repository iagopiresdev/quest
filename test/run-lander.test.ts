import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { QuestDomainError } from "../src/core/errors";
import { QuestRunExecutor } from "../src/core/runs/executor";
import { QuestRunIntegrator } from "../src/core/runs/integrator";
import { QuestRunLander } from "../src/core/runs/lander";
import { QuestRunRefresher } from "../src/core/runs/refresher";
import { QuestRunStore } from "../src/core/runs/store";
import { WorkerRegistry } from "../src/core/workers/registry";
import {
  createCommittedRepo,
  createSlice,
  createSpec,
  createWorker,
  runCommandOrThrow,
} from "./helpers";

test("run lander fast-forwards the source repo from the integration workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-lander-"));
  const repositoryRoot = createCommittedRepo(root);
  const scriptPath = join(root, "worker-lander.ts");
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const integrator = new QuestRunIntegrator(runStore);
  const lander = new QuestRunLander(runStore);

  try {
    writeFileSync(scriptPath, "await Bun.write('tracked.txt', 'lander-change\\n');\n", "utf8");
    await workerRegistry.upsertWorker(
      createWorker({}, { adapter: "local-command", command: ["bun", scriptPath] }),
    );

    const run = await runStore.createRun(
      createSpec({
        slices: [createSlice({ owns: ["tracked.txt"] })],
      }),
      await workerRegistry.listWorkers(),
      { sourceRepositoryPath: repositoryRoot },
    );

    await executor.executeRun(run.id);
    await integrator.integrateRun(run.id, { targetRef: "HEAD" });
    const landed = await lander.landRun(run.id, { targetRef: "HEAD" });

    expect(landed.landedAt).toBeDefined();
    expect(landed.landedRevision).toBeDefined();
    expect(landed.events.some((event) => event.type === "run_landed")).toBe(true);
    expect(readFileSync(join(repositoryRoot, "tracked.txt"), "utf8")).toBe("lander-change\n");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run lander refuses to land when the source repo drifted after integration", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-lander-"));
  const repositoryRoot = createCommittedRepo(root);
  const scriptPath = join(root, "worker-lander-drift.ts");
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const integrator = new QuestRunIntegrator(runStore);
  const lander = new QuestRunLander(runStore);

  try {
    writeFileSync(scriptPath, "await Bun.write('tracked.txt', 'lander-change\\n');\n", "utf8");
    await workerRegistry.upsertWorker(
      createWorker({}, { adapter: "local-command", command: ["bun", scriptPath] }),
    );

    const run = await runStore.createRun(
      createSpec({
        slices: [createSlice({ owns: ["tracked.txt"] })],
      }),
      await workerRegistry.listWorkers(),
      { sourceRepositoryPath: repositoryRoot },
    );

    await executor.executeRun(run.id);
    await integrator.integrateRun(run.id, { targetRef: "HEAD" });
    writeFileSync(join(repositoryRoot, "unrelated.txt"), "drifted\n", "utf8");
    runCommandOrThrow(["git", "add", "unrelated.txt"], repositoryRoot);
    runCommandOrThrow(["git", "commit", "-m", "Advance base without conflict"], repositoryRoot);

    await expect(lander.landRun(run.id, { targetRef: "HEAD" })).rejects.toMatchObject({
      code: "quest_run_not_landable",
    } satisfies Partial<QuestDomainError>);

    const updated = await runStore.getRun(run.id);
    expect(updated.integrationRescueStatus).toBe("pending");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run refresher rebuilds boss fight after target drift so landing can succeed", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-lander-"));
  const repositoryRoot = createCommittedRepo(root);
  const scriptPath = join(root, "worker-refresh.ts");
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const integrator = new QuestRunIntegrator(runStore);
  const refresher = new QuestRunRefresher(runStore, integrator);
  const lander = new QuestRunLander(runStore);

  try {
    writeFileSync(scriptPath, "await Bun.write('tracked.txt', 'refresh-change\\n');\n", "utf8");
    await workerRegistry.upsertWorker(
      createWorker({}, { adapter: "local-command", command: ["bun", scriptPath] }),
    );

    const run = await runStore.createRun(
      createSpec({
        slices: [createSlice({ owns: ["tracked.txt"] })],
      }),
      await workerRegistry.listWorkers(),
      { sourceRepositoryPath: repositoryRoot },
    );

    await executor.executeRun(run.id);
    await integrator.integrateRun(run.id, { targetRef: "HEAD" });

    writeFileSync(join(repositoryRoot, "unrelated.txt"), "drifted\n", "utf8");
    runCommandOrThrow(["git", "add", "unrelated.txt"], repositoryRoot);
    runCommandOrThrow(["git", "commit", "-m", "Advance base without conflict"], repositoryRoot);

    const refreshed = await refresher.refreshBase(run.id, { targetRef: "HEAD" });
    expect(refreshed.events.some((event) => event.type === "run_base_refreshed")).toBe(true);
    expect(refreshed.integrationBaseRevision).toBeTruthy();

    const landed = await lander.landRun(run.id, { targetRef: "HEAD" });
    expect(landed.landedRevision).toBeTruthy();
    expect(readFileSync(join(repositoryRoot, "tracked.txt"), "utf8")).toBe("refresh-change\n");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
