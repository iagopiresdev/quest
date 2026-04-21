import { expect, test } from "bun:test";

import { generateRunChronicle } from "../src/core/chronicles/generator";
import type { QuestRunDocument, QuestRunEvent } from "../src/core/runs/schema";
import { createSpec } from "./helpers";

function createRunWithEvents(events: QuestRunEvent[]): QuestRunDocument {
  return {
    activeProcesses: [],
    createdAt: "2026-04-21T00:00:00.000Z",
    id: "quest-12345678-90abcdef",
    integrationRescueStatus: "unset",
    integrationWorkspacePath: "/tmp/quest/integration",
    plan: {
      maxParallel: 1,
      questTitle: "Chronicle Run",
      unassigned: [],
      warnings: [],
      waves: [],
      workspace: "chronicle-run",
    },
    slices: [],
    sourceRepositoryPath: "/tmp/source",
    spec: createSpec({
      featureDoc: { enabled: true, outputPath: "docs/features/chronicle-run.md" },
      title: "Chronicle Run",
      workspace: "chronicle-run",
    }),
    status: "completed",
    targetRef: "HEAD",
    updatedAt: "2026-04-21T00:00:00.000Z",
    version: 1,
    events,
    workspaceRoot: "/tmp/quest",
  };
}

test("chronicle keeps turn-in pending after integration until the run lands", () => {
  const chronicle = generateRunChronicle(
    createRunWithEvents([
      {
        at: "2026-04-21T00:00:00.000Z",
        details: {},
        type: "run_integrated",
      },
    ]),
  );

  expect(chronicle).toContain("- turn-in status: pending");
});

test("chronicle marks turn-in completed after landing", () => {
  const chronicle = generateRunChronicle(
    createRunWithEvents([
      {
        at: "2026-04-21T00:00:00.000Z",
        details: {},
        type: "run_integrated",
      },
      {
        at: "2026-04-21T00:01:00.000Z",
        details: {},
        type: "run_landed",
      },
    ]),
  );

  expect(chronicle).toContain("- turn-in status: completed");
});
