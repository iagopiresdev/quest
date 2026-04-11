import { z } from "zod";

const workerIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const nonEmptyString = (max: number) => z.string().trim().min(1).max(max);
const statSchema = z.number().int().min(0).max(100);
const secretRefSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]{0,79}$/);

export const workerRunnerValues = ["codex", "claude", "hermes", "openclaw", "custom"] as const;
export type WorkerRunner = (typeof workerRunnerValues)[number];

export const workerDisciplineValues = ["coding", "testing", "docs", "research"] as const;
export type WorkerDiscipline = (typeof workerDisciplineValues)[number];
export const workerCalibrationSuiteValues = ["training-grounds-v1"] as const;
export type WorkerCalibrationSuite = (typeof workerCalibrationSuiteValues)[number];

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
    cpuCost: z.number().int().min(0).max(8),
    memoryCost: z.number().int().min(0).max(8),
    gpuCost: z.number().int().min(0).max(8),
    maxParallel: z.number().int().min(1).max(8),
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
  .superRefine((value, ctx) => {
    if (value.mode === "env-var" && !value.envVar) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "env-var auth requires auth.envVar",
        path: ["envVar"],
      });
    }

    if (value.mode === "secret-store" && !value.secretRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "secret-store auth requires auth.secretRef",
        path: ["secretRef"],
      });
    }
  });

export const workerBackendSchema = z
  .object({
    adapter: nonEmptyString(80),
    auth: workerBackendAuthSchema.optional(),
    command: z.array(nonEmptyString(240)).min(1).max(24).optional(),
    env: z.record(z.string(), nonEmptyString(400)).optional(),
    executable: nonEmptyString(240).optional(),
    gatewayAuthTokenEnv: nonEmptyString(120).optional(),
    gatewayUrl: nonEmptyString(240).optional(),
    profile: nonEmptyString(120),
    runner: z.enum(workerRunnerValues),
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
  .superRefine((value, ctx) => {
    if (value.adapter === "local-command" && (!value.command || value.command.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "local-command adapter requires backend.command",
        path: ["command"],
      });
    }

    if (value.adapter === "codex-cli" && value.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "codex-cli adapter does not use backend.command",
        path: ["command"],
      });
    }
  });

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
    completedSliceCount: z.number().int().min(0).max(64),
    disciplineScores: z
      .object({
        coding: statSchema.optional(),
        testing: statSchema.optional(),
        docs: statSchema.optional(),
        research: statSchema.optional(),
      })
      .strict(),
    passedCheckCount: z.number().int().min(0).max(128),
    runId: nonEmptyString(80),
    score: statSchema,
    status: z.enum(["passed", "failed"]),
    suiteId: z.enum(workerCalibrationSuiteValues),
    totalCheckCount: z.number().int().min(0).max(128),
    totalSliceCount: z.number().int().min(1).max(64),
    workspacePath: nonEmptyString(400),
    xpAwarded: z.number().int().min(0).max(5000),
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
  .superRefine((value, ctx) => {
    const ids = new Set<string>();

    value.workers.forEach((worker, index) => {
      if (ids.has(worker.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate worker id: ${worker.id}`,
          path: ["workers", index, "id"],
        });
        return;
      }

      ids.add(worker.id);
    });
  });

export type WorkerRegistryDocument = z.infer<typeof workerRegistrySchema>;
