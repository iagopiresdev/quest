import { expect, test } from "bun:test";

import { planQuest } from "../src/core/planning/planner";
import type { QuestSpec } from "../src/core/planning/spec-schema";
import type { RegisteredWorker } from "../src/core/workers/schema";
import { createCommand, createSlice, createSpec, createWorker } from "./helpers";

const workers: RegisteredWorker[] = [
  createWorker({
    id: "ember",
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
    trust: { calibratedAt: "2026-04-10T00:00:00Z", rating: 0.82 },
  }),
  createWorker(
    {
      class: "tester",
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
    {
      profile: "qwen3.5-27b",
      runner: "hermes",
    },
  ),
];

test("planner assigns independent slices into the same wave and respects dependencies", () => {
  const spec: QuestSpec = createSpec({
    acceptanceChecks: [createCommand(["npm", "test"])],
    featureDoc: { enabled: true, outputPath: "docs/features/ssrf-protection.md" },
    hotspots: ["src/orchestration/**"],
    maxParallel: 2,
    slices: [
      createSlice({ goal: "Implement SSRF parser validation", id: "parser", title: "Parser" }),
      createSlice({
        discipline: "docs",
        goal: "Draft notes for the feature doc",
        id: "docs",
        owns: ["docs/features/**"],
        title: "Docs",
      }),
      createSlice({
        acceptanceChecks: [createCommand(["npm", "test", "--", "ssrf"])],
        dependsOn: ["parser"],
        discipline: "testing",
        goal: "Write SSRF regression tests",
        id: "tests",
        owns: ["src/**/*.test.ts"],
        preferredRunner: "hermes",
        title: "Tests",
      }),
    ],
    summary: "Protect outbound fetches from SSRF.",
    title: "Add SSRF protection",
  });

  const plan = planQuest(spec, workers);
  expect(plan.waves.length).toBe(2);
  expect(plan.waves[0]?.slices.map((slice) => slice.id)).toEqual(["parser", "docs"]);
  expect(plan.waves[1]?.slices.map((slice) => slice.id)).toEqual(["tests"]);
  expect(plan.waves[1]?.slices[0]?.assignedWorkerId).toBe("sable");
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
  expect(plan.waves.length).toBe(2);
  expect(plan.waves[0]?.slices.length).toBe(1);
  expect(plan.waves[1]?.slices.length).toBe(1);
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
  expect(plan.unassigned.length).toBe(0);
  expect(plan.waves.length).toBe(2);
  expect(plan.waves[0]?.slices.map((slice) => slice.assignedWorkerId)).toEqual(["ember"]);
  expect(plan.waves[1]?.slices.map((slice) => slice.assignedWorkerId)).toEqual(["ember"]);
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
  expect(plan.waves.length).toBe(0);
  expect(plan.unassigned).toEqual([
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

test("planner assigns a dedicated tester when builder and tester roles are split", () => {
  const roleWorkers: RegisteredWorker[] = [
    createWorker({
      id: "builder-only",
      name: "Builder",
      role: "builder",
      stats: {
        coding: 92,
        contextEndurance: 60,
        docs: 45,
        mergeSafety: 72,
        research: 40,
        speed: 70,
        testing: 35,
      },
    }),
    createWorker(
      {
        id: "tester-only",
        name: "Tester",
        role: "tester",
        stats: {
          coding: 35,
          contextEndurance: 58,
          docs: 42,
          mergeSafety: 90,
          research: 30,
          speed: 55,
          testing: 95,
        },
      },
      { profile: "hermes", runner: "hermes" },
    ),
  ];

  const spec: QuestSpec = createSpec({
    slices: [
      createSlice({
        acceptanceChecks: [createCommand(["bun", "test"])],
        goal: "Implement parser changes",
        id: "parser",
        preferredTesterRunner: "hermes",
        title: "Parser",
      }),
    ],
    title: "Role split planning",
  });

  const plan = planQuest(spec, roleWorkers);
  expect(plan.waves).toHaveLength(1);
  expect(plan.waves[0]?.slices[0]).toMatchObject({
    assignedTesterWorkerId: "tester-only",
    assignedWorkerId: "builder-only",
  });
});
