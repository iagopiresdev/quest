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
import type { QuestSpec } from "../src/core/planning/spec-schema";
import { QuestRunExecutor } from "../src/core/runs/executor";
import { QuestRunStore } from "../src/core/runs/store";
import { SecretStore } from "../src/core/secret-store";
import { WorkerRegistry } from "../src/core/workers/registry";
import type { RegisteredWorker } from "../src/core/workers/schema";
import { createCommand, createCommittedRepo } from "./helpers";

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
    expect(failedRun.slices[0]?.lastOutput?.summary).toContain("Acceptance check failed");
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
  const previousSecret = Bun.env.QUEST_RUNNER_SECRET_TEST;

  try {
    Bun.env.QUEST_RUNNER_SECRET_TEST = "top-secret";
    const scriptPath = join(root, "worker-env.ts");
    Bun.write(
      scriptPath,
      [
        "const inherited = process.env.QUEST_RUNNER_SECRET_TEST ?? 'missing';",
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
      delete Bun.env.QUEST_RUNNER_SECRET_TEST;
    } else {
      Bun.env.QUEST_RUNNER_SECRET_TEST = previousSecret;
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
  const previousSecret = Bun.env.QUEST_RUNNER_SECRET_TEST;

  try {
    Bun.env.QUEST_RUNNER_SECRET_TEST = "top-secret";
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
          acceptanceChecks: [
            createCommand(
              [
                "bun",
                "-e",
                "process.exit(process.env.CHECK_FLAG === 'yes' && process.env.QUEST_RUNNER_SECRET_TEST === undefined ? 0 : 6)",
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
      delete Bun.env.QUEST_RUNNER_SECRET_TEST;
    } else {
      Bun.env.QUEST_RUNNER_SECRET_TEST = previousSecret;
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

  const server = Bun.serve({
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
    port: 0,
  });

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
      stdout: cmd.includes("-w") ? "secret-token\n" : "",
      stdoutTruncated: false,
      timedOut: false,
    }),
    serviceName: "quest-runner-tests",
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

    expect(executed.slices[0]?.lastOutput?.stdout).toBe("secret-token");
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
      throw new Error("Expected quest_runner_unavailable");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_runner_unavailable");
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
      throw new Error("Expected quest_runner_unavailable");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_runner_unavailable");
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
      throw new Error("Expected quest_runner_command_failed");
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
