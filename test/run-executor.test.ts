import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QuestDomainError } from "../src/core/errors";
import type { QuestSpec } from "../src/core/planning/spec-schema";
import { QuestRunExecutor } from "../src/core/runs/executor";
import { QuestRunStore } from "../src/core/runs/store";
import { resolveRunWorkspaceRootPath } from "../src/core/runs/workspace-layout";
import { SecretStore } from "../src/core/secret-store";
import { WorkerRegistry } from "../src/core/workers/registry";
import type { RegisteredWorker } from "../src/core/workers/schema";
import {
  createCommand,
  createCommittedRepo,
  createOpenClawMockExecutable,
  startTestServer,
} from "./helpers";

function createWorker(
  id: string,
  adapter = "local-cli",
  command?: string[],
  backendOverrides: Partial<RegisteredWorker["backend"]> = {},
): RegisteredWorker {
  return {
    backend: {
      adapter,
      command,
      profile: "gpt-5.4",
      runner: "codex",
      toolPolicy: { allow: [], deny: [] },
      ...backendOverrides,
    },
    calibration: {
      history: [],
    },
    class: "engineer",
    enabled: true,
    id,
    name: id,
    persona: {
      approach: "explicit",
      prompt: "Keep diffs narrow.",
      voice: "terse",
    },
    progression: { level: 1, xp: 0 },
    role: "hybrid",
    resources: { cpuCost: 1, gpuCost: 0, maxParallel: 1, memoryCost: 1 },
    stats: {
      coding: 80,
      contextEndurance: 60,
      docs: 40,
      mergeSafety: 75,
      research: 50,
      speed: 65,
      testing: 55,
    },
    tags: [],
    title: "Worker",
    trust: { calibratedAt: "2026-04-11T00:00:00Z", rating: 0.75 },
  };
}

function createSpec(overrides: Partial<QuestSpec> = {}): QuestSpec {
  return {
    acceptanceChecks: [],
    execution: {
      preInstall: false,
      shareSourceDependencies: true,
      testerSelectionStrategy: "balanced",
      timeoutMinutes: 20,
    },
    featureDoc: { enabled: false },
    hotspots: [],
    maxParallel: 2,
    slices: [
      {
        acceptanceChecks: [],
        contextHints: [],
        dependsOn: [],
        discipline: "coding",
        goal: "Implement parser changes",
        id: "parser",
        owns: ["src/security/url.ts"],
        title: "Parser",
      },
      {
        acceptanceChecks: [],
        contextHints: [],
        dependsOn: [],
        discipline: "docs",
        goal: "Draft docs changes",
        id: "docs",
        owns: ["docs/features/**"],
        title: "Docs",
      },
    ],
    title: "Execute quest run",
    version: 1,
    workspace: "command-center",
    ...overrides,
  };
}

