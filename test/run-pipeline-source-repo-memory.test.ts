import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QuestPartyStateStore } from "../src/core/party-state";
import { QuestRunExecutor } from "../src/core/runs/executor";
import { QuestRunIntegrator } from "../src/core/runs/integrator";
import { QuestRunLander } from "../src/core/runs/lander";
import { QuestRunPipeline } from "../src/core/runs/pipeline";
import { QuestRunStore } from "../src/core/runs/store";
import { WorkerRegistry } from "../src/core/workers/registry";
import { createCommittedRepo, createSlice, createSpec, createWorker } from "./helpers";

test("runs execute reuses the run's persisted source repo when --source-repo is omitted (exec-only)", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-source-repo-memory-"));
  const repositoryRoot = createCommittedRepo(root);
  const scriptPath = join(root, "worker.ts");
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
    writeFileSync(scriptPath, "await Bun.write('tracked.txt', 'from-worker\\n');\n", "utf8");
    await workerRegistry.upsertWorker(
      createWorker({}, { adapter: "local-command", command: ["bun", scriptPath] }),
    );

    // Create the run with --source-repo equivalent via createRun options.
    const run = await runStore.createRun(
      createSpec({ slices: [createSlice({ owns: ["tracked.txt"] })] }),
      await workerRegistry.listWorkers(),
      { sourceRepositoryPath: repositoryRoot },
    );
    expect(run.sourceRepositoryPath).toBe(repositoryRoot);

    // Execute WITHOUT passing sourceRepositoryPath.
    const executed = await pipeline.executeRun(run.id, {});

    expect(executed.status).toBe("completed");
    expect(executed.sourceRepositoryPath).toBe(repositoryRoot);
    const workspacePath = executed.slices[0]?.workspacePath ?? "";
    expect(readFileSync(join(workspacePath, "tracked.txt"), "utf8")).toBe("from-worker\n");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("runs execute --auto-integrate --land reuses persisted source repo when --source-repo is omitted", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-source-repo-memory-"));
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
    writeFileSync(scriptPath, "await Bun.write('tracked.txt', 'remembered-land\\n');\n", "utf8");
    await workerRegistry.upsertWorker(
      createWorker({}, { adapter: "local-command", command: ["bun", scriptPath] }),
    );

    const run = await runStore.createRun(
      createSpec({ slices: [createSlice({ owns: ["tracked.txt"] })] }),
      await workerRegistry.listWorkers(),
      { sourceRepositoryPath: repositoryRoot },
    );

    const landed = await pipeline.executeRun(run.id, {
      autoIntegrate: true,
      land: true,
      targetRef: "HEAD",
    });

    expect(landed.landedAt).toBeString();
    expect(landed.landedRevision).toBeString();
    expect(landed.sourceRepositoryPath).toBe(repositoryRoot);
    expect(readFileSync(join(repositoryRoot, "tracked.txt"), "utf8")).toBe("remembered-land\n");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
