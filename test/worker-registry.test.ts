import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { expect, test } from "bun:test";

import { QuestDomainError } from "../src/core/errors";
import { WorkerRegistry } from "../src/core/worker-registry";
import { createWorker } from "./helpers";

test("worker registry upserts and lists workers in stable order", async () => {
  const root = mkdtempSync(join(tmpdir(), "grind-worker-registry-"));
  const registryPath = join(root, "workers.json");
  const registry = new WorkerRegistry(registryPath);

  try {
    await registry.upsertWorker(createWorker({ id: "ember", name: "Worker ember" }));
    await registry.upsertWorker({
      ...createWorker({ id: "atlas", name: "Atlas" }),
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
