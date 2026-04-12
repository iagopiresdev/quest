import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QuestDomainError } from "../src/core/errors";
import { QuestRunCleanup } from "../src/core/runs/cleanup";
import { QuestRunExecutor } from "../src/core/runs/executor";
import { QuestRunIntegrator } from "../src/core/runs/integrator";
import { QuestRunStore } from "../src/core/runs/store";
import { WorkerRegistry } from "../src/core/workers/registry";
import { createCommittedRepo, createSpec, createWorker } from "./helpers";

test("run cleanup removes a completed plain workspace root", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-cleanup-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const cleanup = new QuestRunCleanup(runStore);

  try {
    await workerRegistry.upsertWorker(createWorker());
    const run = await runStore.createRun(createSpec(), await workerRegistry.listWorkers());
    const executed = await executor.executeRun(run.id, { dryRun: true });

    expect(existsSync(executed.workspaceRoot ?? "")).toBe(true);

    const cleaned = await cleanup.cleanupRun(run.id);
    expect(existsSync(cleaned.workspaceRoot ?? "")).toBe(false);
    expect(cleaned.events.some((event) => event.type === "run_workspace_cleaned")).toBe(true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run cleanup removes git worktrees from the source repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-cleanup-"));
  const repositoryRoot = createCommittedRepo(root);
  const scriptPath = join(root, "worker-materialized.ts");
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const integrator = new QuestRunIntegrator(runStore);
  const cleanup = new QuestRunCleanup(runStore);

  try {
    await Bun.write(
      scriptPath,
      [
        "const tracked = await Bun.file('tracked.txt').text();",
        "await Bun.write(Bun.stdout, tracked.trim());",
      ].join("\n"),
    );
    await workerRegistry.upsertWorker(
      createWorker({}, { adapter: "local-command", command: ["bun", scriptPath] }),
    );

    const run = await runStore.createRun(createSpec(), await workerRegistry.listWorkers(), {
      sourceRepositoryPath: repositoryRoot,
    });
    const executed = await executor.executeRun(run.id);
    const workspacePath = executed.slices[0]?.workspacePath ?? "";

    expect(existsSync(workspacePath)).toBe(true);
    await integrator.integrateRun(run.id);

    await cleanup.cleanupRun(run.id);

    const worktreeList = Bun.spawnSync({
      cmd: ["git", "worktree", "list", "--porcelain"],
      cwd: repositoryRoot,
      env: Bun.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(worktreeList.exitCode).toBe(0);
    expect(existsSync(workspacePath)).toBe(false);
    expect(new TextDecoder().decode(worktreeList.stdout)).not.toContain(workspacePath);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run cleanup refuses completed source-repo runs before integration", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-cleanup-"));
  const repositoryRoot = createCommittedRepo(root);
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const cleanup = new QuestRunCleanup(runStore);

  try {
    await workerRegistry.upsertWorker(createWorker());
    const run = await runStore.createRun(createSpec(), await workerRegistry.listWorkers(), {
      sourceRepositoryPath: repositoryRoot,
    });
    await executor.executeRun(run.id, { dryRun: true });

    try {
      await cleanup.cleanupRun(run.id);
      throw new Error("Expected quest_run_not_cleanupable");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_run_not_cleanupable");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run cleanup removes aborted source-repo workspaces without integration", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-cleanup-"));
  const repositoryRoot = createCommittedRepo(root);
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const cleanup = new QuestRunCleanup(runStore);

  try {
    const run = await runStore.createRun(createSpec(), [createWorker()], {
      sourceRepositoryPath: repositoryRoot,
    });
    const workspaceRoot = join(workspacesRoot, run.id);
    const sliceWorkspace = join(workspaceRoot, "slices", "parser");
    await Bun.$`git -C ${repositoryRoot} worktree add --detach ${sliceWorkspace}`.quiet();

    run.status = "aborted";
    run.workspaceRoot = workspaceRoot;
    if (run.slices[0]) {
      run.slices[0].status = "aborted";
      run.slices[0].workspacePath = sliceWorkspace;
    }
    await runStore.saveRun(run);

    expect(existsSync(sliceWorkspace)).toBe(true);

    const cleaned = await cleanup.cleanupRun(run.id);

    expect(existsSync(cleaned.workspaceRoot ?? "")).toBe(false);
    expect(cleaned.events.some((event) => event.type === "run_workspace_cleaned")).toBe(true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run cleanup refuses runs that are still marked running", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-cleanup-"));
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const cleanup = new QuestRunCleanup(runStore);

  try {
    const run = await runStore.createRun(createSpec(), [createWorker()]);
    run.status = "running";
    await runStore.saveRun(run);

    try {
      await cleanup.cleanupRun(run.id);
      throw new Error("Expected quest_run_not_cleanupable");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_run_not_cleanupable");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
