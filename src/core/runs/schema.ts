import { z } from "zod";

import type { QuestPlan } from "../planning/planner";
import {
  type QuestCommandSpec,
  type QuestSpec,
  questCommandSchema,
  questSpecSchema,
} from "../planning/spec-schema";

const nonEmptyString = (max: number) => z.string().trim().min(1).max(max);
const isoDateStringSchema = z.string().datetime({ offset: true });
export const QUEST_RUN_SLICE_MESSAGE_MAX_LENGTH = 400;
const questRunIdSchema = z
  .string()
  .trim()
  .regex(/^quest-[a-z0-9]{8}-[a-z0-9]{8}$/);

export const questRunSliceStatusValues = [
  "pending",
  "blocked",
  "running",
  "testing",
  "completed",
  "skipped",
  "failed",
  "aborted",
] as const;
export type QuestRunSliceStatus = (typeof questRunSliceStatusValues)[number];

export const questRunStatusValues = [
  "planned",
  "blocked",
  "running",
  "paused",
  "completed",
  "failed",
  "aborted",
] as const;
export type QuestRunStatus = (typeof questRunStatusValues)[number];

export const questRunEventTypeValues = [
  "run_created",
  "run_blocked",
  "run_started",
  "run_paused",
  "run_resumed",
  "run_completed",
  "run_failed",
  "run_aborted",
  "run_integration_started",
  "run_integration_checks_started",
  "run_integration_checks_completed",
  "run_integration_checks_failed",
  "run_integrated",
  "run_workspace_cleaned",
  "slice_started",
  "slice_integrated",
  "slice_testing_started",
  "slice_testing_completed",
  "slice_testing_failed",
  "slice_completed",
  "slice_skipped",
  "slice_reassigned",
  "slice_retry_queued",
  "slice_failed",
  "slice_aborted",
] as const;
export type QuestRunEventType = (typeof questRunEventTypeValues)[number];

const plannedQuestSliceSchema = z
  .object({
    assignedRunner: z.string().trim().min(1).max(80),
    assignedTesterRunner: z.string().trim().min(1).max(80),
    assignedTesterWorkerId: nonEmptyString(80),
    assignedWorkerId: nonEmptyString(80),
    conflictPaths: z.array(nonEmptyString(240)),
    dependsOn: z.array(nonEmptyString(80)),
    hot: z.boolean(),
    id: nonEmptyString(80),
    score: z.number().nullable(),
    testerScore: z.number().nullable(),
    title: nonEmptyString(120),
    wave: z.number().int().min(1),
  })
  .strict();

const questPlanWaveSchema = z
  .object({
    index: z.number().int().min(1),
    slices: z.array(plannedQuestSliceSchema),
  })
  .strict();

const questPlanWarningSchema = z
  .object({
    code: z.enum([
      "preferred_worker_missing",
      "preferred_worker_incompatible",
      "preferred_tester_missing",
      "preferred_tester_incompatible",
      "no_tester_available",
      "no_worker_available",
    ]),
    message: nonEmptyString(240),
    sliceId: nonEmptyString(80),
  })
  .strict();

const unassignedQuestSliceSchema = z
  .object({
    dependsOn: z.array(nonEmptyString(80)),
    id: nonEmptyString(80),
    message: nonEmptyString(240),
    reasonCode: z.enum(["dependency_blocked", "no_tester_available", "no_worker_available"]),
    title: nonEmptyString(120),
  })
  .strict();

export const questPlanSchema = z
  .object({
    maxParallel: z.number().int().min(1).max(8),
    questTitle: nonEmptyString(160),
    unassigned: z.array(unassignedQuestSliceSchema),
    warnings: z.array(questPlanWarningSchema),
    waves: z.array(questPlanWaveSchema),
    workspace: nonEmptyString(160),
  })
  .strict();

export const questRunEventSchema = z
  .object({
    at: isoDateStringSchema,
    details: z.record(z.string(), z.unknown()).default({}),
    type: z.enum(questRunEventTypeValues),
  })
  .strict();

export const questRunSliceOutputSchema = z
  .object({
    exitCode: z.number().int(),
    stderr: z.string(),
    stdout: z.string(),
    summary: nonEmptyString(QUEST_RUN_SLICE_MESSAGE_MAX_LENGTH),
  })
  .strict();

export const questRunCheckResultSchema = z
  .object({
    command: questCommandSchema,
    exitCode: z.number().int(),
    stderr: z.string(),
    stdout: z.string(),
  })
  .strict();

export const questRunSliceStateSchema = z
  .object({
    assignedRunner: z.string().trim().min(1).max(80).nullable(),
    assignedTesterRunner: z.string().trim().min(1).max(80).nullable(),
    assignedTesterWorkerId: nonEmptyString(80).nullable(),
    assignedWorkerId: nonEmptyString(80).nullable(),
    baseRevision: nonEmptyString(80).optional(),
    completedAt: isoDateStringSchema.optional(),
    driftedFromBase: z.boolean().optional(),
    integratedCommit: nonEmptyString(80).optional(),
    integrationStatus: z.enum(["pending", "noop", "integrated", "failed"]).optional(),
    lastError: nonEmptyString(QUEST_RUN_SLICE_MESSAGE_MAX_LENGTH).optional(),
    lastChecks: z.array(questRunCheckResultSchema).optional(),
    lastOutput: questRunSliceOutputSchema.optional(),
    lastTesterOutput: questRunSliceOutputSchema.optional(),
    resultRevision: nonEmptyString(80).optional(),
    sliceId: nonEmptyString(80),
    startedAt: isoDateStringSchema.optional(),
    status: z.enum(questRunSliceStatusValues),
    title: nonEmptyString(120),
    wave: z.number().int().min(0),
    workspacePath: nonEmptyString(400).optional(),
  })
  .strict();

export const questRunDocumentSchema = z
  .object({
    createdAt: isoDateStringSchema,
    id: questRunIdSchema,
    integrationBaseRevision: nonEmptyString(80).optional(),
    integrationWorkspacePath: nonEmptyString(400).optional(),
    lastIntegrationChecks: z.array(questRunCheckResultSchema).optional(),
    plan: questPlanSchema,
    sourceRepositoryPath: nonEmptyString(400).optional(),
    spec: questSpecSchema,
    slices: z.array(questRunSliceStateSchema),
    status: z.enum(questRunStatusValues),
    targetRef: nonEmptyString(120).optional(),
    updatedAt: isoDateStringSchema,
    version: z.literal(1),
    events: z.array(questRunEventSchema),
    workspaceRoot: nonEmptyString(400).optional(),
  })
  .strict();

export type QuestRunDocument = z.infer<typeof questRunDocumentSchema>;
export type QuestRunCheckResult = z.infer<typeof questRunCheckResultSchema>;
export type QuestRunEvent = z.infer<typeof questRunEventSchema>;
export type QuestRunCheckCommand = QuestCommandSpec;
export type QuestRunSliceOutput = z.infer<typeof questRunSliceOutputSchema>;
export type QuestRunSliceState = z.infer<typeof questRunSliceStateSchema>;
export type QuestRunPlan = QuestPlan;
export type QuestRunSpec = QuestSpec;
