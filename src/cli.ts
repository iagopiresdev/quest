#!/usr/bin/env bun

import { unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { ZodError } from "zod";

import { listCalibrationSuites, WorkerCalibrator } from "./core/calibration";
import { isQuestDomainError } from "./core/errors";
import { EventDispatcher } from "./core/event-dispatcher";
import {
  type DeliveryStatus,
  deliveryStatusSchema,
  type ObservableEventType,
  observableEventTypeSchema,
  webhookSinkSchema,
} from "./core/observability-schema";
import { ObservabilityStore } from "./core/observability-store";
import { planQuest } from "./core/planner";
import { runSubprocess } from "./core/process";
import { buildProcessEnv } from "./core/process-env";
import { QuestRunCleanup } from "./core/run-cleanup";
import { QuestRunExecutor } from "./core/run-executor";
import { QuestRunIntegrator } from "./core/run-integrator";
import type { QuestRunDocument, QuestRunSliceState } from "./core/run-schema";
import { QuestRunStore } from "./core/run-store";
import { SecretStore } from "./core/secret-store";
import { questSpecSchema } from "./core/spec-schema";
import {
  ensureDirectory,
  resolveQuestCalibrationsRoot,
  resolveQuestObservabilityConfigPath,
  resolveQuestObservabilityDeliveriesPath,
  resolveQuestRunsRoot,
  resolveQuestStateRoot,
  resolveQuestWorkspacesRoot,
  resolveWorkerRegistryPath,
} from "./core/storage";
import { WorkerRegistry } from "./core/worker-registry";
import {
  type RegisteredWorker,
  registeredWorkerSchema,
  type WorkerCalibrationSuite,
} from "./core/worker-schema";

type QuestCliCommand =
  | "doctor"
  | "observability:deliveries:list"
  | "observability:deliveries:retry"
  | "observability:events:list"
  | "observability:sinks:list"
  | "observability:sink:delete"
  | "observability:webhook:upsert"
  | "plan"
  | "run"
  | "runs:abort"
  | "runs:cleanup"
  | "runs:integrate"
  | "runs:rerun"
  | "runs:execute"
  | "runs:logs"
  | "runs:list"
  | "runs:status"
  | "runs:summary"
  | "secrets:delete"
  | "secrets:set"
  | "secrets:status"
  | "setup"
  | "workers:add:codex"
  | "workers:calibrate"
  | "workers:list"
  | "workers:upsert";

type QuestCliContext = {
  args: string[];
  calibrator: WorkerCalibrator;
  dispatcher: EventDispatcher;
  observabilityStore: ObservabilityStore;
  runCleanup: QuestRunCleanup;
  registry: WorkerRegistry;
  runExecutor: QuestRunExecutor;
  runIntegrator: QuestRunIntegrator;
  runStore: QuestRunStore;
  secretStore: SecretStore;
};

type QuestCliCommandDefinition = {
  id: QuestCliCommand;
  matches(args: string[]): boolean;
  usage: string;
  run(context: QuestCliContext): Promise<unknown>;
};

type DoctorCheck = {
  details?: Record<string, unknown>;
  name: string;
  ok: boolean;
};

function printUsage(): void {
  void Bun.write(
    Bun.stdout,
    `${[
      "Usage:",
      ...commandDefinitions.map((definition) => `  ${definition.usage}`),
      "",
      "Output is always JSON.",
    ].join("\n")}\n`,
  );
}

function stdinIsTty(): boolean {
  return process.stdin.isTTY === true;
}

function findOptionValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index < 0) {
    return null;
  }

  return args[index + 1] ?? null;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function requireOptionValue(args: string[], flag: string, label: string): string {
  const value = findOptionValue(args, flag);
  if (!value) {
    throw new Error(`Expected ${label}`);
  }

  return value;
}

function parseCommaSeparatedValues(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseKeyValuePairs(value: string | null): Record<string, string> {
  const entries = parseCommaSeparatedValues(value);
  return Object.fromEntries(
    entries.map((entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex <= 0) {
        throw new Error(`Expected key=value entry, received ${entry}`);
      }

      const key = entry.slice(0, separatorIndex).trim();
      const pairValue = entry.slice(separatorIndex + 1).trim();
      if (!key || !pairValue) {
        throw new Error(`Expected key=value entry, received ${entry}`);
      }

      return [key, pairValue];
    }),
  );
}

function parseObservableEventTypes(value: string | null): ObservableEventType[] {
  return parseCommaSeparatedValues(value).map((entry) => observableEventTypeSchema.parse(entry));
}

function parseObservableEventType(value: string | null): ObservableEventType | undefined {
  return value ? observableEventTypeSchema.parse(value) : undefined;
}

function parseDeliveryStatus(value: string | null): DeliveryStatus | undefined {
  return value ? deliveryStatusSchema.parse(value) : undefined;
}

