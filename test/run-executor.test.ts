import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QuestDomainError } from "../src/core/errors";
import { QuestRunExecutor } from "../src/core/run-executor";
import { QuestRunStore } from "../src/core/run-store";
import type { QuestSpec } from "../src/core/spec-schema";
import { WorkerRegistry } from "../src/core/worker-registry";
import type { RegisteredWorker } from "../src/core/worker-schema";
import { createCommittedRepo } from "./helpers";

function createWorker(id: string, adapter = "local-cli", command?: string[]): RegisteredWorker {
  return {
    backend: {
      adapter,
      command,
      profile: "gpt-5.4",
      runner: "codex",
      toolPolicy: { allow: [], deny: [] },
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

function createSpec(): QuestSpec {
  return {
    acceptanceChecks: [],
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
      JSON.parse(readFileSync(join(workspacePath, ".quest-runner", "context.json"), "utf8"))
        .sliceId,
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

    expect(workspacePath).toBe(join(root, "workspaces", run.id, "slices", "parser"));
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
      throw new Error("Expected quest_runner_command_failed");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_runner_command_failed");
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
      featureDoc: { enabled: false },
      hotspots: [],
      maxParallel: 1,
      slices: [
        {
          acceptanceChecks: ["bun -e \"console.log('ok')\""],
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
      featureDoc: { enabled: false },
      hotspots: [],
      maxParallel: 1,
      slices: [
        {
          acceptanceChecks: ['bun -e "process.exit(3)"'],
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
    expect(failedRun.events.some((event) => event.type === "slice_testing_failed")).toBe(true);
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
      throw new Error("Expected quest_runner_unavailable");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_runner_unavailable");
    }

    const failedRun = await runStore.getRun(run.id);
    expect(failedRun.status).toBe("failed");
    expect(failedRun.events.some((event) => event.type === "run_failed")).toBe(true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
