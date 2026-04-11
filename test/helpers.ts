import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { QuestSliceSpec, QuestSpec } from "../src/core/spec-schema";
import type { RegisteredWorker, WorkerRunner } from "../src/core/worker-schema";

export type CliTestContext = {
  stateRoot: string;
};

export function createTempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupTempRoot(root: string): void {
  rmSync(root, { force: true, recursive: true });
}

export function createCliContext(): CliTestContext {
  return { stateRoot: createTempRoot("quest-cli-") };
}

export function createWorker(
  overrides: Partial<RegisteredWorker> = {},
  backendOverrides: Partial<RegisteredWorker["backend"]> = {},
): RegisteredWorker {
  const base: RegisteredWorker = {
    backend: {
      adapter: "local-cli",
      profile: "gpt-5.4",
      runner: "codex",
      toolPolicy: { allow: [], deny: [] },
    },
    class: "engineer",
    enabled: true,
    id: "ember",
    name: "Ember",
    persona: {
      approach: "test-first",
      prompt: "Keep diffs tight and explain tradeoffs briefly.",
      voice: "terse",
    },
    progression: {
      level: 7,
      xp: 1840,
    },
    resources: {
      cpuCost: 2,
      gpuCost: 0,
      maxParallel: 1,
      memoryCost: 3,
    },
    stats: {
      coding: 82,
      contextEndurance: 58,
      docs: 44,
      mergeSafety: 79,
      research: 51,
      speed: 63,
      testing: 77,
    },
    tags: ["typescript"],
    title: "Battle Engineer",
    trust: {
      calibratedAt: "2026-04-10T00:00:00Z",
      rating: 0.74,
    },
  };

  return {
    ...base,
    ...overrides,
    backend: {
      ...base.backend,
      ...overrides.backend,
      ...backendOverrides,
      toolPolicy: {
        ...base.backend.toolPolicy,
        ...overrides.backend?.toolPolicy,
        ...backendOverrides.toolPolicy,
      },
    },
    persona: {
      ...base.persona,
      ...overrides.persona,
    },
    progression: {
      ...base.progression,
      ...overrides.progression,
    },
    resources: {
      ...base.resources,
      ...overrides.resources,
    },
    stats: {
      ...base.stats,
      ...overrides.stats,
    },
    trust: {
      ...base.trust,
      ...overrides.trust,
    },
  };
}

export function createWorkerForRunner(
  id: string,
  runner: WorkerRunner = "codex",
  backendOverrides: Partial<RegisteredWorker["backend"]> = {},
): RegisteredWorker {
  return createWorker(
    {
      class: runner === "hermes" ? "tester" : "engineer",
      id,
      name: id,
      progression: { level: 1, xp: 0 },
      resources: {
        cpuCost: 1,
        gpuCost: runner === "hermes" ? 1 : 0,
        maxParallel: 1,
        memoryCost: 1,
      },
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
      trust: {
        calibratedAt: "2026-04-11T00:00:00Z",
        rating: 0.75,
      },
    },
    {
      adapter: "local-cli",
      profile: runner === "hermes" ? "qwen3.5-27b" : "gpt-5.4",
      runner,
      ...backendOverrides,
    },
  );
}

export function createSlice(overrides: Partial<QuestSliceSpec> = {}): QuestSliceSpec {
  return {
    acceptanceChecks: [],
    contextHints: [],
    dependsOn: [],
    discipline: "coding",
    goal: "Implement parser changes",
    id: "parser",
    owns: ["src/security/url.ts"],
    title: "Parser",
    ...overrides,
  };
}

export function createSpec(
  overrides: Partial<Omit<QuestSpec, "slices">> & { slices?: QuestSliceSpec[] } = {},
): QuestSpec {
  return {
    acceptanceChecks: [],
    featureDoc: { enabled: false },
    hotspots: [],
    maxParallel: 1,
    slices: overrides.slices ?? [createSlice()],
    title: "Quest Run",
    version: 1,
    workspace: "command-center",
    ...overrides,
  };
}
