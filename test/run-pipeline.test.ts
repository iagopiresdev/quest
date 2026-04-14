import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { QuestDomainError } from "../src/core/errors";
import { QuestPartyStateStore } from "../src/core/party-state";
import { QuestRunExecutor } from "../src/core/runs/executor";
import { QuestRunIntegrator } from "../src/core/runs/integrator";
import { QuestRunLander } from "../src/core/runs/lander";
import { QuestRunPipeline } from "../src/core/runs/pipeline";
import { QuestRunStore } from "../src/core/runs/store";
import { WorkerRegistry } from "../src/core/workers/registry";
import { createCommittedRepo, createSlice, createSpec, createWorker } from "./helpers";

test("run pipeline can auto-integrate a completed run", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-pipeline-"));
  const repositoryRoot = createCommittedRepo(root);
  const scriptPath = join(root, "worker-update.ts");
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const partyStateStore = new QuestPartyStateStore(join(root, "party-state.json"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const integrator = new QuestRunIntegrator(runStore);
  const lander = new QuestRunLander(runStore);
  const pipeline = new QuestRunPipeline(executor, integrator, lander, partyStateStore);

  try {
    writeFileSync(scriptPath, "await Bun.write('tracked.txt', 'integrated-change\\n');\n", "utf8");
    await workerRegistry.upsertWorker(
      createWorker({}, { adapter: "local-command", command: ["bun", scriptPath] }),
    );

    const run = await runStore.createRun(
      createSpec({
        slices: [
          createSlice({
            owns: ["tracked.txt"],
          }),
        ],
      }),
      await workerRegistry.listWorkers(),
      {
        sourceRepositoryPath: repositoryRoot,
      },
    );
    const completedRun = await pipeline.executeRun(run.id, {
      autoIntegrate: true,
      targetRef: "HEAD",
    });

    expect(completedRun.status).toBe("completed");
    expect(completedRun.events.some((event) => event.type === "run_integrated")).toBe(true);
    expect(completedRun.slices[0]?.integrationStatus).toBe("integrated");
    expect(readFileSync(join(repositoryRoot, "tracked.txt"), "utf8")).toBe("from-source-repo\n");
    expect(
      readFileSync(join(completedRun.integrationWorkspacePath ?? "", "tracked.txt"), "utf8"),
    ).toBe("integrated-change\n");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run pipeline rejects dry-run auto-integration", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-pipeline-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const partyStateStore = new QuestPartyStateStore(join(root, "party-state.json"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const integrator = new QuestRunIntegrator(runStore);
  const lander = new QuestRunLander(runStore);
  const pipeline = new QuestRunPipeline(executor, integrator, lander, partyStateStore);

  try {
    await workerRegistry.upsertWorker(createWorker());
    const run = await runStore.createRun(createSpec(), await workerRegistry.listWorkers());

    await expect(
      pipeline.executeRun(run.id, {
        autoIntegrate: true,
        dryRun: true,
      }),
    ).rejects.toMatchObject({
      code: "quest_run_invalid_execute_options",
    } satisfies Partial<QuestDomainError>);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run pipeline can auto-integrate and land a completed run", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-pipeline-"));
  const repositoryRoot = createCommittedRepo(root);
  const scriptPath = join(root, "worker-land.ts");
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const partyStateStore = new QuestPartyStateStore(join(root, "party-state.json"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const integrator = new QuestRunIntegrator(runStore);
  const lander = new QuestRunLander(runStore);
  const pipeline = new QuestRunPipeline(executor, integrator, lander, partyStateStore);

  try {
    writeFileSync(scriptPath, "await Bun.write('tracked.txt', 'landed-change\\n');\n", "utf8");
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
    const landedRun = await pipeline.executeRun(run.id, {
      autoIntegrate: true,
      land: true,
      targetRef: "HEAD",
    });

    expect(landedRun.landedAt).toBeString();
    expect(landedRun.landedRevision).toBeString();
    expect(readFileSync(join(repositoryRoot, "tracked.txt"), "utf8")).toBe("landed-change\n");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run pipeline refuses new dispatch while the party rests at a bonfire", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-pipeline-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const partyStateStore = new QuestPartyStateStore(join(root, "party-state.json"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const integrator = new QuestRunIntegrator(runStore);
  const lander = new QuestRunLander(runStore);
  const pipeline = new QuestRunPipeline(executor, integrator, lander, partyStateStore);

  try {
    await workerRegistry.upsertWorker(createWorker());
    const run = await runStore.createRun(createSpec(), await workerRegistry.listWorkers());
    await partyStateStore.lightBonfire("maintenance");

    await expect(pipeline.executeRun(run.id)).rejects.toMatchObject({
      code: "quest_party_resting",
    } satisfies Partial<QuestDomainError>);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