function slugifyWorkerId(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "codex-worker";
}

function inferInvocationMode(invokedPath: string): "compiled" | "source" | "wrapper" {
  if (invokedPath.endsWith("/src/cli.ts")) {
    return "source";
  }

  if (invokedPath.endsWith("/dist/quest")) {
    return "compiled";
  }

  return "wrapper";
}

async function readStdin(): Promise<string> {
  return await Bun.stdin.text();
}

async function readTextInput(args: string[]): Promise<string> {
  const filePath = findOptionValue(args, "--file");
  const useStdin = hasFlag(args, "--stdin");

  if (filePath) {
    return await Bun.file(filePath).text();
  }

  if (useStdin || !stdinIsTty()) {
    return await readStdin();
  }

  throw new Error("Expected --file <path> or --stdin");
}

async function readJsonInput(args: string[]): Promise<unknown> {
  const filePath = findOptionValue(args, "--file");
  const useStdin = hasFlag(args, "--stdin");

  if (filePath) {
    return JSON.parse(await Bun.file(filePath).text()) as unknown;
  }

  if (useStdin || !stdinIsTty()) {
    const raw = await readStdin();
    return JSON.parse(raw) as unknown;
  }

  throw new Error("Expected --file <path> or --stdin");
}

async function promptWithDefault(question: string, fallback: string): Promise<string> {
  const cli = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = (await cli.question(`${question} [${fallback}]: `)).trim();
    return answer.length > 0 ? answer : fallback;
  } finally {
    cli.close();
  }
}

async function confirmWithDefault(question: string, fallback: boolean): Promise<boolean> {
  const fallbackLabel = fallback ? "Y/n" : "y/N";
  const cli = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = (await cli.question(`${question} [${fallbackLabel}]: `)).trim().toLowerCase();
    if (answer.length === 0) {
      return fallback;
    }

    return answer === "y" || answer === "yes";
  } finally {
    cli.close();
  }
}

function buildCodexWorker(args: string[]): RegisteredWorker {
  const name = findOptionValue(args, "--name") ?? "Codex Worker";
  const authMode = findOptionValue(args, "--auth-mode") ?? "native-login";

  const auth =
    authMode === "env-var"
      ? {
          envVar: requireOptionValue(args, "--env-var", "--env-var <name>"),
          mode: "env-var" as const,
          targetEnvVar: findOptionValue(args, "--target-env-var") ?? "OPENAI_API_KEY",
        }
      : authMode === "secret-store"
        ? {
            mode: "secret-store" as const,
            secretRef: requireOptionValue(args, "--secret-ref", "--secret-ref <name>"),
            targetEnvVar: findOptionValue(args, "--target-env-var") ?? "OPENAI_API_KEY",
          }
        : {
            mode: "native-login" as const,
            targetEnvVar: findOptionValue(args, "--target-env-var") ?? "OPENAI_API_KEY",
          };

  return {
    backend: {
      adapter: "codex-cli",
      auth,
      executable: findOptionValue(args, "--executable") ?? Bun.env.QUEST_RUNNER_CODEX_EXECUTABLE,
      profile: findOptionValue(args, "--profile") ?? "gpt-5.4",
      runner: "codex",
      toolPolicy: {
        allow: parseCommaSeparatedValues(findOptionValue(args, "--allow-tools")),
        deny: parseCommaSeparatedValues(findOptionValue(args, "--deny-tools")),
      },
    },
    calibration: {
      history: [],
    },
    class: findOptionValue(args, "--class") ?? "engineer",
    enabled: true,
    id: findOptionValue(args, "--id") ?? slugifyWorkerId(name),
    name,
    persona: {
      approach: findOptionValue(args, "--approach") ?? "finish the change with minimal churn",
      prompt:
        findOptionValue(args, "--prompt") ?? "Keep diffs narrow and state residual risks briefly.",
      voice: findOptionValue(args, "--voice") ?? "terse",
    },
    progression: { level: 1, xp: 0 },
    resources: { cpuCost: 1, gpuCost: 0, maxParallel: 1, memoryCost: 1 },
    stats: {
      coding: 85,
      contextEndurance: 60,
      docs: 40,
      mergeSafety: 80,
      research: 40,
      speed: 60,
      testing: 70,
    },
    tags: parseCommaSeparatedValues(findOptionValue(args, "--tags")).length
      ? parseCommaSeparatedValues(findOptionValue(args, "--tags"))
      : ["codex"],
    title: findOptionValue(args, "--title") ?? "Battle Engineer",
    trust: { calibratedAt: new Date().toISOString(), rating: 0.8 },
  };
}

function summarizeSliceState(slice: QuestRunSliceState): Record<string, unknown> {
  return {
    id: slice.sliceId,
    integrationStatus: slice.integrationStatus ?? "pending",
    lastError: slice.lastError ?? null,
    status: slice.status,
    title: slice.title,
    wave: slice.wave,
    workerId: slice.assignedWorkerId,
  };
}

