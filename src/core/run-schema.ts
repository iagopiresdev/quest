import { z } from "zod";

import { type QuestPlan } from "./planner";
import { questSpecSchema, type QuestSpec } from "./spec-schema";

const nonEmptyString = (max: number) => z.string().trim().min(1).max(max);
const isoDateStringSchema = z.string().datetime({ offset: true });
const questRunIdSchema = z.string().trim().regex(/^quest-[a-z0-9]{8}-[a-z0-9]{8}$/);

export const questRunSliceStatusValues = ["pending", "blocked", "running", "completed", "failed", "aborted"] as const;
export type QuestRunSliceStatus = (typeof questRunSliceStatusValues)[number];

export const questRunStatusValues = ["planned", "blocked", "running", "completed", "failed", "aborted"] as const;
export type QuestRunStatus = (typeof questRunStatusValues)[number];

export const questRunEventTypeValues = [
  "run_created",
  "run_blocked",
  "run_started",
  "run_completed",
  "run_failed",
  "run_aborted",
  "slice_started",
  "slice_completed",
  "slice_failed",
  "slice_aborted",
] as const;
export type QuestRunEventType = (typeof questRunEventTypeValues)[number];

const plannedQuestSliceSchema = z
  .object({
    assignedRunner: z.string().trim().min(1).max(80),
    assignedWorkerId: nonEmptyString(80),
    conflictPaths: z.array(nonEmptyString(240)),
    dependsOn: z.array(nonEmptyString(80)),
    hot: z.boolean(),
    id: nonEmptyString(80),
    score: z.number().nullable(),
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
    code: z.enum(["preferred_worker_missing", "preferred_worker_incompatible", "no_worker_available"]),
    message: nonEmptyString(240),
    sliceId: nonEmptyString(80),
  })
  .strict();

const unassignedQuestSliceSchema = z
  .object({
    dependsOn: z.array(nonEmptyString(80)),
    id: nonEmptyString(80),
    message: nonEmptyString(240),
    reasonCode: z.enum(["dependency_blocked", "no_worker_available"]),
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
    summary: nonEmptyString(400),
  })
  .strict();

export const questRunSliceStateSchema = z
  .object({
    assignedRunner: z.string().trim().min(1).max(80).nullable(),
    assignedWorkerId: nonEmptyString(80).nullable(),
    completedAt: isoDateStringSchema.optional(),
    lastError: nonEmptyString(400).optional(),
    lastOutput: questRunSliceOutputSchema.optional(),
    sliceId: nonEmptyString(80),
    startedAt: isoDateStringSchema.optional(),
    status: z.enum(questRunSliceStatusValues),
    title: nonEmptyString(120),
    wave: z.number().int().min(0),
  })
  .strict();

export const questRunDocumentSchema = z
  .object({
    createdAt: isoDateStringSchema,
    id: questRunIdSchema,
    plan: questPlanSchema,
    spec: questSpecSchema,
    slices: z.array(questRunSliceStateSchema),
    status: z.enum(questRunStatusValues),
    updatedAt: isoDateStringSchema,
    version: z.literal(1),
    events: z.array(questRunEventSchema),
  })
  .strict();

export type QuestRunDocument = z.infer<typeof questRunDocumentSchema>;
export type QuestRunEvent = z.infer<typeof questRunEventSchema>;
export type QuestRunSliceOutput = z.infer<typeof questRunSliceOutputSchema>;
export type QuestRunSliceState = z.infer<typeof questRunSliceStateSchema>;
export type QuestRunPlan = QuestPlan;
export type QuestRunSpec = QuestSpec;
