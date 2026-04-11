import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { QuestDomainError } from "../src/core/errors";
import { QuestRunExecutor } from "../src/core/run-executor";
import { QuestRunStore } from "../src/core/run-store";
import type { QuestSpec } from "../src/core/spec-schema";
import { WorkerRegistry } from "../src/core/worker-registry";
import type { RegisteredWorker } from "../src/core/worker-schema";

function createWorker(id: string, adapter = "local-cli"): RegisteredWorker {
  return {
    backend: {
      adapter,
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
  const runStore = new QuestRunStore(runsRoot);
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    await workerRegistry.upsertWorker(createWorker("ember"));
    await workerRegistry.upsertWorker(createWorker("atlas"));

    const run = await runStore.createRun(createSpec(), await workerRegistry.listWorkers());
    const executed = await executor.executeRun(run.id, { dryRun: true });

    assert.equal(executed.status, "completed");
    assert.equal(
      executed.slices.every((slice) => slice.status === "completed"),
      true,
    );
    assert.equal(executed.events.some((event) => event.type === "run_started"), true);
    assert.equal(executed.events.some((event) => event.type === "run_completed"), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor refuses blocked runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot);
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    await workerRegistry.upsertWorker(createWorker("ember"));
    const blockedSpec: QuestSpec = {
      ...createSpec(),
      slices: [
        {
          ...createSpec().slices[0]!,
          preferredRunner: "openclaw",
        },
      ],
    };

    const run = await runStore.createRun(blockedSpec, await workerRegistry.listWorkers());
    assert.equal(run.status, "blocked");

    await assert.rejects(
      executor.executeRun(run.id, { dryRun: true }),
      (error: unknown) => {
        assert.ok(error instanceof QuestDomainError);
        assert.equal(error.code, "quest_run_not_executable");
        return true;
      },
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run executor fails explicitly when no adapter is available", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-executor-"));
  const registryPath = join(root, "workers.json");
  const runsRoot = join(root, "runs");
  const workerRegistry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot);
  const executor = new QuestRunExecutor(runStore, workerRegistry);

  try {
    await workerRegistry.upsertWorker(createWorker("ember", "local-cli"));
    const run = await runStore.createRun(createSpec(), await workerRegistry.listWorkers());

    await assert.rejects(
      executor.executeRun(run.id),
      (error: unknown) => {
        assert.ok(error instanceof QuestDomainError);
        assert.equal(error.code, "quest_runner_unavailable");
        return true;
      },
    );

    const failedRun = await runStore.getRun(run.id);
    assert.equal(failedRun.status, "failed");
    assert.equal(failedRun.events.some((event) => event.type === "run_failed"), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