test("run executor completes a planned run in dry-run mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    await workerRegistry.upsertWorker(createWorker("ember"));
    await workerRegistry.upsertWorker(createWorker("atlas"));

    const run = await runStore.createRun(createSpec(), await workerRegistry.listWorkers());
    const executed = await executor.executeRun(run.id, { dryRun: true });
    const workspaceRoot = executed.workspaceRoot ?? "";
    const workspacePath = executed.slices[0]?.workspacePath ?? "";

    expect(executed.status).toBe("completed");
    expect(executed.slices.every((slice) => slice.status === "completed")).toBe(true);
    expect(executed.slices[0]?.lastOutput?.summary).toContain("Dry run completed slice");
    expect(executed.slices[0]?.lastOutput?.exitCode).toBe(0);
    expect(existsSync(workspaceRoot)).toBe(true);
    expect(existsSync(workspacePath)).toBe(true);
    expect(
      JSON.parse(readFileSync(join(workspacePath, ".quest", "context.json"), "utf8")).sliceId,
    ).toBe("parser");
    expect(executed.events.some((event) => event.type === "run_started")).toBe(true);
    expect(executed.events.some((event) => event.type === "run_completed")).toBe(true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor completes a planned run with the local-command adapter", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    const scriptPath = join(root, "worker-success.ts");
    Bun.write(
      scriptPath,
      [
        "const input = JSON.parse(await Bun.stdin.text());",
        "await Bun.write(Bun.stdout, 'completed:' + input.slice.id + ':' + input.worker.id);",
      ].join("\n"),
    );

    await workerRegistry.upsertWorker(createWorker("ember", "local-command", ["bun", scriptPath]));
    const spec: QuestSpec = {
      acceptanceChecks: [],
      execution: {
        preInstall: false,
        shareSourceDependencies: true,
        testerSelectionStrategy: "balanced",
        timeoutMinutes: 20,
      },
      featureDoc: { enabled: false },
      hotspots: [],
      maxParallel: 1,
      slices: [
        {
          acceptanceChecks: [],
          contextHints: [],
          dependsOn: [],
          discipline: "coding",
          goal: "Implement parser changes",
          id: "parser",
          owns: ["src/security/url.ts"],
          title: "Parser",
        },
      ],
      title: "Local command run",
      version: 1,
      workspace: "command-center",
    };

    const run = await runStore.createRun(spec, await workerRegistry.listWorkers());
    const executed = await executor.executeRun(run.id);

    expect(executed.status).toBe("completed");
    expect(executed.slices[0]?.lastOutput?.stdout).toContain("completed:parser:ember");
    expect(executed.slices[0]?.lastOutput?.exitCode).toBe(0);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor uses a dedicated tester worker during the trial phase", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    const builderScriptPath = join(root, "builder-worker.ts");
    writeFileSync(
      builderScriptPath,
      [
        "await Bun.write('artifact.txt', 'builder-output\\n');",
        "await Bun.write(Bun.stdout, 'builder:' + Bun.env.QUEST_SLICE_PHASE);",
      ].join("\n"),
      "utf8",
    );

    const testerScriptPath = join(root, "tester-worker.ts");
    writeFileSync(
      testerScriptPath,
      [
        "const payload = JSON.parse(await Bun.stdin.text());",
        "if (payload.sliceState.lastOutput?.summary !== 'builder:build') {",
        "  throw new Error('missing builder output in tester payload');",
        "}",
        "await Bun.write('artifact.txt', 'tester-fixed\\n');",
        "await Bun.write(Bun.stdout, 'tester:' + Bun.env.QUEST_SLICE_PHASE);",
      ].join("\n"),
      "utf8",
    );

    const builderWorker = createWorker("builder-only", "local-command", ["bun", builderScriptPath]);
    builderWorker.role = "builder";
    builderWorker.stats.testing = 10;
    builderWorker.stats.coding = 90;

    const testerWorker = createWorker("tester-only", "local-command", ["bun", testerScriptPath]);
    testerWorker.role = "tester";
    testerWorker.stats.testing = 95;
    testerWorker.stats.coding = 20;

    await workerRegistry.upsertWorker(builderWorker);
    await workerRegistry.upsertWorker(testerWorker);

    const spec: QuestSpec = {
      acceptanceChecks: [],
      execution: {
        preInstall: false,
        shareSourceDependencies: true,
        testerSelectionStrategy: "balanced",
        timeoutMinutes: 20,
      },
      featureDoc: { enabled: false },
      hotspots: [],
      maxParallel: 1,
      slices: [
        {
          acceptanceChecks: [
            createCommand([
              "bun",
              "-e",
              "process.exit((await Bun.file('artifact.txt').text()) === 'tester-fixed\\n' ? 0 : 7)",
            ]),
          ],
          contextHints: [],
          dependsOn: [],
          discipline: "coding",
          goal: "Create the artifact",
          id: "parser",
          owns: ["artifact.txt"],
          title: "Parser",
        },
      ],
      title: "Dedicated tester trial",
      version: 1,
      workspace: "command-center",
    };

    const run = await runStore.createRun(spec, await workerRegistry.listWorkers());
    const executed = await executor.executeRun(run.id);

    expect(executed.status).toBe("completed");
    expect(executed.slices[0]?.assignedWorkerId).toBe("builder-only");
    expect(executed.slices[0]?.assignedTesterWorkerId).toBe("tester-only");
    expect(executed.slices[0]?.lastOutput?.stdout).toBe("builder:build");
    expect(executed.slices[0]?.lastTesterOutput?.stdout).toBe("tester:test");
    expect(executed.slices[0]?.lastChecks?.[0]?.exitCode).toBe(0);
    expect(executed.events.some((event) => event.type === "slice_testing_started")).toBe(true);
    expect(executed.events.some((event) => event.type === "slice_testing_completed")).toBe(true);
    expect(
      readFileSync(join(executed.slices[0]?.workspacePath ?? "", "artifact.txt"), "utf8"),
    ).toBe("tester-fixed\n");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor persists builder output when a dedicated tester fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    const builderScriptPath = join(root, "builder-worker.ts");
    writeFileSync(
      builderScriptPath,
      [
        "await Bun.write('artifact.txt', 'builder-output\\n');",
        "await Bun.write(Bun.stdout, 'builder:' + Bun.env.QUEST_SLICE_PHASE);",
      ].join("\n"),
      "utf8",
    );

    const testerScriptPath = join(root, "tester-worker.ts");
    writeFileSync(
      testerScriptPath,
      [
        "const payload = JSON.parse(await Bun.stdin.text());",
        "if (payload.sliceState.lastOutput?.summary !== 'builder:build') {",
        "  throw new Error('missing builder output in tester payload');",
        "}",
        "process.exit(5);",
      ].join("\n"),
      "utf8",
    );

    const builderWorker = createWorker("builder-only", "local-command", ["bun", builderScriptPath]);
    builderWorker.role = "builder";
    const testerWorker = createWorker("tester-only", "local-command", ["bun", testerScriptPath]);
    testerWorker.role = "tester";
    testerWorker.stats.testing = 95;

    await workerRegistry.upsertWorker(builderWorker);
    await workerRegistry.upsertWorker(testerWorker);

    const spec = createSpec({
      maxParallel: 1,
      slices: [
        {
          acceptanceChecks: [],
          contextHints: [],
          dependsOn: [],
          discipline: "coding",
          goal: "Create the artifact",
          id: "parser",
          owns: ["artifact.txt"],
          title: "Parser",
        },
      ],
      title: "Dedicated tester failure",
    });
    const run = await runStore.createRun(spec, await workerRegistry.listWorkers());

    await expect(executor.executeRun(run.id)).rejects.toMatchObject({
      code: "quest_command_failed",
    });

    const failedRun = await runStore.getRun(run.id);
    expect(failedRun.status).toBe("failed");
    expect(failedRun.slices[0]?.status).toBe("failed");
    expect(failedRun.slices[0]?.lastOutput?.summary).toBe("builder:build");
    expect(failedRun.slices[0]?.lastOutput?.stdout).toBe("builder:build");
    expect(failedRun.slices[0]?.lastError).toContain("tester-only");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor executes the worker inside the slice workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    const scriptPath = join(root, "worker-cwd.ts");
    Bun.write(
      scriptPath,
      [
        "await Bun.write('worker-marker.txt', 'ok');",
        "await Bun.write(Bun.stdout, process.cwd());",
      ].join("\n"),
    );

    await workerRegistry.upsertWorker(createWorker("ember", "local-command", ["bun", scriptPath]));
    const spec: QuestSpec = {
      acceptanceChecks: [],
      execution: {
        preInstall: false,
        shareSourceDependencies: true,
        testerSelectionStrategy: "balanced",
        timeoutMinutes: 20,
      },
      featureDoc: { enabled: false },
      hotspots: [],
      maxParallel: 1,
      slices: [
        {
          acceptanceChecks: [],
          contextHints: [],
          dependsOn: [],
          discipline: "coding",
          goal: "Implement parser changes",
          id: "parser",
          owns: ["src/security/url.ts"],
          title: "Parser",
        },
      ],
      title: "Local command cwd",
      version: 1,
      workspace: "command-center",
    };

    const run = await runStore.createRun(spec, await workerRegistry.listWorkers());
    const executed = await executor.executeRun(run.id);
    const workspacePath = executed.slices[0]?.workspacePath ?? "";

    const expectedWorkspacePath = join(
      realpathSync(join(root, "workspaces")),
      run.id,
      "slices",
      "parser",
    );
    expect(workspacePath).toBe(expectedWorkspacePath);
    expect(realpathSync(executed.slices[0]?.lastOutput?.stdout.trim() ?? "")).toBe(
      realpathSync(workspacePath),
    );
    expect(existsSync(join(workspacePath, "worker-marker.txt"))).toBe(true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor materializes a committed git repository into the slice workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const repositoryRoot = createCommittedRepo(root);
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    const scriptPath = join(root, "worker-materialized.ts");
    Bun.write(
      scriptPath,
      [
        "const tracked = await Bun.file('tracked.txt').text();",
        "await Bun.write('worker-marker.txt', tracked.trim());",
        "await Bun.write(Bun.stdout, tracked.trim());",
      ].join("\n"),
    );

    await workerRegistry.upsertWorker(createWorker("ember", "local-command", ["bun", scriptPath]));
    const run = await runStore.createRun(createSpec(), await workerRegistry.listWorkers(), {
      sourceRepositoryPath: repositoryRoot,
    });
    const executed = await executor.executeRun(run.id);
    const workspacePath = executed.slices[0]?.workspacePath ?? "";

    expect(executed.status).toBe("completed");
    expect(executed.slices[0]?.lastOutput?.stdout.trim()).toBe("from-source-repo");
    expect(readFileSync(join(workspacePath, "worker-marker.txt"), "utf8")).toBe("from-source-repo");
    expect(existsSync(join(workspacePath, ".git"))).toBe(true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor links source dependencies into slice and integration workspaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const repositoryRoot = createCommittedRepo(root);
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    writeFileSync(join(repositoryRoot, ".gitignore"), "node_modules/\n", "utf8");
    Bun.spawnSync({ cmd: ["git", "add", ".gitignore"], cwd: repositoryRoot });
    Bun.spawnSync({ cmd: ["git", "commit", "-m", "Ignore node_modules"], cwd: repositoryRoot });
    mkdirSync(join(repositoryRoot, "node_modules"), { recursive: true });
    writeFileSync(join(repositoryRoot, "node_modules", ".keep"), "dependency-ok\n", "utf8");
    const scriptPath = join(root, "worker-dependency.ts");
    writeFileSync(
      scriptPath,
      [
        "const manifest = await Bun.file('.quest/workspace-manifest.md').text();",
        "const linked = await Bun.file('node_modules/.keep').text();",
        "await Bun.write('tracked.txt', linked);",
        "await Bun.write(Bun.stdout, manifest.includes('Dependencies linked: yes') ? 'linked' : 'missing-manifest');",
      ].join("\n"),
      "utf8",
    );

    await workerRegistry.upsertWorker(createWorker("ember", "local-command", ["bun", scriptPath]));
    const run = await runStore.createRun(
      {
        ...createSpec(),
        acceptanceChecks: [
          createCommand([
            "bun",
            "-e",
            "process.exit((await Bun.file('node_modules/.keep').text()) === 'dependency-ok\\n' ? 0 : 9)",
          ]),
        ],
      },
      await workerRegistry.listWorkers(),
      { sourceRepositoryPath: repositoryRoot },
    );

    const executed = await executor.executeRun(run.id);

    expect(executed.status).toBe("completed");
    expect(executed.slices[0]?.lastOutput?.stdout).toContain("linked");
    expect(readFileSync(join(executed.slices[0]?.workspacePath ?? "", "tracked.txt"), "utf8")).toBe(
      "dependency-ok\n",
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor runs workspace preparation commands before builder and slice checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    const scriptPath = join(root, "worker-prep.ts");
    writeFileSync(
      scriptPath,
      [
        "const prepared = await Bun.file('prep-marker.txt').text();",
        "await Bun.write(Bun.stdout, prepared.trim());",
      ].join("\n"),
      "utf8",
    );

    await workerRegistry.upsertWorker(createWorker("ember", "local-command", ["bun", scriptPath]));
    const baseSpec = createSpec();
    const parserSlice = baseSpec.slices[0];
    if (!parserSlice) {
      throw new Error("expected default parser slice");
    }
    const run = await runStore.createRun(
      {
        ...baseSpec,
        execution: {
          preInstall: false,
          prepareCommands: [createCommand(["sh", "-lc", "printf 'prepared\\n' > prep-marker.txt"])],
          shareSourceDependencies: true,
          testerSelectionStrategy: "balanced",
          timeoutMinutes: 20,
        },
        slices: [
          {
            ...parserSlice,
            acceptanceChecks: [
              createCommand([
                "bun",
                "-e",
                "process.exit((await Bun.file('prep-marker.txt').text()) === 'prepared\\n' ? 0 : 13)",
              ]),
            ],
          },
        ],
      },
      await workerRegistry.listWorkers(),
    );

    const executed = await executor.executeRun(run.id);
    expect(executed.status).toBe("completed");
    expect(executed.slices[0]?.lastOutput?.stdout.trim()).toBe("prepared");
    expect(executed.slices[0]?.lastChecks?.[0]?.exitCode).toBe(0);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor rejects workspace preparation commands that mutate tracked source files", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const repositoryRoot = createCommittedRepo(root);
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    await workerRegistry.upsertWorker(createWorker("ember"));
    const run = await runStore.createRun(
      createSpec({
        execution: {
          preInstall: false,
          prepareCommands: [createCommand(["sh", "-lc", "printf 'dirty\\n' > tracked.txt"])],
          shareSourceDependencies: true,
          testerSelectionStrategy: "balanced",
          timeoutMinutes: 20,
        },
      }),
      await workerRegistry.listWorkers(),
      { sourceRepositoryPath: repositoryRoot },
    );

    await expect(executor.executeRun(run.id, { dryRun: true })).rejects.toMatchObject({
      code: "quest_workspace_prepare_failed",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor fails when the source repository is dirty", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const repositoryRoot = createCommittedRepo(root);
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    writeFileSync(join(repositoryRoot, "tracked.txt"), "dirty\n", "utf8");
    await workerRegistry.upsertWorker(createWorker("ember"));
    const run = await runStore.createRun(createSpec(), await workerRegistry.listWorkers(), {
      sourceRepositoryPath: repositoryRoot,
    });

    try {
      await executor.executeRun(run.id, { dryRun: true });
      throw new Error("Expected quest_source_repo_dirty");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_source_repo_dirty");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor preserves aborted status when a live run is cancelled", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    const scriptPath = join(root, "worker-sleep.ts");
    writeFileSync(scriptPath, "await Bun.sleep(30_000);\n", "utf8");
    await workerRegistry.upsertWorker(createWorker("ember", "local-command", ["bun", scriptPath]));
    const run = await runStore.createRun(createSpec(), await workerRegistry.listWorkers());

    const executePromise = executor.executeRun(run.id).catch((error) => error);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const current = await runStore.getRun(run.id);
      if (current.activeProcesses.length > 0) {
        break;
      }
      await Bun.sleep(100);
    }

    await runStore.cancelRun(run.id);
    const executionError = await executePromise;
    expect(executionError).toBeDefined();

    const abortedRun = await runStore.getRun(run.id);
    expect(abortedRun.status).toBe("aborted");
    expect(abortedRun.activeProcesses).toHaveLength(0);
    expect(abortedRun.events.some((event) => event.type === "run_cancel_requested")).toBe(true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor records failure for a failing local-command adapter", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    const scriptPath = join(root, "worker-fail.ts");
    Bun.write(scriptPath, ["await Bun.write(Bun.stderr, 'boom');", "process.exit(2);"].join("\n"));

    await workerRegistry.upsertWorker(createWorker("ember", "local-command", ["bun", scriptPath]));
    const spec: QuestSpec = {
      acceptanceChecks: [],
      execution: {
        preInstall: false,
        shareSourceDependencies: true,
        testerSelectionStrategy: "balanced",
        timeoutMinutes: 20,
      },
      featureDoc: { enabled: false },
      hotspots: [],
      maxParallel: 1,
      slices: [
        {
          acceptanceChecks: [],
          contextHints: [],
          dependsOn: [],
          discipline: "coding",
          goal: "Implement parser changes",
          id: "parser",
          owns: ["src/security/url.ts"],
          title: "Parser",
        },
      ],
      title: "Local command failure",
      version: 1,
      workspace: "command-center",
    };

    const run = await runStore.createRun(spec, await workerRegistry.listWorkers());

    try {
      await executor.executeRun(run.id);
      throw new Error("Expected quest_command_failed");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_command_failed");
    }

    const failedRun = await runStore.getRun(run.id);
    expect(failedRun.status).toBe("failed");
    expect(failedRun.slices[0]?.status).toBe("failed");
    expect(failedRun.slices[0]?.lastError).toContain("exit code 2");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor persists passing acceptance checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    const scriptPath = join(root, "worker-success.ts");
    Bun.write(
      scriptPath,
      [
        "const input = JSON.parse(await Bun.stdin.text());",
        "await Bun.write(Bun.stdout, 'completed:' + input.slice.id + ':' + input.worker.id);",
      ].join("\n"),
    );

    await workerRegistry.upsertWorker(createWorker("ember", "local-command", ["bun", scriptPath]));
    const spec: QuestSpec = {
      acceptanceChecks: [],
      execution: {
        preInstall: false,
        shareSourceDependencies: true,
        testerSelectionStrategy: "balanced",
        timeoutMinutes: 20,
      },
      featureDoc: { enabled: false },
      hotspots: [],
      maxParallel: 1,
      slices: [
        {
          acceptanceChecks: [createCommand(["bun", "-e", "console.log('ok')"])],
          contextHints: [],
          dependsOn: [],
          discipline: "coding",
          goal: "Implement parser changes",
          id: "parser",
          owns: ["src/security/url.ts"],
          title: "Parser",
        },
      ],
      title: "Checks pass",
      version: 1,
      workspace: "command-center",
    };

    const run = await runStore.createRun(spec, await workerRegistry.listWorkers());
    const executed = await executor.executeRun(run.id);
    expect(executed.status).toBe("completed");
    expect(executed.slices[0]?.lastChecks?.[0]?.exitCode).toBe(0);
    expect(executed.events.some((event) => event.type === "slice_testing_completed")).toBe(true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor fails when acceptance checks fail", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    const scriptPath = join(root, "worker-success.ts");
    Bun.write(
      scriptPath,
      [
        "const input = JSON.parse(await Bun.stdin.text());",
        "await Bun.write(Bun.stdout, 'completed:' + input.slice.id + ':' + input.worker.id);",
      ].join("\n"),
    );

    await workerRegistry.upsertWorker(createWorker("ember", "local-command", ["bun", scriptPath]));
    const spec: QuestSpec = {
      acceptanceChecks: [],
      execution: {
        preInstall: false,
        shareSourceDependencies: true,
        testerSelectionStrategy: "balanced",
        timeoutMinutes: 20,
      },
      featureDoc: { enabled: false },
      hotspots: [],
      maxParallel: 1,
      slices: [
        {
          acceptanceChecks: [createCommand(["bun", "-e", "process.exit(3)"])],
          contextHints: [],
          dependsOn: [],
          discipline: "coding",
          goal: "Implement parser changes",
          id: "parser",
          owns: ["src/security/url.ts"],
          title: "Parser",
        },
      ],
      title: "Checks fail",
      version: 1,
      workspace: "command-center",
    };

    const run = await runStore.createRun(spec, await workerRegistry.listWorkers());
    try {
      await executor.executeRun(run.id);
      throw new Error("Expected quest_acceptance_check_failed");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_acceptance_check_failed");
    }

    const failedRun = await runStore.getRun(run.id);
    expect(failedRun.status).toBe("failed");
    expect(failedRun.slices[0]?.status).toBe("failed");
    expect(failedRun.slices[0]?.lastChecks?.[0]?.exitCode).toBe(3);
    expect(failedRun.slices[0]?.lastOutput?.stdout).toBe("completed:parser:ember");
    expect(failedRun.slices[0]?.lastOutput?.summary).toContain("Acceptance check failed");
    expect(failedRun.slices[0]?.lastOutput?.summary).toContain("completed:parser:ember");
    expect(failedRun.slices.some((slice) => slice.status === "testing")).toBe(false);
    expect(failedRun.events.some((event) => event.type === "slice_testing_failed")).toBe(true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor filters ambient env for workers but preserves explicit worker env", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const previousSecret = Bun.env.QUEST_SECRET_TEST;

  try {
    Bun.env.QUEST_SECRET_TEST = "top-secret";
    const scriptPath = join(root, "worker-env.ts");
    Bun.write(
      scriptPath,
      [
        "const inherited = process.env.QUEST_SECRET_TEST ?? 'missing';",
        "const explicit = process.env.WORKER_FLAG ?? 'missing';",
        "await Bun.write(Bun.stdout, inherited + ':' + explicit);",
      ].join("\n"),
    );

    const workerWithEnv = createWorker("ember", "local-command", ["bun", scriptPath]);
    workerWithEnv.backend.env = { WORKER_FLAG: "enabled" };
    await workerRegistry.upsertWorker(workerWithEnv);
    const run = await runStore.createRun(createSpec(), await workerRegistry.listWorkers());
    const executed = await executor.executeRun(run.id);

    expect(executed.slices[0]?.lastOutput?.stdout).toBe("missing:enabled");
  } finally {
    if (previousSecret === undefined) {
      delete Bun.env.QUEST_SECRET_TEST;
    } else {
      Bun.env.QUEST_SECRET_TEST = previousSecret;
    }
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor passes explicit env into acceptance checks without leaking ambient env", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const previousSecret = Bun.env.QUEST_SECRET_TEST;

  try {
    Bun.env.QUEST_SECRET_TEST = "top-secret";
    const scriptPath = join(root, "worker-success.ts");
    Bun.write(
      scriptPath,
      [
        "const input = JSON.parse(await Bun.stdin.text());",
        "await Bun.write(Bun.stdout, 'completed:' + input.slice.id + ':' + input.worker.id);",
      ].join("\n"),
    );

    await workerRegistry.upsertWorker(createWorker("ember", "local-command", ["bun", scriptPath]));
    const spec: QuestSpec = {
      acceptanceChecks: [],
      execution: {
        preInstall: false,
        shareSourceDependencies: true,
        testerSelectionStrategy: "balanced",
        timeoutMinutes: 20,
      },
      featureDoc: { enabled: false },
      hotspots: [],
      maxParallel: 1,
      slices: [
        {
          acceptanceChecks: [
            createCommand(
              [
                "bun",
                "-e",
                "process.exit(process.env.CHECK_FLAG === 'yes' && process.env.QUEST_SECRET_TEST === undefined ? 0 : 6)",
              ],
              { CHECK_FLAG: "yes" },
            ),
          ],
          contextHints: [],
          dependsOn: [],
          discipline: "coding",
          goal: "Implement parser changes",
          id: "parser",
          owns: ["src/security/url.ts"],
          title: "Parser",
        },
      ],
      title: "Checks env pass",
      version: 1,
      workspace: "command-center",
    };

    const run = await runStore.createRun(spec, await workerRegistry.listWorkers());
    const executed = await executor.executeRun(run.id);

    expect(executed.status).toBe("completed");
    expect(executed.slices[0]?.lastChecks?.[0]?.exitCode).toBe(0);
  } finally {
    if (previousSecret === undefined) {
      delete Bun.env.QUEST_SECRET_TEST;
    } else {
      Bun.env.QUEST_SECRET_TEST = previousSecret;
    }
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor completes a planned run with the codex-cli adapter", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    const scriptPath = join(root, "fake-codex");
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bun",
        "const args = process.argv.slice(2);",
        "if (args[0] === 'login' && args[1] === 'status') {",
        "  await Bun.write(Bun.stdout, 'Logged in using ChatGPT');",
        "  process.exit(0);",
        "}",
        "if (args.includes('-a')) {",
        "  await Bun.write(Bun.stderr, 'unexpected approval flag');",
        "  process.exit(1);",
        "}",
        "const outputIndex = args.indexOf('--output-last-message');",
        "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;",
        "await Bun.write('codex-args.txt', JSON.stringify(args, null, 2));",
        "const prompt = await Bun.stdin.text();",
        "await Bun.write('codex-marker.txt', prompt.includes('Owned paths:') ? 'ok' : 'bad');",
        "await Bun.write('codex-prompt.txt', prompt);",
        "if (outputPath) await Bun.write(outputPath, 'codex summary from fake cli');",
        "await Bun.write(Bun.stdout, 'fake-codex-stdout');",
      ].join("\n"),
      "utf8",
    );
    Bun.spawnSync({ cmd: ["chmod", "+x", scriptPath], cwd: root });

    await workerRegistry.upsertWorker(
      createWorker("ember", "codex-cli", undefined, {
        executable: scriptPath,
        profile: "gpt-5.4",
        runtime: {
          contextWindow: 272000,
          maxOutputTokens: 64000,
          providerOptions: {
            model_provider: '"responses"',
          },
          reasoningEffort: "high",
          temperature: 0.2,
          topP: 0.95,
        },
      }),
    );

    const baseSpec = createSpec();
    const [parserSlice, docsSlice] = baseSpec.slices;
    if (!parserSlice || !docsSlice) {
      throw new Error("expected default spec slices");
    }

    const run = await runStore.createRun(
      {
        ...baseSpec,
        slices: [
          {
            ...parserSlice,
            acceptanceChecks: [createCommand(["node", "--test"])],
          },
          docsSlice,
        ],
        acceptanceChecks: [createCommand(["grep", "-q", "top-secret-value", "note.txt"])],
      },
      await workerRegistry.listWorkers(),
    );
    const executed = await executor.executeRun(run.id);
    const workspacePath = executed.slices[0]?.workspacePath ?? "";
    const prompt = readFileSync(join(workspacePath, "codex-prompt.txt"), "utf8");
    const codexArgs = JSON.parse(
      readFileSync(join(workspacePath, "codex-args.txt"), "utf8"),
    ) as string[];

    expect(executed.status).toBe("completed");
    expect(executed.slices[0]?.lastOutput?.summary).toBe("codex summary from fake cli");
    expect(readFileSync(join(workspacePath, "codex-marker.txt"), "utf8")).toBe("ok");
    expect(prompt).toContain("node --test");
    expect(prompt).toContain("Global acceptance checks before integration:");
    expect(prompt).toContain("grep (3 arg(s) redacted)");
    expect(prompt).not.toContain("top-secret-value");
    expect(codexArgs).toContain("-c");
    expect(codexArgs).toContain('model_reasoning_effort="high"');
    expect(codexArgs).toContain("model_context_window=272000");
    expect(codexArgs).toContain("model_max_output_tokens=64000");
    expect(codexArgs).toContain("model_temperature=0.2");
    expect(codexArgs).toContain("model_top_p=0.95");
    expect(codexArgs).toContain('model_provider="responses"');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor truncates oversized codex summaries before persisting run state", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    const scriptPath = join(root, "fake-codex");
    const longSummary = "x".repeat(900);
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bun",
        "const args = process.argv.slice(2);",
        "if (args.length === 1 && args[0] === '--version') {",
        "  await Bun.write(Bun.stdout, 'codex 0.0.0-test');",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'login' && args[1] === 'status') {",
        "  await Bun.write(Bun.stdout, 'logged in');",
        "  process.exit(0);",
        "}",
        "const outputIndex = args.indexOf('--output-last-message');",
        "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;",
        `if (outputPath) await Bun.write(outputPath, '${longSummary}');`,
        "await Bun.write(Bun.stdout, 'fake-codex-stdout');",
      ].join("\n"),
      "utf8",
    );
    Bun.spawnSync({ cmd: ["chmod", "+x", scriptPath], cwd: root });

    await workerRegistry.upsertWorker(
      createWorker("ember", "codex-cli", undefined, {
        executable: scriptPath,
        profile: "gpt-5.4",
      }),
    );

    const run = await runStore.createRun(createSpec(), await workerRegistry.listWorkers());
    const executed = await executor.executeRun(run.id);
    const summary = executed.slices[0]?.lastOutput?.summary ?? "";

    expect(executed.status).toBe("completed");
    expect(summary.length).toBeLessThanOrEqual(400);
    expect(summary.endsWith("...")).toBe(true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor completes a planned run with the hermes-api adapter", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  const server = await startTestServer({
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown> & {
        messages: Array<{ content: string }>;
      };
      expect(body.messages[1]?.content).toContain("Current owned file snapshots");
      expect(body.max_tokens).toBe(4096);
      expect(body.temperature).toBe(0.3);
      expect(body.top_p).toBe(0.8);
      expect(body.reasoning_effort).toBe("medium");
      expect(body.frequency_penalty).toBe(0.5);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  files: [
                    {
                      content:
                        "export function sum(a: number, b: number): number {\n  return a + b;\n}\n",
                      path: "sum.ts",
                    },
                  ],
                  summary: "Hermes updated sum.ts",
                }),
              },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  if (!server) {
    return;
  }

  try {
    await workerRegistry.upsertWorker(
      createWorker("ember", "hermes-api", undefined, {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        profile: "hermes-local",
        runner: "hermes",
        runtime: {
          maxOutputTokens: 4096,
          providerOptions: {
            frequency_penalty: "0.5",
          },
          reasoningEffort: "medium",
          temperature: 0.3,
          topP: 0.8,
        },
      }),
    );
    const repositoryRoot = createCommittedRepo(root);
    writeFileSync(
      join(repositoryRoot, "sum.ts"),
      "export function sum(a: number, b: number): number {\n  return a + b + 1;\n}\n",
      "utf8",
    );
    Bun.spawnSync({ cmd: ["git", "add", "sum.ts"], cwd: repositoryRoot });
    Bun.spawnSync({ cmd: ["git", "commit", "-m", "Add sum.ts"], cwd: repositoryRoot });

    const spec: QuestSpec = {
      acceptanceChecks: [],
      execution: {
        preInstall: false,
        shareSourceDependencies: true,
        testerSelectionStrategy: "balanced",
        timeoutMinutes: 20,
      },
      featureDoc: { enabled: false },
      hotspots: [],
      maxParallel: 1,
      slices: [
        {
          acceptanceChecks: [],
          contextHints: [],
          dependsOn: [],
          discipline: "coding",
          goal: "Fix sum",
          id: "fix-sum",
          owns: ["sum.ts"],
          title: "Fix sum",
        },
      ],
      title: "Hermes run",
      version: 1,
      workspace: "command-center",
    };

    const run = await runStore.createRun(spec, await workerRegistry.listWorkers(), {
      sourceRepositoryPath: repositoryRoot,
    });
    const executed = await executor.executeRun(run.id);
    const workspacePath = executed.slices[0]?.workspacePath ?? "";

    expect(executed.status).toBe("completed");
    expect(executed.slices[0]?.lastOutput?.summary).toBe("Hermes updated sum.ts");
    expect(readFileSync(join(workspacePath, "sum.ts"), "utf8")).toContain("return a + b;");
  } finally {
    server.stop(true);
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor surfaces ACP initialize failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const scriptPath = join(root, "fake-acp-agent.mjs");

  try {
    writeFileSync(
      scriptPath,
      [
        "import readline from 'node:readline';",
        "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
        "rl.on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') {",
        "    process.stdout.write(JSON.stringify({",
        "      jsonrpc: '2.0',",
        "      id: message.id,",
        "      error: { code: -32000, message: 'init failed' }",
        "    }) + '\\n');",
        "    return;",
        "  }",
        "  if (message.method === 'session/close') {",
        "    process.exit(0);",
        "  }",
        "});",
      ].join("\n"),
      "utf8",
    );

    await workerRegistry.upsertWorker(
      createWorker("ember", "acp", undefined, {
        executable: `node ${scriptPath}`,
        profile: "acp-test",
        runner: "custom",
      }),
    );

    const run = await runStore.createRun(
      {
        acceptanceChecks: [],
        execution: {
          preInstall: false,
          shareSourceDependencies: true,
          testerSelectionStrategy: "balanced",
          timeoutMinutes: 20,
        },
        featureDoc: { enabled: false },
        hotspots: [],
        maxParallel: 1,
        slices: [
          {
            acceptanceChecks: [],
            contextHints: [],
            dependsOn: [],
            discipline: "coding",
            goal: "Do ACP work",
            id: "acp-init-failure",
            owns: ["tracked.txt"],
            title: "ACP init failure",
          },
        ],
        title: "ACP init failure",
        version: 1,
        workspace: "command-center",
      },
      await workerRegistry.listWorkers(),
    );

    await expect(executor.executeRun(run.id)).rejects.toMatchObject({
      code: "quest_unavailable",
      message: "ACP initialize failed for ember: init failed",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor rejects Hermes writes through symlinked owned paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);
  const externalRoot = join(root, "external-write-target");
  mkdirSync(externalRoot, { recursive: true });

  const server = await startTestServer({
    fetch: async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  files: [
                    {
                      content: "escaped\n",
                      path: "linked-owned/pwned.txt",
                    },
                  ],
                  summary: "Hermes attempted an escape",
                }),
              },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  if (!server) {
    return;
  }

  try {
    await workerRegistry.upsertWorker(
      createWorker("ember", "hermes-api", undefined, {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        profile: "hermes-local",
        runner: "hermes",
      }),
    );
    const repositoryRoot = createCommittedRepo(root);
    symlinkSync(externalRoot, join(repositoryRoot, "linked-owned"));
    Bun.spawnSync({ cmd: ["git", "add", "linked-owned"], cwd: repositoryRoot });
    Bun.spawnSync({ cmd: ["git", "commit", "-m", "Add linked owned path"], cwd: repositoryRoot });

    const run = await runStore.createRun(
      createSpec({
        slices: [
          {
            acceptanceChecks: [],
            contextHints: [],
            dependsOn: [],
            discipline: "coding",
            goal: "Update the linked file",
            id: "fix-symlink",
            owns: ["linked-owned/**"],
            preferredRunner: "hermes",
            title: "Fix symlink",
          },
        ],
        title: "Hermes symlink run",
      }),
      await workerRegistry.listWorkers(),
      {
        sourceRepositoryPath: repositoryRoot,
      },
    );

    await expect(executor.executeRun(run.id)).rejects.toMatchObject({
      code: "quest_command_failed",
    });
    expect(existsSync(join(externalRoot, "pwned.txt"))).toBe(false);
  } finally {
    server.stop(true);
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor rejects Hermes writes that traverse outside owned paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  const server = await startTestServer({
    fetch: async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  files: [
                    {
                      content: "escaped\n",
                      path: "owned/../unowned/pwned.txt",
                    },
                  ],
                  summary: "Hermes attempted traversal",
                }),
              },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  if (!server) {
    return;
  }

  try {
    await workerRegistry.upsertWorker(
      createWorker("ember", "hermes-api", undefined, {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        profile: "hermes-local",
        runner: "hermes",
      }),
    );
    const repositoryRoot = createCommittedRepo(root);
    mkdirSync(join(repositoryRoot, "owned"), { recursive: true });
    writeFileSync(join(repositoryRoot, "owned", "seed.txt"), "seed\n", "utf8");
    Bun.spawnSync({ cmd: ["git", "add", "owned/seed.txt"], cwd: repositoryRoot });
    Bun.spawnSync({ cmd: ["git", "commit", "-m", "Add owned seed"], cwd: repositoryRoot });

    const run = await runStore.createRun(
      createSpec({
        slices: [
          {
            acceptanceChecks: [],
            contextHints: [],
            dependsOn: [],
            discipline: "coding",
            goal: "Update owned file",
            id: "fix-owned",
            owns: ["owned/**"],
            preferredRunner: "hermes",
            title: "Fix owned file",
          },
        ],
        title: "Hermes traversal run",
      }),
      await workerRegistry.listWorkers(),
      {
        sourceRepositoryPath: repositoryRoot,
      },
    );

    await expect(executor.executeRun(run.id)).rejects.toMatchObject({
      code: "quest_command_failed",
      message: "Hermes produced an invalid write path: owned/../unowned/pwned.txt",
    });
    const unownedPath = join(
      resolveRunWorkspaceRootPath(join(root, "workspaces"), run.id),
      "slices",
      "fix-owned",
      "unowned",
      "pwned.txt",
    );
    expect(existsSync(unownedPath)).toBe(false);
  } finally {
    server.stop(true);
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor completes a planned run with the openclaw-cli adapter", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry, new SecretStore());

  try {
    const capturedArgsPath = join(root, "openclaw-args.txt");
    const openClawExecutable = createOpenClawMockExecutable(root, {
      captureArgsPath: capturedArgsPath,
      jsonToStderr: true,
      noisyAgent: true,
      writeFile: {
        content: "export const status = 'openclaw-fixed';\n",
        path: "status.ts",
      },
    });

    await workerRegistry.upsertWorker(
      createWorker("ember", "openclaw-cli", undefined, {
        agentId: "main",
        executable: openClawExecutable,
        profile: "openclaw/main",
        runner: "openclaw",
        runtime: {
          providerOptions: {
            timeout_seconds: "90",
            verbose: "on",
          },
          reasoningEffort: "medium",
        },
      }),
    );
    const repositoryRoot = createCommittedRepo(root);
    writeFileSync(join(repositoryRoot, "status.ts"), "export const status = 'stale';\n", "utf8");
    Bun.spawnSync({ cmd: ["git", "add", "status.ts"], cwd: repositoryRoot });
    Bun.spawnSync({ cmd: ["git", "commit", "-m", "Add status.ts"], cwd: repositoryRoot });

    const spec: QuestSpec = {
      acceptanceChecks: [],
      execution: {
        preInstall: false,
        shareSourceDependencies: true,
        testerSelectionStrategy: "balanced",
        timeoutMinutes: 20,
      },
      featureDoc: { enabled: false },
      hotspots: [],
      maxParallel: 1,
      slices: [
        {
          acceptanceChecks: [],
          contextHints: [],
          dependsOn: [],
          discipline: "coding",
          goal: "Fix status export",
          id: "fix-status",
          owns: ["status.ts"],
          preferredRunner: "openclaw",
          title: "Fix status",
        },
      ],
      title: "OpenClaw run",
      version: 1,
      workspace: "command-center",
    };

    const run = await runStore.createRun(spec, await workerRegistry.listWorkers(), {
      sourceRepositoryPath: repositoryRoot,
    });
    const executed = await executor.executeRun(run.id);
    const workspacePath = executed.slices[0]?.workspacePath ?? "";

    expect(executed.status).toBe("completed");
    expect(executed.slices[0]?.lastOutput?.summary).toBe("OpenClaw updated the workspace");
    const capturedArgs = readFileSync(capturedArgsPath, "utf8");
    expect(capturedArgs).toContain("--session-id");
    expect(capturedArgs).toContain(`quest-${run.id}-fix-status-build`);
    expect(capturedArgs).toContain(`--agent quest-${run.id}-fix-status-build`);
    expect(capturedArgs).toContain("--thinking medium");
    expect(capturedArgs).toContain("--timeout 90");
    expect(capturedArgs).toContain("--verbose on");
    expect(readFileSync(join(workspacePath, "status.ts"), "utf8")).toContain("openclaw-fixed");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor fails openclaw-cli runs when payload reports an API error", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry, new SecretStore());

  try {
    const openClawExecutable = createOpenClawMockExecutable(root, {
      payloadText:
        "HTTP 500 api_error: your current token plan not support model, MiniMax-M2.7-highspeed (2061)",
    });

    await workerRegistry.upsertWorker(
      createWorker("minimax", "openclaw-cli", undefined, {
        agentId: "main",
        executable: openClawExecutable,
        profile: "minimax/MiniMax-M2.7-highspeed",
        runner: "openclaw",
      }),
    );

    const spec: QuestSpec = {
      acceptanceChecks: [],
      execution: {
        preInstall: false,
        shareSourceDependencies: true,
        testerSelectionStrategy: "balanced",
        timeoutMinutes: 20,
      },
      featureDoc: { enabled: false },
      hotspots: [],
      maxParallel: 1,
      slices: [
        {
          acceptanceChecks: [],
          contextHints: [],
          dependsOn: [],
          discipline: "coding",
          goal: "Validate MiniMax payload error handling",
          id: "minimax-error",
          owns: ["status.ts"],
          preferredRunner: "openclaw",
          title: "MiniMax error",
        },
      ],
      title: "OpenClaw API error",
      version: 1,
      workspace: "command-center",
    };

    const run = await runStore.createRun(spec, await workerRegistry.listWorkers());

    try {
      await executor.executeRun(run.id);
      throw new Error("Expected quest_command_failed");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_command_failed");
      expect((error as QuestDomainError).message).toContain("MiniMax-M2.7-highspeed");
    }

    const failedRun = await runStore.getRun(run.id);
    expect(failedRun.status).toBe("failed");
    expect(failedRun.slices[0]?.status).toBe("failed");
    expect(failedRun.slices[0]?.lastError).toContain("MiniMax-M2.7-highspeed");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor resolves secret-store auth for codex-cli workers", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const secretStore = new SecretStore({
    platform: "darwin",
    runCommand: async ({ cmd }) => ({
      aborted: false,
      exitCode: 0,
      stderr: "",
      stderrTruncated: false,
      stdout: cmd.includes("-w") ? "example-secret-value\n" : "",
      stdoutTruncated: false,
      timedOut: false,
    }),
    serviceName: "quest-tests",
  });
  const executor = new QuestRunExecutor(runStore, workerRegistry, secretStore);

  try {
    const scriptPath = join(root, "fake-codex");
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bun",
        "const args = process.argv.slice(2);",
        "if (args[0] === 'login' && args[1] === 'status') {",
        "  await Bun.write(Bun.stdout, 'Logged in using ChatGPT');",
        "  process.exit(0);",
        "}",
        "const outputIndex = args.indexOf('--output-last-message');",
        "const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;",
        "await Bun.write(Bun.stdout, process.env.OPENAI_API_KEY ?? 'missing');",
        "if (outputPath) await Bun.write(outputPath, 'codex secret summary');",
      ].join("\n"),
      "utf8",
    );
    Bun.spawnSync({ cmd: ["chmod", "+x", scriptPath], cwd: root });

    await workerRegistry.upsertWorker(
      createWorker("ember", "codex-cli", undefined, {
        auth: {
          mode: "secret-store",
          secretRef: "codex.api",
          targetEnvVar: "OPENAI_API_KEY",
        },
        executable: scriptPath,
        profile: "gpt-5.4",
      }),
    );

    const run = await runStore.createRun(createSpec(), await workerRegistry.listWorkers());
    const executed = await executor.executeRun(run.id);

    expect(executed.slices[0]?.lastOutput?.stdout).toBe("example-secret-value");
    expect(executed.slices[0]?.lastOutput?.summary).toBe("codex secret summary");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor fails codex-cli workers when env-var auth is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    delete Bun.env.CODEX_API_KEY_FOR_TESTS;
    await workerRegistry.upsertWorker(
      createWorker("ember", "codex-cli", undefined, {
        auth: {
          envVar: "CODEX_API_KEY_FOR_TESTS",
          mode: "env-var",
          targetEnvVar: "OPENAI_API_KEY",
        },
        executable: "/bin/echo",
        profile: "gpt-5.4",
      }),
    );

    const run = await runStore.createRun(createSpec(), await workerRegistry.listWorkers());

    try {
      await executor.executeRun(run.id);
      throw new Error("Expected quest_unavailable");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_unavailable");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor fails codex-cli workers when native login status is unavailable", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    const scriptPath = join(root, "fake-codex-login-fail");
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bun",
        "const args = process.argv.slice(2);",
        "if (args[0] === 'login' && args[1] === 'status') {",
        "  await Bun.write(Bun.stderr, 'not logged in');",
        "  process.exit(1);",
        "}",
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );
    Bun.spawnSync({ cmd: ["chmod", "+x", scriptPath], cwd: root });

    await workerRegistry.upsertWorker(
      createWorker("ember", "codex-cli", undefined, {
        executable: scriptPath,
        profile: "gpt-5.4",
      }),
    );

    const run = await runStore.createRun(createSpec(), await workerRegistry.listWorkers());

    try {
      await executor.executeRun(run.id);
      throw new Error("Expected quest_unavailable");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_unavailable");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor refuses blocked runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    await workerRegistry.upsertWorker(createWorker("ember"));
    const blockedSpec: QuestSpec = {
      ...createSpec(),
      slices: [
        {
          acceptanceChecks: [],
          contextHints: [],
          dependsOn: [],
          discipline: "coding",
          goal: "Implement parser changes",
          id: "parser",
          owns: ["src/security/url.ts"],
          preferredRunner: "openclaw",
          title: "Parser",
        },
      ],
    };

    const run = await runStore.createRun(blockedSpec, await workerRegistry.listWorkers());
    expect(run.status).toBe("blocked");

    try {
      await executor.executeRun(run.id, { dryRun: true });
      throw new Error("Expected quest_run_not_executable");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_run_not_executable");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor fails explicitly when no adapter is available", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    await workerRegistry.upsertWorker(createWorker("ember", "local-cli"));
    const run = await runStore.createRun(createSpec(), await workerRegistry.listWorkers());

    try {
      await executor.executeRun(run.id);
      throw new Error("Expected quest_unavailable");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_unavailable");
    }

    const failedRun = await runStore.getRun(run.id);
    expect(failedRun.status).toBe("failed");
    expect(failedRun.events.some((event) => event.type === "run_failed")).toBe(true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor refuses to re-execute a failed run", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, join(root, "workspaces"));
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    const scriptPath = join(root, "worker-fail.ts");
    Bun.write(scriptPath, ["await Bun.write(Bun.stderr, 'boom');", "process.exit(2);"].join("\n"));

    await workerRegistry.upsertWorker(createWorker("ember", "local-command", ["bun", scriptPath]));
    const run = await runStore.createRun(createSpec(), await workerRegistry.listWorkers());

    try {
      await executor.executeRun(run.id);
      throw new Error("Expected quest_command_failed");
    } catch {}

    try {
      await executor.executeRun(run.id);
      throw new Error("Expected quest_run_not_rerunnable");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_run_not_rerunnable");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
