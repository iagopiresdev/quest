import { resolve } from "node:path";

import { z } from "zod";
import { type QuestSpec, questSpecSchema } from "../planning/spec-schema";
import type { TesterSelectionStrategy } from "../settings";

const nonEmptyString = (max: number) => z.string().trim().min(1).max(max);
const isoDateStringSchema = z.string().datetime({ offset: true });
const partyNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const questPartyBudgetSchema = z
  .object({
    maxConcurrent: z.number().int().min(1).max(8).default(1),
    maxSpecsPerHour: z.number().int().min(1).max(500).default(10),
  })
  .strict();
export type QuestPartyBudget = z.infer<typeof questPartyBudgetSchema>;

export const questPartySchema = z
  .object({
    budget: questPartyBudgetSchema.default({
      maxConcurrent: 1,
      maxSpecsPerHour: 10,
    }),
    enabled: z.boolean().default(true),
    name: partyNameSchema,
    sourceRepo: nonEmptyString(400).transform((value) => resolve(value)),
    targetRef: nonEmptyString(120),
  })
  .strict();
export type QuestParty = z.infer<typeof questPartySchema>;

export const questDaemonProcessSchema = z
  .object({
    pid: z.number().int().min(1),
    startedAt: isoDateStringSchema,
    stopRequested: z.boolean().default(false),
  })
  .strict();
export type QuestDaemonProcess = z.infer<typeof questDaemonProcessSchema>;

export const questDaemonStateSchema = z
  .object({
    activeRunIds: z.record(partyNameSchema, z.array(nonEmptyString(80)).default([])).default({}),
    completedSpecTimestamps: z
      .record(partyNameSchema, z.array(isoDateStringSchema).default([]))
      .default({}),
    cooldownUntil: z.record(partyNameSchema, isoDateStringSchema).default({}),
    lastErrorByParty: z.record(partyNameSchema, z.string().max(2000).nullable()).default({}),
    lastTickTime: isoDateStringSchema.optional(),
    parties: z.array(questPartySchema).default([]),
    partyRestReasons: z.record(partyNameSchema, z.string().trim().min(1).max(400)).default({}),
    // Some legacy daemon-state.json files serialized `"process": null` after shutdown instead
    // of omitting the field. Preprocess null to undefined so the optional check passes and the
    // runtime keeps treating the field as absent.
    process: z.preprocess(
      (value) => (value === null ? undefined : value),
      questDaemonProcessSchema.optional(),
    ),
    version: z.literal(1),
  })
  .strict();
export type QuestDaemonState = z.infer<typeof questDaemonStateSchema>;

export const defaultQuestDaemonState = (): QuestDaemonState =>
  questDaemonStateSchema.parse({
    version: 1,
  });

export const questDaemonConfigSchema = z
  .object({
    cooldownMs: z
      .number()
      .int()
      .min(1_000)
      .max(24 * 60 * 60 * 1_000)
      .default(300_000),
    tickIntervalMs: z
      .number()
      .int()
      .min(1_000)
      .max(24 * 60 * 60 * 1_000)
      .default(60_000),
  })
  .strict();
export type QuestDaemonConfig = z.infer<typeof questDaemonConfigSchema>;

export const defaultQuestDaemonConfig = (): QuestDaemonConfig => questDaemonConfigSchema.parse({});

export const questDaemonResultSchema = z
  .object({
    completedAt: isoDateStringSchema.optional(),
    error: z.string().max(2_000).optional(),
    runId: nonEmptyString(80).optional(),
    startedAt: isoDateStringSchema.optional(),
    status: z.enum(["done", "failed", "queued", "retrying", "running"]),
  })
  .strict();
export type QuestDaemonResult = z.infer<typeof questDaemonResultSchema>;

export const questDaemonSpecDocumentSchema = questSpecSchema
  .extend({
    daemon_result: questDaemonResultSchema.optional(),
    priority: z.number().int().min(1).max(9).default(5),
    retry_count: z.number().int().min(0).max(100).default(0),
    retry_limit: z.number().int().min(0).max(100).default(0),
  })
  .strict();
export type QuestDaemonSpecDocument = z.infer<typeof questDaemonSpecDocumentSchema>;

export type QuestDaemonSpecValidation = {
  document: QuestDaemonSpecDocument;
  spec: QuestSpec;
};

export function toQuestSpec(
  document: QuestDaemonSpecDocument,
  testerSelectionStrategy: TesterSelectionStrategy,
): QuestSpec {
  return questSpecSchema.parse({
    ...document,
    execution: {
      ...document.execution,
      testerSelectionStrategy,
    },
  });
}
