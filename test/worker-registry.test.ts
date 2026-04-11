import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { expect, test } from "bun:test";

import { QuestDomainError } from "../src/core/errors";
import { WorkerRegistry } from "../src/core/worker-registry";
import type { RegisteredWorker } from "../src/core/worker-schema";

function createWorker(id: string): RegisteredWorker {
  return {
    backend: {
      adapter: "local-cli",
      profile: "gpt-5.4",
      runner: "codex",
      toolPolicy: { allow: ["git", "npm"], deny: [] },
    },
    class: "engineer",
    enabled: true,
    id,
    name: `Worker ${id}`,
    persona: {
      approach: "test-first and explicit",
      prompt: "Keep diffs tight and explain tradeoffs briefly.",
      voice: "terse",
    },
    progression: {
      level: 2,
      xp: 120,
    },
    resources: {
      cpuCost: 2,
      gpuCost: 0,
      maxParallel: 1,
      memoryCost: 2,
    },
    stats: {
      coding: 80,
      contextEndurance: 60,
      docs: 40,
      mergeSafety: 75,
      research: 45,
      speed: 70,
      testing: 65,
    },
    tags: ["typescript"],
    title: "Battle Engineer",
    trust: {
      calibratedAt: "2026-04-10T00:00:00Z",
      rating: 0.72,
    },
  };
}

test("worker registry upserts and lists workers in stable order", async () => {
  const root = mkdtempSync(join(tmpdir(), "grind-worker-registry-"));
  const registryPath = join(root, "workers.json");
  const registry = new WorkerRegistry(registryPath);

  try {
    await registry.upsertWorker(createWorker("ember"));
    await registry.upsertWorker({
      ...createWorker("atlas"),
      name: "Atlas",
    });

    const workers = await registry.listWorkers();
    expect(workers.length).toBe(2);
    expect(
      workers.map((worker) => worker.id),
    ).toEqual(["atlas", "ember"]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("worker registry surfaces invalid JSON as a typed domain error", async () => {
  const root = mkdtempSync(join(tmpdir(), "grind-worker-registry-"));
  const registryPath = join(root, "workers.json");
  const registry = new WorkerRegistry(registryPath);

  try {
    writeFileSync(registryPath, "{not-json", "utf8");

    try {
      await registry.listWorkers();
      throw new Error("Expected invalid_worker_registry");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("invalid_worker_registry");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
