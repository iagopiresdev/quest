import assert from "node:assert/strict";
import test from "node:test";

import { planQuest } from "../src/core/planner";
import type { QuestSpec } from "../src/core/spec-schema";
import type { RegisteredWorker } from "../src/core/worker-schema";

const workers: RegisteredWorker[] = [
  {
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
      prompt: "Prefer narrow diffs.",
      voice: "terse",
    },
    progression: { level: 4, xp: 480 },
    resources: { cpuCost: 2, gpuCost: 0, maxParallel: 1, memoryCost: 2 },
    stats: {
      coding: 88,
      contextEndurance: 65,
      docs: 40,
      mergeSafety: 82,
      research: 52,
      speed: 70,
      testing: 61,
    },
    tags: ["hotfiles"],
    title: "Battle Engineer",
    trust: { calibratedAt: "2026-04-10T00:00:00Z", rating: 0.82 },
  },
  {
    backend: {
      adapter: "local-cli",
      profile: "qwen3.5-27b",
      runner: "hermes",
      toolPolicy: { allow: [], deny: [] },
    },
    class: "tester",
    enabled: true,
    id: "sable",
    name: "Sable",
    persona: {
      approach: "verification-heavy",
      prompt: "Focus on tests and regressions first.",
      voice: "calm",
    },
    progression: { level: 3, xp: 340 },
    resources: { cpuCost: 1, gpuCost: 1, maxParallel: 1, memoryCost: 2 },
    stats: {
      coding: 50,
      contextEndurance: 48,
      docs: 42,
      mergeSafety: 68,
      research: 44,
      speed: 55,
      testing: 89,
    },
    tags: ["tests"],
    title: "Trial Warden",
    trust: { calibratedAt: "2026-04-10T00:00:00Z", rating: 0.77 },
  },
];

test("planner assigns independent slices into the same wave and respects dependencies", () => {
  const spec: QuestSpec = {
    acceptanceChecks: ["npm test"],
    featureDoc: { enabled: true, outputPath: "docs/features/ssrf-protection.md" },
    hotspots: ["src/orchestration/**"],
    maxParallel: 2,
    slices: [
      {
        acceptanceChecks: [],
        contextHints: [],
        dependsOn: [],
        discipline: "coding",
        goal: "Implement SSRF parser validation",
        id: "parser",
        owns: ["src/security/url.ts"],
        title: "Parser",
      },
      {
        acceptanceChecks: [],
        contextHints: [],
        dependsOn: [],
        discipline: "docs",
        goal: "Draft notes for the feature doc",
        id: "docs",
        owns: ["docs/features/**"],
        title: "Docs",
      },
      {
        acceptanceChecks: ["npm test -- ssrf"],
        contextHints: [],
        dependsOn: ["parser"],
        discipline: "testing",
        goal: "Write SSRF regression tests",
        id: "tests",
        owns: ["src/**/*.test.ts"],
        preferredRunner: "hermes",
        title: "Tests",
      },
    ],
    summary: "Protect outbound fetches from SSRF.",
    title: "Add SSRF protection",
    version: 1,
    workspace: "command-center",
  };

  const plan = planQuest(spec, workers);
  assert.equal(plan.waves.length, 2);
  assert.deepEqual(
    plan.waves[0]?.slices.map((slice) => slice.id),
    ["parser", "docs"],
  );
  assert.deepEqual(
    plan.waves[1]?.slices.map((slice) => slice.id),
    ["tests"],
  );
  assert.equal(plan.waves[1]?.slices[0]?.assignedWorkerId, "sable");
});

test("planner serializes overlapping ownership even when maxParallel allows more", () => {
  const spec: QuestSpec = {
    acceptanceChecks: [],
    featureDoc: { enabled: false },
    hotspots: ["src/orchestration/**"],
    maxParallel: 3,
    slices: [
      {
        acceptanceChecks: [],
        contextHints: [],
        dependsOn: [],
        discipline: "coding",
        goal: "Refactor dispatch state",
        id: "dispatch-core",
        owns: ["src/orchestration/**"],
        title: "Dispatch Core",
      },
      {
        acceptanceChecks: [],
        contextHints: [],
        dependsOn: [],
        discipline: "coding",
        goal: "Adjust one hot file in orchestration",
        id: "dispatch-hotfix",
        owns: ["src/orchestration/grind-dispatch-batch.ts"],
        title: "Dispatch Hotfix",
      },
    ],
    title: "Refactor dispatch",
    version: 1,
    workspace: "command-center",
  };

  const plan = planQuest(spec, workers);
  assert.equal(plan.waves.length, 2);
  assert.equal(plan.waves[0]?.slices.length, 1);
  assert.equal(plan.waves[1]?.slices.length, 1);
});

test("planner defers runnable slices to later waves instead of scheduling null assignments", () => {
  const singleWorker = [workers[0] as RegisteredWorker];
  const spec: QuestSpec = {
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
        goal: "Draft feature notes",
        id: "docs",
        owns: ["docs/features/**"],
        title: "Docs",
      },
    ],
    title: "Single worker planning",
    version: 1,
    workspace: "command-center",
  };

  const plan = planQuest(spec, singleWorker);
  assert.equal(plan.unassigned.length, 0);
  assert.equal(plan.waves.length, 2);
  assert.deepEqual(plan.waves[0]?.slices.map((slice) => slice.assignedWorkerId), ["ember"]);
  assert.deepEqual(plan.waves[1]?.slices.map((slice) => slice.assignedWorkerId), ["ember"]);
});

test("planner reports slices with no compatible worker as unassigned", () => {
  const spec: QuestSpec = {
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
        preferredRunner: "openclaw",
        title: "Parser",
      },
      {
        acceptanceChecks: [],
        contextHints: [],
        dependsOn: ["parser"],
        discipline: "testing",
        goal: "Validate parser changes",
        id: "tests",
        owns: ["src/**/*.test.ts"],
        title: "Tests",
      },
    ],
    title: "Incompatible worker planning",
    version: 1,
    workspace: "command-center",
  };

  const plan = planQuest(spec, workers);
  assert.equal(plan.waves.length, 0);
  assert.deepEqual(plan.unassigned, [
    {
      dependsOn: [],
      id: "parser",
      message: "No compatible enabled worker is available for slice parser",
      reasonCode: "no_worker_available",
      title: "Parser",
    },
    {
      dependsOn: ["parser"],
      id: "tests",
      message: "Slice depends on unassigned prerequisite(s): parser",
      reasonCode: "dependency_blocked",
      title: "Tests",
    },
  ]);
});
