import { z } from "zod";

import { workerDisciplineSchema, workerRunnerSchema } from "../workers/schema";

const nonEmptyString = (max: number) => z.string().trim().min(1).max(max);
const sliceIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const envKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const questCommandSchema = z
  .object({
    argv: z.array(nonEmptyString(200)).min(1).max(32),
    env: z.record(envKeySchema, nonEmptyString(400)).default({}),
  })
  .strict();
export type QuestCommandSpec = z.infer<typeof questCommandSchema>;

export const questFeatureDocSchema = z
  .object({
    enabled: z.boolean().default(false),
    outputPath: nonEmptyString(240).optional(),
  })
  .strict();

export const questExecutionSchema = z
  .object({
    idleTimeoutMinutes: z.number().int().min(1).max(240).optional(),
    shareSourceDependencies: z.boolean().default(true),
    timeoutMinutes: z.number().int().min(1).max(240).default(20),
  })
  .strict();
export type QuestExecutionSpec = z.infer<typeof questExecutionSchema>;

export const questSliceSchema = z
  .object({
    acceptanceChecks: z.array(questCommandSchema).max(16).default([]),
    contextHints: z.array(nonEmptyString(200)).max(16).default([]),
    description: nonEmptyString(2000).optional(),
    dependsOn: z.array(sliceIdSchema).max(16).default([]),
    discipline: workerDisciplineSchema,
    goal: nonEmptyString(500),
    id: sliceIdSchema,
    owns: z.array(nonEmptyString(240)).min(1).max(24),
    preferredRunner: workerRunnerSchema.optional(),
    preferredTesterRunner: workerRunnerSchema.optional(),
    preferredTesterWorkerId: sliceIdSchema.optional(),
    preferredWorkerId: sliceIdSchema.optional(),
    title: nonEmptyString(120),
  })
  .strict();

export type QuestSliceSpec = z.infer<typeof questSliceSchema>;

export const questSpecSchema = z
  .object({
    acceptanceChecks: z.array(questCommandSchema).max(24).default([]),
    execution: questExecutionSchema.default({
      shareSourceDependencies: true,
      timeoutMinutes: 20,
    }),
    featureDoc: questFeatureDocSchema.default({ enabled: false }),
    hotspots: z.array(nonEmptyString(240)).max(24).default([]),
    maxParallel: z.number().int().min(1).max(8).default(1),
    slices: z.array(questSliceSchema).min(1).max(64),
    summary: nonEmptyString(400).optional(),
    title: nonEmptyString(160),
    version: z.literal(1),
    workspace: nonEmptyString(160),
  })
  .strict()
  .check(
    z.superRefine((value, ctx) => {
      const sliceIds = new Set<string>();

      value.slices.forEach((slice, index) => {
        if (sliceIds.has(slice.id)) {
          ctx.addIssue({
            code: "custom",
            message: `Duplicate slice id: ${slice.id}`,
            path: ["slices", index, "id"],
          });
          return;
        }

        sliceIds.add(slice.id);
      });

      value.slices.forEach((slice, index) => {
        slice.dependsOn.forEach((dependencyId, dependencyIndex) => {
          if (!sliceIds.has(dependencyId)) {
            ctx.addIssue({
              code: "custom",
              message: `Unknown dependency: ${dependencyId}`,
              path: ["slices", index, "dependsOn", dependencyIndex],
            });
          }
        });
      });
    }),
  );

export type QuestSpec = z.infer<typeof questSpecSchema>;
