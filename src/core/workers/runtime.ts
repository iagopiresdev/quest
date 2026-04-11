import { z } from "zod";

function boundedInt(min: number, max: number): z.ZodNumber {
  return z.number().int().min(min).max(max);
}

function boundedNumber(min: number, max: number): z.ZodNumber {
  return z.number().min(min).max(max);
}

const runtimeOptionKeyPattern = /^[A-Za-z0-9_.-]+$/;

export const workerReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
export type WorkerReasoningEffort = z.infer<typeof workerReasoningEffortSchema>;

export const workerRuntimeOptionValueSchema = z.string().trim().min(1).max(240);
export const workerRuntimeOptionKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(
    (value) => runtimeOptionKeyPattern.test(value),
    "Runtime option keys may include letters, digits, ., _, and -",
  );

export const workerRuntimeSchema = z
  .object({
    contextWindow: boundedInt(1, 10_000_000).optional(),
    maxOutputTokens: boundedInt(1, 10_000_000).optional(),
    providerOptions: z
      .record(workerRuntimeOptionKeySchema, workerRuntimeOptionValueSchema)
      .default({}),
    reasoningEffort: workerReasoningEffortSchema.optional(),
    temperature: boundedNumber(0, 2).optional(),
    topP: boundedNumber(0, 1).optional(),
  })
  .strict()
  .check(
    z.superRefine((value, ctx) => {
      if (value.topP !== undefined && value.topP === 0) {
        ctx.addIssue({
          code: "custom",
          message: "topP must be greater than 0",
          path: ["topP"],
        });
      }
    }),
  );

export type WorkerRuntimeConfig = z.infer<typeof workerRuntimeSchema>;
