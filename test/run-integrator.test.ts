import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QuestDomainError } from "../src/core/errors";
import { QuestRunExecutor } from "../src/core/runs/executor";
import { QuestRunIntegrator } from "../src/core/runs/integrator";
import { QuestRunStore } from "../src/core/runs/store";
import { WorkerRegistry } from "../src/core/workers/registry";
import {
  createCommand,
  createCommittedRepo,
  createSlice,
  createSpec,
  createWorker,
  runCommandOrThrow,
} from "./helpers";

test("run integrator cherry-picks completed slice changes into a dedicated integration worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-integrator-"));
  const repositoryRoot = createCommittedRepo(root);
  const scriptPath = join(root, "worker-update.ts");
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const integrator = new QuestRunIntegrator(runStore);

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
    await executor.executeRun(run.id);
    const integratedRun = await integrator.integrateRun(run.id);
    const integrationWorkspacePath = integratedRun.integrationWorkspacePath ?? "";

    expect(readFileSync(join(repositoryRoot, "tracked.txt"), "utf8")).toBe("from-source-repo\n");
    expect(readFileSync(join(integrationWorkspacePath, "tracked.txt"), "utf8")).toBe(
      "integrated-change\n",
    );
    expect(integratedRun.events.some((event) => event.type === "run_integrated")).toBe(true);
    expect(integratedRun.slices[0]?.integrationStatus).toBe("integrated");
    expect(integratedRun.slices[0]?.integratedCommit).toBeDefined();

    const diffResult = Bun.spawnSync({
      cmd: ["git", "log", "-1", "--pretty=%B"],
      cwd: integrationWorkspacePath,
      env: Bun.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(diffResult.exitCode).toBe(0);
    expect(new TextDecoder().decode(diffResult.stdout)).toContain("Quest-Slice-Id: parser");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run integrator refuses runs that are not completed", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-integrator-"));
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const integrator = new QuestRunIntegrator(runStore);

  try {
    const run = await runStore.createRun(createSpec(), [createWorker()]);

    try {
      await integrator.integrateRun(run.id);
      throw new Error("Expected quest_run_not_integratable");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_run_not_integratable");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run integrator fails when drift causes a cherry-pick conflict", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-integrator-"));
  const repositoryRoot = createCommittedRepo(root);
  const scriptPath = join(root, "worker-update.ts");
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const integrator = new QuestRunIntegrator(runStore);

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
    await executor.executeRun(run.id);

    writeFileSync(join(repositoryRoot, "tracked.txt"), "conflicting-change\n", "utf8");
    runCommandOrThrow(["git", "add", "tracked.txt"], repositoryRoot);
    runCommandOrThrow(["git", "commit", "-m", "Drift source repo"], repositoryRoot);

    try {
      await integrator.integrateRun(run.id);
      throw new Error("Expected quest_integration_failed");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_integration_failed");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run integrator runs top-level acceptance checks in the integration workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-integrator-"));
  const repositoryRoot = createCommittedRepo(root);
  const scriptPath = join(root, "worker-update.ts");
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const integrator = new QuestRunIntegrator(runStore);

  try {
    writeFileSync(scriptPath, "await Bun.write('tracked.txt', 'integrated-change\\n');\n", "utf8");
    await workerRegistry.upsertWorker(
      createWorker({}, { adapter: "local-command", command: ["bun", scriptPath] }),
    );

    const run = await runStore.createRun(
      createSpec({
        acceptanceChecks: [
          createCommand(["bun", "-e", "process.exit(Bun.file('tracked.txt').size > 0 ? 0 : 1)"]),
        ],
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
    await executor.executeRun(run.id);
    const integratedRun = await integrator.integrateRun(run.id);

    expect(integratedRun.lastIntegrationChecks?.[0]?.exitCode).toBe(0);
    expect(
      integratedRun.events.some((event) => event.type === "run_integration_checks_completed"),
    ).toBe(true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run integrator runs workspace preparation commands before top-level checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-integrator-"));
  const repositoryRoot = createCommittedRepo(root);
  const scriptPath = join(root, "worker-update.ts");
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const integrator = new QuestRunIntegrator(runStore);

  try {
    writeFileSync(scriptPath, "await Bun.write('tracked.txt', 'integrated-change\\n');\n", "utf8");
    await workerRegistry.upsertWorker(
      createWorker({}, { adapter: "local-command", command: ["bun", scriptPath] }),
    );

    const run = await runStore.createRun(
      createSpec({
        acceptanceChecks: [
          createCommand([
            "bun",
            "-e",
            "process.exit((await Bun.file('node_modules/.keep').text()) === 'prepared\\n' ? 0 : 1)",
          ]),
        ],
        execution: {
          prepareCommands: [
            createCommand([
              "sh",
              "-lc",
              "mkdir -p node_modules && printf 'prepared\\n' > node_modules/.keep",
            ]),
          ],
          shareSourceDependencies: true,
          timeoutMinutes: 20,
        },
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
    await executor.executeRun(run.id);
    const integratedRun = await integrator.integrateRun(run.id);

    expect(integratedRun.lastIntegrationChecks?.[0]?.exitCode).toBe(0);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run integrator rejects slice changes outside owned paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-integrator-"));
  const repositoryRoot = createCommittedRepo(root);
  const scriptPath = join(root, "worker-update.ts");
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const integrator = new QuestRunIntegrator(runStore);

  try {
    writeFileSync(
      scriptPath,
      [
        "await Bun.write('tracked.txt', 'integrated-change\\n');",
        "await Bun.write('outside.txt', 'should-not-land\\n');",
      ].join("\n"),
      "utf8",
    );
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
    await executor.executeRun(run.id);

    await expect(integrator.integrateRun(run.id)).rejects.toMatchObject({
      code: "quest_integration_failed",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run integrator rejects resuming against a different target ref", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-integrator-"));
  const repositoryRoot = createCommittedRepo(root);
  const scriptPath = join(root, "worker-update.ts");
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const integrator = new QuestRunIntegrator(runStore);

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
    await executor.executeRun(run.id);
    await integrator.integrateRun(run.id, { targetRef: "HEAD" });

    const reloadedRun = await runStore.getRun(run.id);
    reloadedRun.events = reloadedRun.events.filter((event) => event.type !== "run_integrated");
    await runStore.saveRun(reloadedRun);

    try {
      await integrator.integrateRun(run.id, { targetRef: "HEAD~1" });
      throw new Error("Expected quest_integration_failed");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_integration_failed");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run integrator rejects resuming when the target ref name is unchanged but now points elsewhere", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-integrator-"));
  const repositoryRoot = createCommittedRepo(root);
  const scriptPath = join(root, "worker-update.ts");
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const integrator = new QuestRunIntegrator(runStore);

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
    await executor.executeRun(run.id);
    await integrator.integrateRun(run.id, { targetRef: "HEAD" });

    writeFileSync(join(repositoryRoot, "tracked.txt"), "new-head-change\n", "utf8");
    runCommandOrThrow(["git", "add", "tracked.txt"], repositoryRoot);
    runCommandOrThrow(["git", "commit", "-m", "Move HEAD forward"], repositoryRoot);

    const resumedRun = await runStore.getRun(run.id);
    resumedRun.events = resumedRun.events.filter((event) => event.type !== "run_integrated");
    await runStore.saveRun(resumedRun);

    try {
      await integrator.integrateRun(run.id, { targetRef: "HEAD" });
      throw new Error("Expected quest_integration_failed");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_integration_failed");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run integrator resumes from an existing clean integration workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-integrator-"));
  const repositoryRoot = createCommittedRepo(root);
  const scriptPath = join(root, "worker-update.ts");
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workspacesRoot = join(root, "workspaces");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const integrator = new QuestRunIntegrator(runStore);

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
    await executor.executeRun(run.id);
    const firstIntegratedRun = await integrator.integrateRun(run.id);
    const reloadedRun = await runStore.getRun(run.id);
    reloadedRun.events = reloadedRun.events.filter((event) => event.type !== "run_integrated");
    await runStore.saveRun(reloadedRun);

    const resumedRun = await integrator.integrateRun(run.id);

    expect(resumedRun.integrationWorkspacePath).toBe(firstIntegratedRun.integrationWorkspacePath);
    expect(
      resumedRun.events.filter(
        (event) => event.type === "slice_integrated" && event.details.applied,
      ).length,
    ).toBe(1);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
