import { z } from "zod";
import { workerRuntimeSchema } from "./runtime";

const workerIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const secretRefPattern = /^[a-z0-9][a-z0-9._-]{0,79}$/;

function nonEmptyString(max: number): z.ZodString {
  return z.string().trim().min(1).max(max);
}

function constrainedString(
  max: number,
  predicate: (value: string) => boolean,
  message: string,
): z.ZodString {
  return nonEmptyString(max).refine(predicate, message);
}

function boundedInt(min: number, max: number): z.ZodNumber {
  return z.number().int().min(min).max(max);
}

export const workerIdSchema = constrainedString(
  80,
  (value) => workerIdPattern.test(value),
  "Worker ids must be lowercase kebab-case",
);
const statSchema = boundedInt(0, 100);
export const secretRefSchema = constrainedString(
  80,
  (value) => secretRefPattern.test(value),
  "Secret references must start with a lowercase letter or digit and may include ., _, and -",
);

export const workerRunnerSchema = z.enum(["codex", "claude", "hermes", "openclaw", "custom"]);
export type WorkerRunner = z.infer<typeof workerRunnerSchema>;

export const workerDisciplineSchema = z.enum(["coding", "testing", "docs", "research"]);
export type WorkerDiscipline = z.infer<typeof workerDisciplineSchema>;
export const workerCalibrationSuiteSchema = z.enum(["training-grounds-v1"]);
export type WorkerCalibrationSuite = z.infer<typeof workerCalibrationSuiteSchema>;

export const workerStatsSchema = z
  .object({
    coding: statSchema,
    testing: statSchema,
    docs: statSchema,
    research: statSchema,
    speed: statSchema,
    mergeSafety: statSchema,
    contextEndurance: statSchema,
  })
  .strict();

export type WorkerStats = z.infer<typeof workerStatsSchema>;

export const workerResourceSchema = z
  .object({
    cpuCost: boundedInt(0, 8),
    memoryCost: boundedInt(0, 8),
    gpuCost: boundedInt(0, 8),
    maxParallel: boundedInt(1, 8),
  })
  .strict();

export const workerBackendAuthSchema = z
  .object({
    envVar: nonEmptyString(120).optional(),
    mode: z.enum(["native-login", "env-var", "secret-store"]).default("native-login"),
    secretRef: secretRefSchema.optional(),
    targetEnvVar: nonEmptyString(120).default("OPENAI_API_KEY"),
  })
  .strict()
  .check(
    z.superRefine((value, ctx) => {
      if (value.mode === "env-var" && !value.envVar) {
        ctx.addIssue({
          code: "custom",
          message: "env-var auth requires auth.envVar",
          path: ["envVar"],
        });
      }

      if (value.mode === "secret-store" && !value.secretRef) {
        ctx.addIssue({
          code: "custom",
          message: "secret-store auth requires auth.secretRef",
          path: ["secretRef"],
        });
      }
    }),
  );

export const workerBackendSchema = z
  .object({
    adapter: nonEmptyString(80),
    auth: workerBackendAuthSchema.optional(),
    baseUrl: nonEmptyString(240).optional(),
    command: z.array(nonEmptyString(240)).min(1).max(24).optional(),
    env: z.record(z.string(), nonEmptyString(400)).optional(),
    executable: nonEmptyString(240).optional(),
    gatewayAuthTokenEnv: nonEmptyString(120).optional(),
    gatewayUrl: nonEmptyString(240).optional(),
    profile: nonEmptyString(120),
    runtime: workerRuntimeSchema.optional(),
    runner: workerRunnerSchema,
    toolPolicy: z
      .object({
        allow: z.array(nonEmptyString(80)).max(24).default([]),
        deny: z.array(nonEmptyString(80)).max(24).default([]),
      })
      .strict()
      .default({ allow: [], deny: [] }),
    workingDirectory: nonEmptyString(240).optional(),
  })
  .strict()
  .check(
    z.superRefine((value, ctx) => {
      if (value.adapter === "local-command" && (!value.command || value.command.length === 0)) {
        ctx.addIssue({
          code: "custom",
          message: "local-command adapter requires backend.command",
          path: ["command"],
        });
      }

      if (value.adapter === "codex-cli" && value.command) {
        ctx.addIssue({
          code: "custom",
          message: "codex-cli adapter does not use backend.command",
          path: ["command"],
        });
      }

      if (value.adapter === "hermes-api" && !value.baseUrl) {
        ctx.addIssue({
          code: "custom",
          message: "hermes-api adapter requires backend.baseUrl",
          path: ["baseUrl"],
        });
      }
    }),
  );

export const workerPersonaSchema = z
  .object({
    approach: nonEmptyString(160),
    prompt: nonEmptyString(400),
    voice: nonEmptyString(120),
  })
  .strict();

export const workerTrustSchema = z
  .object({
    calibratedAt: nonEmptyString(80),
    rating: z.number().min(0).max(1),
  })
  .strict();

export const workerProgressionSchema = z
  .object({
    level: z.number().int().min(1).max(99),
    xp: z.number().int().min(0),
  })
  .strict();

export const workerCalibrationRecordSchema = z
  .object({
    at: nonEmptyString(80),
    checkPassRate: z.number().min(0).max(1),
    completedSliceCount: boundedInt(0, 64),
    disciplineScores: z
      .object({
        coding: statSchema.optional(),
        testing: statSchema.optional(),
        docs: statSchema.optional(),
        research: statSchema.optional(),
      })
      .strict(),
    passedCheckCount: boundedInt(0, 128),
    runId: nonEmptyString(80),
    score: statSchema,
    status: z.enum(["passed", "failed"]),
    suiteId: workerCalibrationSuiteSchema,
    totalCheckCount: boundedInt(0, 128),
    totalSliceCount: boundedInt(1, 64),
    workspacePath: nonEmptyString(400),
    xpAwarded: boundedInt(0, 5000),
  })
  .strict();

export const workerCalibrationSchema = z
  .object({
    history: z.array(workerCalibrationRecordSchema).max(16).default([]),
  })
  .strict()
  .default({ history: [] });

export const registeredWorkerSchema = z
  .object({
    backend: workerBackendSchema,
    calibration: workerCalibrationSchema.default({ history: [] }),
    class: nonEmptyString(80),
    enabled: z.boolean().default(true),
    id: workerIdSchema,
    name: nonEmptyString(80),
    persona: workerPersonaSchema,
    progression: workerProgressionSchema,
    resources: workerResourceSchema,
    stats: workerStatsSchema,
    tags: z.array(nonEmptyString(40)).max(16).default([]),
    title: nonEmptyString(120),
    trust: workerTrustSchema,
  })
  .strict();

export type RegisteredWorker = z.infer<typeof registeredWorkerSchema>;
export type WorkerCalibrationRecord = z.infer<typeof workerCalibrationRecordSchema>;

export const workerRegistrySchema = z
  .object({
    version: z.literal(1),
    workers: z.array(registeredWorkerSchema),
  })
  .strict()
  .check(
    z.superRefine((value, ctx) => {
      const ids = new Set<string>();

      value.workers.forEach((worker, index) => {
        if (ids.has(worker.id)) {
          ctx.addIssue({
            code: "custom",
            message: `Duplicate worker id: ${worker.id}`,
            path: ["workers", index, "id"],
          });
          return;
        }

        ids.add(worker.id);
      });
    }),
  );

export type WorkerRegistryDocument = z.infer<typeof workerRegistrySchema>;