function summarizeRunDetail(run: QuestRunDocument): Record<string, unknown> {
  const sliceCounts = run.slices.reduce<Record<string, number>>((counts, slice) => {
    counts[slice.status] = (counts[slice.status] ?? 0) + 1;
    return counts;
  }, {});
  const integrationCounts = run.slices.reduce<Record<string, number>>((counts, slice) => {
    const status = slice.integrationStatus ?? "pending";
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});

  const integrationStatus = run.events.some((event) => event.type === "run_integrated")
    ? "integrated"
    : run.events.some((event) => event.type === "run_integration_checks_failed")
      ? "failed"
      : run.integrationWorkspacePath
        ? "started"
        : "not_started";

  return {
    counts: {
      integration: integrationCounts,
      slices: sliceCounts,
    },
    id: run.id,
    integration: {
      checkCount: run.lastIntegrationChecks?.length ?? 0,
      status: integrationStatus,
      targetRef: run.targetRef ?? null,
      workspacePath: run.integrationWorkspacePath ?? null,
    },
    sourceRepositoryPath: run.sourceRepositoryPath ?? null,
    status: run.status,
    title: run.spec.title,
    updatedAt: run.updatedAt,
    waves: run.plan.waves.length,
    slices: run.slices.map(summarizeSliceState),
  };
}

async function dispatchResultEvents(value: unknown, dispatcher: EventDispatcher): Promise<void> {
  if (typeof value !== "object" || value === null) {
    return;
  }

  const candidate = value as Record<string, unknown>;
  const runCandidate = candidate.run;
  if (
    runCandidate &&
    typeof runCandidate === "object" &&
    runCandidate !== null &&
    "events" in runCandidate
  ) {
    await dispatcher.dispatchRun(runCandidate as QuestRunDocument);
  }

  const resultCandidate = candidate.result;
  if (
    resultCandidate &&
    typeof resultCandidate === "object" &&
    resultCandidate !== null &&
    "run" in resultCandidate
  ) {
    const calibrationResult = resultCandidate as {
      calibration?: {
        at: string;
        runId: string;
        score: number;
        status: "passed" | "failed";
        suiteId: string;
        xpAwarded: number;
      };
      run?: QuestRunDocument;
      worker?: { id: string; name: string };
    };
    if (calibrationResult.run) {
      await dispatcher.dispatchRun(calibrationResult.run);
    }

    if (calibrationResult.calibration && calibrationResult.worker) {
      await dispatcher.dispatchCalibration({
        at: calibrationResult.calibration.at,
        runId: calibrationResult.calibration.runId,
        score: calibrationResult.calibration.score,
        status: calibrationResult.calibration.status,
        suiteId: calibrationResult.calibration.suiteId,
        workerId: calibrationResult.worker.id,
        workerName: calibrationResult.worker.name,
        xpAwarded: calibrationResult.calibration.xpAwarded,
      });
    }
  }
}

async function checkPathWritable(path: string): Promise<DoctorCheck> {
  try {
    await ensureDirectory(path);
    const probePath = resolve(path, `.quest-doctor-${crypto.randomUUID()}.tmp`);
    await Bun.write(probePath, "ok");
    await unlink(probePath);
    return { details: { path }, name: `writable:${path}`, ok: true };
  } catch (error: unknown) {
    return {
      details: {
        message: error instanceof Error ? error.message : String(error),
        path,
      },
      name: `writable:${path}`,
      ok: false,
    };
  }
}

async function checkCodexExecutable(executable: string): Promise<DoctorCheck> {
  try {
    const result = await runSubprocess({
      cmd: [executable, "--version"],
      cwd: Bun.env.PWD ?? ".",
      env: buildProcessEnv(),
      timeoutMs: 30_000,
    });

    return {
      details: {
        executable,
        exitCode: result.exitCode,
        version: result.stdout.trim() || null,
      },
      name: "codex-binary",
      ok: result.exitCode === 0,
    };
  } catch (error: unknown) {
    return {
      details: {
        executable,
        message: error instanceof Error ? error.message : String(error),
      },
      name: "codex-binary",
      ok: false,
    };
  }
}

async function checkCodexLogin(executable: string): Promise<DoctorCheck> {
  try {
    const result = await runSubprocess({
      cmd: [executable, "login", "status"],
      cwd: Bun.env.PWD ?? ".",
      env: buildProcessEnv(),
      timeoutMs: 30_000,
    });

    return {
      details: {
        executable,
        exitCode: result.exitCode,
        stderr: result.stderr.trim() || null,
        stdout: result.stdout.trim() || null,
      },
      name: "codex-login",
      ok: result.exitCode === 0,
    };
  } catch (error: unknown) {
    return {
      details: {
        executable,
        message: error instanceof Error ? error.message : String(error),
      },
      name: "codex-login",
      ok: false,
    };
  }
}

