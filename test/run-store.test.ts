import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { expect, test } from "bun:test";

import { QuestDomainError } from "../src/core/errors";
import { QuestRunStore } from "../src/core/run-store";
import type { QuestSpec } from "../src/core/spec-schema";
import type { RegisteredWorker } from "../src/core/worker-schema";

function createWorker(id: string, runner: RegisteredWorker["backend"]["runner"] = "codex"): RegisteredWorker {
  return {
    backend: {
      adapter: "local-cli",
      profile: runner === "hermes" ? "qwen3.5-27b" : "gpt-5.4",
      runner,
      toolPolicy: { allow: [], deny: [] },
    },
    class: runner === "hermes" ? "tester" : "engineer",
    enabled: true,
    id,
    name: id,
    persona: {
      approach: "explicit",
      prompt: "Keep diffs narrow.",
      voice: "terse",
    },
    progression: { level: 1, xp: 0 },
    resources: { cpuCost: 1, gpuCost: runner === "hermes" ? 1 : 0, maxParallel: 1, memoryCost: 1 },
    stats: {
      coding: 80,
      contextEndurance: 60,
      docs: 40,
      mergeSafety: 75,
      research: 50,
      speed: 65,
      testing: runner === "hermes" ? 90 : 55,
    },
    tags: [],
    title: "Worker",
    trust: { calibratedAt: "2026-04-11T00:00:00Z", rating: 0.75 },
  };
}

function createSpec(preferredRunner?: RegisteredWorker["backend"]["runner"]): QuestSpec {
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
        preferredRunner,
        title: "Parser",
      },
    ],
    title: "Quest Run",
    version: 1,
    workspace: "command-center",
  };
}

test("run store creates a planned run and lists it", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const store = new QuestRunStore(root);

  try {
    const run = await store.createRun(createSpec(), [createWorker("ember")]);
    expect(run.status).toBe("planned");
    expect(run.events.length).toBe(1);
    expect(run.events[0]?.type).toBe("run_created");

    const loaded = await store.getRun(run.id);
    expect(loaded.id).toBe(run.id);

    const runs = await store.listRuns();
    expect(runs.length).toBe(1);
    expect(runs[0]?.id).toBe(run.id);
    expect(runs[0]?.waveCount).toBe(1);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run store marks blocked runs when planning leaves slices unassigned", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const store = new QuestRunStore(root);

  try {
    const run = await store.createRun(createSpec("openclaw"), [createWorker("ember", "codex")]);
    expect(run.status).toBe("blocked");
    expect(run.plan.unassigned.length).toBe(1);
    expect(run.events.at(-1)?.type).toBe("run_blocked");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("run store reports missing and invalid run documents as typed errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-run-store-"));
  const store = new QuestRunStore(root);

  try {
    try {
      await store.getRun("quest-00000000-deadbeef");
      throw new Error("Expected quest_run_not_found");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("quest_run_not_found");
    }

    const invalidRunPath = join(root, "quest-00000000-deadbeef.json");
    writeFileSync(invalidRunPath, JSON.stringify({ version: 1, bad: true }), "utf8");

    try {
      await store.getRun("quest-00000000-deadbeef");
      throw new Error("Expected invalid_quest_run");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(QuestDomainError);
      expect((error as QuestDomainError).code).toBe("invalid_quest_run");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