async function runDoctor(
  args: string[],
  secretStore: SecretStore,
  stateRoot: string,
  calibrationsRoot: string,
  observabilityConfigPath: string,
  observabilityDeliveriesPath: string,
  runsRoot: string,
  workspacesRoot: string,
  registryPath: string,
): Promise<Record<string, unknown>> {
  const codexExecutable =
    findOptionValue(args, "--codex-executable") ?? Bun.env.QUEST_RUNNER_CODEX_EXECUTABLE ?? "codex";
  const checks: DoctorCheck[] = [
    {
      details: {
        invokedAs: Bun.argv[1] ?? null,
        mode: inferInvocationMode(Bun.argv[1] ?? ""),
      },
      name: "entrypoint",
      ok: true,
    },
    {
      details: { version: Bun.version },
      name: "bun",
      ok: true,
    },
    await checkPathWritable(stateRoot),
    await checkPathWritable(calibrationsRoot),
    await checkPathWritable(runsRoot),
    await checkPathWritable(workspacesRoot),
    await checkPathWritable(dirname(registryPath)),
    await checkPathWritable(dirname(observabilityConfigPath)),
    await checkPathWritable(dirname(observabilityDeliveriesPath)),
    await checkCodexExecutable(codexExecutable),
  ];

  const codexLogin = await checkCodexLogin(codexExecutable);
  checks.push(codexLogin);

  try {
    const status = await secretStore.getStatus("quest-doctor-probe");
    checks.push({
      details: status,
      name: "secret-store",
      ok: true,
    });
  } catch (error: unknown) {
    checks.push({
      details: {
        message: error instanceof Error ? error.message : String(error),
      },
      name: "secret-store",
      ok: false,
    });
  }

  return {
    checks,
    ok: checks.every((check) => check.ok),
  };
}

function checkOk(checks: DoctorCheck[], name: string): boolean {
  return checks.find((check) => check.name === name)?.ok === true;
}

async function runSetup(
  args: string[],
  registry: WorkerRegistry,
  secretStore: SecretStore,
): Promise<Record<string, unknown>> {
  const stateRoot = resolveQuestStateRoot(findOptionValue(args, "--state-root") ?? undefined);
  const registryPath = resolveWorkerRegistryPath({
    explicitRegistryPath: findOptionValue(args, "--registry") ?? undefined,
    stateRoot,
  });
  const runsRoot = resolveQuestRunsRoot({
    explicitRunsRoot: findOptionValue(args, "--runs-root") ?? undefined,
    stateRoot,
  });
  const workspacesRoot = resolveQuestWorkspacesRoot({
    explicitWorkspacesRoot: findOptionValue(args, "--workspaces-root") ?? undefined,
    stateRoot,
  });
  const calibrationsRoot = resolveQuestCalibrationsRoot({
    explicitCalibrationsRoot: findOptionValue(args, "--calibrations-root") ?? undefined,
    stateRoot,
  });
  const observabilityConfigPath = resolveQuestObservabilityConfigPath({
    explicitObservabilityConfigPath: findOptionValue(args, "--observability-config") ?? undefined,
    stateRoot,
  });
  const observabilityDeliveriesPath = resolveQuestObservabilityDeliveriesPath({
    explicitObservabilityDeliveriesPath:
      findOptionValue(args, "--observability-deliveries") ?? undefined,
    stateRoot,
  });

  const doctor = (await runDoctor(
    args,
    secretStore,
    stateRoot,
    calibrationsRoot,
    observabilityConfigPath,
    observabilityDeliveriesPath,
    runsRoot,
    workspacesRoot,
    registryPath,
  )) as {
    checks: DoctorCheck[];
    ok: boolean;
  };

  const shouldCreateWorker =
    hasFlag(args, "--create-worker") ||
    (!hasFlag(args, "--skip-worker") &&
      checkOk(doctor.checks, "codex-binary") &&
      checkOk(doctor.checks, "codex-login"));

  const interactive = stdinIsTty() && !hasFlag(args, "--yes");
  let createdWorker: RegisteredWorker | null = null;

  if (shouldCreateWorker) {
    let workerName = findOptionValue(args, "--worker-name") ?? "Codex Worker";
    let profile = findOptionValue(args, "--profile") ?? "gpt-5.4";
    let createWorker = true;

    if (interactive) {
      createWorker = await confirmWithDefault("Create a Codex worker now?", true);
      if (createWorker) {
        workerName = await promptWithDefault("Worker name", workerName);
        profile = await promptWithDefault("Codex profile", profile);
      }
    }

    if (createWorker) {
      createdWorker = await registry.upsertWorker(
        registeredWorkerSchema.parse(
          buildCodexWorker([
            "--name",
            workerName,
            "--profile",
            profile,
            "--auth-mode",
            findOptionValue(args, "--auth-mode") ?? "native-login",
            "--id",
            findOptionValue(args, "--worker-id") ?? slugifyWorkerId(workerName),
            ...(findOptionValue(args, "--title")
              ? ["--title", findOptionValue(args, "--title") as string]
              : []),
            ...(findOptionValue(args, "--class")
              ? ["--class", findOptionValue(args, "--class") as string]
              : []),
            ...(findOptionValue(args, "--voice")
              ? ["--voice", findOptionValue(args, "--voice") as string]
              : []),
            ...(findOptionValue(args, "--approach")
              ? ["--approach", findOptionValue(args, "--approach") as string]
              : []),
            ...(findOptionValue(args, "--prompt")
              ? ["--prompt", findOptionValue(args, "--prompt") as string]
              : []),
            ...(findOptionValue(args, "--executable")
              ? ["--executable", findOptionValue(args, "--executable") as string]
              : []),
          ]),
        ),
      );
    }
  }

  return {
    createdWorker,
    doctor,
    paths: {
      calibrationsRoot,
      observabilityConfigPath,
      observabilityDeliveriesPath,
      registryPath,
      runsRoot,
      stateRoot,
      workspacesRoot,
    },
    workers: await registry.listWorkers(),
  };
}

function writeJson(value: unknown): void {
  void Bun.write(Bun.stdout, `${JSON.stringify(value, null, 2)}\n`);
}

function writeError(error: unknown): void {
  if (error instanceof ZodError) {
    void Bun.write(
      Bun.stderr,
      `${JSON.stringify(
        {
          error: "validation_failed",
          details: error.flatten(),
          message: "Input validation failed",
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (isQuestDomainError(error)) {
    void Bun.write(
      Bun.stderr,
      `${JSON.stringify(
        {
          error: error.code,
          details: error.details,
          message: error.message,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  void Bun.write(
    Bun.stderr,
    `${JSON.stringify(
      {
        error: "cli_failure",
        message: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    )}\n`,
  );
}

const commandDefinitions: QuestCliCommandDefinition[] = [
  {
    id: "setup",
    matches: (args) => args.length >= 1 && args[0] === "setup",
    run: async ({ args, registry, secretStore }) => await runSetup(args, registry, secretStore),
    usage:
      "quest setup [--yes] [--create-worker] [--skip-worker] [--worker-name <name>] [--worker-id <id>] [--profile <model>] [--codex-executable <path>] [--state-root <path>]",
  },
  {
    id: "doctor",
    matches: (args) => args.length >= 1 && args[0] === "doctor",
    run: async ({ args, secretStore }) =>
      await runDoctor(
        args,
        secretStore,
        resolveQuestStateRoot(findOptionValue(args, "--state-root") ?? undefined),
        resolveQuestCalibrationsRoot({
          explicitCalibrationsRoot: findOptionValue(args, "--calibrations-root") ?? undefined,
          stateRoot: findOptionValue(args, "--state-root") ?? undefined,
        }),
        resolveQuestObservabilityConfigPath({
          explicitObservabilityConfigPath:
            findOptionValue(args, "--observability-config") ?? undefined,
          stateRoot: findOptionValue(args, "--state-root") ?? undefined,
        }),
        resolveQuestObservabilityDeliveriesPath({
          explicitObservabilityDeliveriesPath:
            findOptionValue(args, "--observability-deliveries") ?? undefined,
          stateRoot: findOptionValue(args, "--state-root") ?? undefined,
        }),
        resolveQuestRunsRoot({
          explicitRunsRoot: findOptionValue(args, "--runs-root") ?? undefined,
          stateRoot: findOptionValue(args, "--state-root") ?? undefined,
        }),
        resolveQuestWorkspacesRoot({
          explicitWorkspacesRoot: findOptionValue(args, "--workspaces-root") ?? undefined,
          stateRoot: findOptionValue(args, "--state-root") ?? undefined,
        }),
        resolveWorkerRegistryPath({
          explicitRegistryPath: findOptionValue(args, "--registry") ?? undefined,
          stateRoot: findOptionValue(args, "--state-root") ?? undefined,
        }),
      ),
    usage:
      "quest doctor [--codex-executable <path>] [--registry <path>] [--runs-root <path>] [--workspaces-root <path>] [--calibrations-root <path>] [--observability-config <path>] [--observability-deliveries <path>] [--state-root <path>]",
  },
  {
    id: "observability:events:list",
    matches: (args) =>
      args.length >= 3 && args[0] === "observability" && args[1] === "events" && args[2] === "list",
    run: async ({ args, observabilityStore, runStore }) => {
      const run = await runStore.getRun(requireOptionValue(args, "--run-id", "--run-id <run-id>"));
      return { events: await observabilityStore.listObservableRunEvents(run) };
    },
    usage:
      "quest observability events list --run-id <run-id> [--runs-root <path>] [--workspaces-root <path>] [--observability-config <path>] [--state-root <path>]",
  },
  {
    id: "observability:sinks:list",
    matches: (args) =>
      args.length >= 3 && args[0] === "observability" && args[1] === "sinks" && args[2] === "list",
    run: async ({ observabilityStore }) => ({
      sinks: await observabilityStore.listSinks(),
    }),
    usage: "quest observability sinks list [--observability-config <path>] [--state-root <path>]",
  },
  {
    id: "observability:deliveries:list",
    matches: (args) =>
      args.length >= 3 &&
      args[0] === "observability" &&
      args[1] === "deliveries" &&
      args[2] === "list",
    run: async ({ args, observabilityStore }) => ({
      deliveries: await observabilityStore.listDeliveries({
        eventType: parseObservableEventType(findOptionValue(args, "--event-type")),
        runId: findOptionValue(args, "--run-id") ?? undefined,
        sinkId: findOptionValue(args, "--sink-id") ?? undefined,
        status: parseDeliveryStatus(findOptionValue(args, "--status")),
      }),
    }),
    usage:
      "quest observability deliveries list [--sink-id <sink-id>] [--run-id <run-id>] [--event-type <event-type>] [--status <pending|delivered|failed>] [--observability-deliveries <path>] [--state-root <path>]",
  },
  {
    id: "observability:deliveries:retry",
    matches: (args) =>
      args.length >= 3 &&
      args[0] === "observability" &&
      args[1] === "deliveries" &&
      args[2] === "retry",
    run: async ({ args, dispatcher }) => ({
      attempts: await dispatcher.retryDeliveries({
        eventType: parseObservableEventType(findOptionValue(args, "--event-type")),
        runId: findOptionValue(args, "--run-id") ?? undefined,
        sinkId: findOptionValue(args, "--sink-id") ?? undefined,
        status: parseDeliveryStatus(findOptionValue(args, "--status")) ?? "failed",
      }),
    }),
    usage:
      "quest observability deliveries retry [--sink-id <sink-id>] [--run-id <run-id>] [--event-type <event-type>] [--status <pending|delivered|failed>] [--observability-config <path>] [--observability-deliveries <path>] [--state-root <path>]",
  },
  {
    id: "observability:webhook:upsert",
    matches: (args) =>
      args.length >= 3 &&
      args[0] === "observability" &&
      args[1] === "webhook" &&
      args[2] === "upsert",
    run: async ({ args, observabilityStore }) => {
      const sink = webhookSinkSchema.parse({
        enabled: !hasFlag(args, "--disabled"),
        eventTypes: parseObservableEventTypes(findOptionValue(args, "--events")),
        headers: parseKeyValuePairs(findOptionValue(args, "--headers")),
        id: findOptionValue(args, "--id") ?? "default-webhook",
        secretHeader: findOptionValue(args, "--secret-header") ?? undefined,
        secretRef: findOptionValue(args, "--secret-ref") ?? undefined,
        type: "webhook",
        url: requireOptionValue(args, "--url", "--url <https://...>"),
      });
      return { sink: await observabilityStore.upsertWebhookSink(sink) };
    },
    usage:
      "quest observability webhook upsert --url <https://...> [--id <sink-id>] [--events <event,event>] [--headers <key=value,key=value>] [--secret-ref <name>] [--secret-header <name>] [--disabled] [--observability-config <path>] [--state-root <path>]",
  },
  {
    id: "observability:sink:delete",
    matches: (args) =>
      args.length >= 3 &&
      args[0] === "observability" &&
      args[1] === "sinks" &&
      args[2] === "delete",
    run: async ({ args, observabilityStore }) => {
      const sinkId = requireOptionValue(args, "--id", "--id <sink-id>");
      await observabilityStore.deleteSink(sinkId);
      return { deleted: sinkId, ok: true };
    },
    usage:
      "quest observability sinks delete --id <sink-id> [--observability-config <path>] [--state-root <path>]",
  },
  {
    id: "secrets:set",
    matches: (args) => args.length >= 2 && args[0] === "secrets" && args[1] === "set",
    run: async ({ args, secretStore }) => {
      const name = requireOptionValue(args, "--name", "--name <secret-name>");
      await secretStore.setSecret(name, await readTextInput(args));
      return { ok: true, secret: await secretStore.getStatus(name) };
    },
    usage: "quest secrets set --name <secret-name> (--file <path> | --stdin)",
  },
  {
    id: "secrets:delete",
    matches: (args) => args.length >= 2 && args[0] === "secrets" && args[1] === "delete",
    run: async ({ args, secretStore }) => {
      const name = requireOptionValue(args, "--name", "--name <secret-name>");
      await secretStore.deleteSecret(name);
      return { ok: true, name };
    },
    usage: "quest secrets delete --name <secret-name>",
  },
  {
    id: "secrets:status",
    matches: (args) => args.length >= 2 && args[0] === "secrets" && args[1] === "status",
    run: async ({ args, secretStore }) => ({
      secret: await secretStore.getStatus(
        requireOptionValue(args, "--name", "--name <secret-name>"),
      ),
    }),
    usage: "quest secrets status --name <secret-name>",
  },
  {
    id: "workers:add:codex",
    matches: (args) =>
      args.length >= 3 && args[0] === "workers" && args[1] === "add" && args[2] === "codex",
    run: async ({ args, registry }) => {
      const worker = registeredWorkerSchema.parse(buildCodexWorker(args));
      return { worker: await registry.upsertWorker(worker) };
    },
    usage:
      "quest workers add codex [--id <id>] [--name <name>] [--profile <model>] [--auth-mode <native-login|env-var|secret-store>] [--env-var <name>] [--secret-ref <name>]",
  },
  {
    id: "workers:calibrate",
    matches: (args) => args.length >= 2 && args[0] === "workers" && args[1] === "calibrate",
    run: async ({ args, calibrator }) => {
      if (hasFlag(args, "--list-suites")) {
        return { suites: listCalibrationSuites() };
      }

      const requestedSuite = findOptionValue(args, "--suite");
      const suiteId = (requestedSuite ?? "training-grounds-v1") as WorkerCalibrationSuite;
      return {
        result: await calibrator.calibrateWorker(
          requireOptionValue(args, "--id", "--id <worker-id>"),
          {
            dryRun: hasFlag(args, "--dry-run"),
            suiteId,
          },
        ),
      };
    },
    usage:
      "quest workers calibrate --id <worker-id> [--suite <training-grounds-v1>] [--dry-run] [--list-suites] [--registry <path>] [--runs-root <path>] [--workspaces-root <path>] [--calibrations-root <path>] [--state-root <path>]",
  },
  {
    id: "workers:list",
    matches: (args) => args.length >= 2 && args[0] === "workers" && args[1] === "list",
    run: async ({ registry }) => ({ workers: await registry.listWorkers() }),
    usage: "quest workers list [--registry <path>]",
  },
  {
    id: "workers:upsert",
    matches: (args) => args.length >= 2 && args[0] === "workers" && args[1] === "upsert",
    run: async ({ args, registry }) => {
      const payload = registeredWorkerSchema.parse(await readJsonInput(args));
      return { worker: await registry.upsertWorker(payload) };
    },
    usage: "quest workers upsert --file <path> [--registry <path>]",
  },
  {
    id: "plan",
    matches: (args) => args.length >= 1 && args[0] === "plan",
    run: async ({ args, registry }) => {
      const spec = questSpecSchema.parse(await readJsonInput(args));
      const workerId = findOptionValue(args, "--worker-id");
      const workers = await registry.listWorkers();
      const plannedSpec = workerId
        ? {
            ...spec,
            slices: spec.slices.map((slice) => ({ ...slice, preferredWorkerId: workerId })),
          }
        : spec;
      const selectedWorkers = workerId
        ? workers.filter((worker) => worker.id === workerId)
        : workers;
      if (workerId && selectedWorkers.length === 0) {
        throw new Error(`Forced worker ${workerId} is not registered`);
      }

      return { plan: planQuest(plannedSpec, selectedWorkers) };
    },
    usage: "quest plan --file <path> [--worker-id <worker-id>] [--registry <path>]",
  },
  {
    id: "run",
    matches: (args) => args.length >= 1 && args[0] === "run",
    run: async ({ args, registry, runStore }) => {
      const spec = questSpecSchema.parse(await readJsonInput(args));
      return {
        run: await runStore.createRun(spec, await registry.listWorkers(), {
          forcedWorkerId: findOptionValue(args, "--worker-id") ?? undefined,
          sourceRepositoryPath: findOptionValue(args, "--source-repo") ?? undefined,
        }),
      };
    },
    usage:
      "quest run --file <path> [--worker-id <worker-id>] [--source-repo <path>] [--registry <path>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:list",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "list",
    run: async ({ runStore }) => ({ runs: await runStore.listRuns() }),
    usage: "quest runs list [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:abort",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "abort",
    run: async ({ args, runStore }) => ({
      run: await runStore.abortRun(requireOptionValue(args, "--id", "--id <run-id>")),
    }),
    usage:
      "quest runs abort --id <run-id> [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:cleanup",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "cleanup",
    run: async ({ args, runCleanup }) => ({
      run: await runCleanup.cleanupRun(requireOptionValue(args, "--id", "--id <run-id>")),
    }),
    usage:
      "quest runs cleanup --id <run-id> [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:integrate",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "integrate",
    run: async ({ args, runIntegrator }) => ({
      run: await runIntegrator.integrateRun(requireOptionValue(args, "--id", "--id <run-id>"), {
        sourceRepositoryPath: findOptionValue(args, "--source-repo") ?? undefined,
        targetRef: findOptionValue(args, "--target-ref") ?? undefined,
      }),
    }),
    usage:
      "quest runs integrate --id <run-id> [--source-repo <path>] [--target-ref <ref>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:rerun",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "rerun",
    run: async ({ args, registry, runStore }) => {
      const previousRun = await runStore.getRun(requireOptionValue(args, "--id", "--id <run-id>"));
      return {
        run: await runStore.createRun(previousRun.spec, await registry.listWorkers(), {
          forcedWorkerId: findOptionValue(args, "--worker-id") ?? undefined,
          sourceRepositoryPath:
            findOptionValue(args, "--source-repo") ?? previousRun.sourceRepositoryPath,
        }),
      };
    },
    usage:
      "quest runs rerun --id <run-id> [--worker-id <worker-id>] [--source-repo <path>] [--registry <path>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:execute",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "execute",
    run: async ({ args, runExecutor }) => ({
      run: await runExecutor.executeRun(requireOptionValue(args, "--id", "--id <run-id>"), {
        dryRun: hasFlag(args, "--dry-run"),
        sourceRepositoryPath: findOptionValue(args, "--source-repo") ?? undefined,
      }),
    }),
    usage:
      "quest runs execute --id <run-id> [--dry-run] [--source-repo <path>] [--registry <path>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:logs",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "logs",
    run: async ({ args, runStore }) => ({
      logs: await runStore.getRunLogs(
        requireOptionValue(args, "--id", "--id <run-id>"),
        findOptionValue(args, "--slice") ?? undefined,
      ),
    }),
    usage:
      "quest runs logs --id <run-id> [--slice <slice-id>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:status",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "status",
    run: async ({ args, runStore }) => ({
      run: await runStore.getRun(requireOptionValue(args, "--id", "--id <run-id>")),
    }),
    usage:
      "quest runs status --id <run-id> [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:summary",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "summary",
    run: async ({ args, runStore }) => {
      const runId = findOptionValue(args, "--id");
      if (runId) {
        return { summary: summarizeRunDetail(await runStore.getRun(runId)) };
      }

      return { runs: await runStore.listRuns() };
    },
    usage:
      "quest runs summary [--id <run-id>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
];

async function main(): Promise<number> {
  const args = Bun.argv.slice(2);

  if (args.length === 0 || hasFlag(args, "--help")) {
    printUsage();
    return 0;
  }

  const command = commandDefinitions.find((definition) => definition.matches(args)) ?? null;
  if (!command) {
    printUsage();
    return 1;
  }

  const stateRoot = resolveQuestStateRoot(findOptionValue(args, "--state-root") ?? undefined);
  const registryPath = resolveWorkerRegistryPath({
    explicitRegistryPath: findOptionValue(args, "--registry") ?? undefined,
    stateRoot,
  });
  const runsRoot = resolveQuestRunsRoot({
    explicitRunsRoot: findOptionValue(args, "--runs-root") ?? undefined,
    stateRoot,
  });
  const workspacesRoot = resolveQuestWorkspacesRoot({
    explicitWorkspacesRoot: findOptionValue(args, "--workspaces-root") ?? undefined,
    stateRoot,
  });
  const calibrationsRoot = resolveQuestCalibrationsRoot({
    explicitCalibrationsRoot: findOptionValue(args, "--calibrations-root") ?? undefined,
    stateRoot,
  });
  const observabilityConfigPath = resolveQuestObservabilityConfigPath({
    explicitObservabilityConfigPath: findOptionValue(args, "--observability-config") ?? undefined,
    stateRoot,
  });
  const observabilityDeliveriesPath = resolveQuestObservabilityDeliveriesPath({
    explicitObservabilityDeliveriesPath:
      findOptionValue(args, "--observability-deliveries") ?? undefined,
    stateRoot,
  });
  const registry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const secretStore = new SecretStore();
  const observabilityStore = new ObservabilityStore(
    observabilityConfigPath,
    observabilityDeliveriesPath,
  );
  const runCleanup = new QuestRunCleanup(runStore);
  const runExecutor = new QuestRunExecutor(runStore, registry, secretStore);
  const runIntegrator = new QuestRunIntegrator(runStore);
  const calibrator = new WorkerCalibrator(registry, runStore, runExecutor, calibrationsRoot);
  const dispatcher = new EventDispatcher(observabilityStore, secretStore);

  try {
    const result = await command.run({
      args,
      calibrator,
      dispatcher,
      observabilityStore,
      registry,
      runCleanup,
      runExecutor,
      runIntegrator,
      runStore,
      secretStore,
    });
    await dispatchResultEvents(result, dispatcher);
    writeJson(result);
    return 0;
  } catch (error: unknown) {
    writeError(error);
    return 1;
  }
}

const exitCode = await main();
if (exitCode !== 0) {
  process.exit(exitCode);
}
