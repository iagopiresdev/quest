#!/usr/bin/env bun

import { unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { ZodError } from "zod";
import { isQuestDomainError } from "./core/errors";
import { EventDispatcher } from "./core/observability/event-dispatcher";
import {
  type DeliveryStatus,
  deliveryStatusSchema,
  type ObservableEventType,
  observableEventTypeSchema,
  telegramSinkSchema,
  webhookSinkSchema,
} from "./core/observability/schema";
import { ObservabilityStore } from "./core/observability/store";
import { planQuest } from "./core/planning/planner";
import { questSpecSchema } from "./core/planning/spec-schema";
import { QuestRunCleanup } from "./core/runs/cleanup";
import { QuestRunExecutor } from "./core/runs/executor";
import { QuestRunIntegrator } from "./core/runs/integrator";
import { runSubprocess } from "./core/runs/process";
import { buildProcessEnv } from "./core/runs/process-env";
import type { QuestRunDocument, QuestRunSliceState } from "./core/runs/schema";
import { QuestRunStore } from "./core/runs/store";
import { SecretStore } from "./core/secret-store";
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
import { listCalibrationSuites, WorkerCalibrator } from "./core/workers/calibration";
import {
  createCodexWorkerPreset,
  createHermesWorkerPreset,
  slugifyWorkerId,
} from "./core/workers/presets";
import { WorkerRegistry } from "./core/workers/registry";
import {
  type RegisteredWorker,
  registeredWorkerSchema,
  type WorkerCalibrationSuite,
} from "./core/workers/schema";

type QuestCliCommand =
  | "doctor"
  | "observability:deliveries:list"
  | "observability:deliveries:retry"
  | "observability:events:list"
  | "observability:sinks:list"
  | "observability:sink:delete"
  | "observability:telegram:upsert"
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
  | "workers:add:hermes"
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

type OutputMode = "json" | "pretty";

type RunSliceSummary = {
  id: string;
  integrationStatus: string;
  lastError: string | null;
  status: string;
  title: string;
  wave: number;
  workerId: string | null;
};

type RunDetailSummary = {
  counts: {
    integration: Record<string, number>;
    slices: Record<string, number>;
  };
  id: string;
  integration: {
    checkCount: number;
    status: string;
    targetRef: string | null;
    workspacePath: string | null;
  };
  sourceRepositoryPath: string | null;
  status: string;
  title: string;
  updatedAt: string;
  waves: number;
  slices: RunSliceSummary[];
};

function printUsage(): void {
  void Bun.write(
    Bun.stdout,
    `${[
      "Usage:",
      "  quest [--json|--pretty] <command> [options]",
      "",
      ...commandDefinitions.map((definition) => `  ${definition.usage}`),
      "",
      "Output defaults to JSON for pipes and pretty text for interactive terminals.",
    ].join("\n")}\n`,
  );
}

function stdinIsTty(): boolean {
  return process.stdin.isTTY === true;
}

function stdoutIsTty(): boolean {
  return process.stdout.isTTY === true;
}

function findOptionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }

  return args[index + 1] ?? undefined;
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

function parseCommaSeparatedValues(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseKeyValuePairs(value: string | undefined): Record<string, string> {
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

function parseObservableEventTypes(value: string | undefined): ObservableEventType[] {
  return parseCommaSeparatedValues(value).map((entry) => observableEventTypeSchema.parse(entry));
}

function parseObservableEventType(value: string | undefined): ObservableEventType | undefined {
  return value ? observableEventTypeSchema.parse(value) : undefined;
}

function parseDeliveryStatus(value: string | undefined): DeliveryStatus | undefined {
  return value ? deliveryStatusSchema.parse(value) : undefined;
}

function determineOutputMode(args: string[]): OutputMode {
  if (hasFlag(args, "--json")) {
    return "json";
  }

  if (hasFlag(args, "--pretty")) {
    return "pretty";
  }

  return stdoutIsTty() ? "pretty" : "json";
}

function stripGlobalOutputFlags(args: string[]): string[] {
  return args.filter((argument) => argument !== "--json" && argument !== "--pretty");
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
  const targetEnvVar = findOptionValue(args, "--target-env-var") ?? "OPENAI_API_KEY";
  let auth: Parameters<typeof createCodexWorkerPreset>[0]["auth"];
  if (authMode === "env-var") {
    auth = {
      envVar: requireOptionValue(args, "--env-var", "--env-var <name>"),
      mode: "env-var",
      targetEnvVar,
    };
  } else if (authMode === "secret-store") {
    auth = {
      mode: "secret-store",
      secretRef: requireOptionValue(args, "--secret-ref", "--secret-ref <name>"),
      targetEnvVar,
    };
  } else {
    auth = {
      mode: "native-login",
      targetEnvVar,
    };
  }

  const input: Parameters<typeof createCodexWorkerPreset>[0] = {
    auth,
    executable: findOptionValue(args, "--executable") ?? Bun.env.QUEST_RUNNER_CODEX_EXECUTABLE,
    id: findOptionValue(args, "--id") ?? slugifyWorkerId(name, "codex-worker"),
    name,
    tags: parseCommaSeparatedValues(findOptionValue(args, "--tags")),
    toolAllow: parseCommaSeparatedValues(findOptionValue(args, "--allow-tools")),
    toolDeny: parseCommaSeparatedValues(findOptionValue(args, "--deny-tools")),
  };
  const approach = findOptionValue(args, "--approach");
  const profile = findOptionValue(args, "--profile");
  const prompt = findOptionValue(args, "--prompt");
  const title = findOptionValue(args, "--title");
  const voice = findOptionValue(args, "--voice");
  const workerClass = findOptionValue(args, "--class");

  if (approach) input.approach = approach;
  if (profile) input.profile = profile;
  if (prompt) input.prompt = prompt;
  if (title) input.title = title;
  if (voice) input.voice = voice;
  if (workerClass) input.workerClass = workerClass;

  return createCodexWorkerPreset(input);
}

function buildHermesWorker(args: string[]): RegisteredWorker {
  const name = findOptionValue(args, "--name") ?? "Hermes Worker";
  const authMode = findOptionValue(args, "--auth-mode");
  const targetEnvVar = findOptionValue(args, "--target-env-var") ?? "OPENAI_API_KEY";
  let auth: Parameters<typeof createHermesWorkerPreset>[0]["auth"];
  if (authMode === "env-var") {
    auth = {
      envVar: requireOptionValue(args, "--env-var", "--env-var <name>"),
      mode: "env-var",
      targetEnvVar,
    };
  } else if (authMode === "secret-store") {
    auth = {
      mode: "secret-store",
      secretRef: requireOptionValue(args, "--secret-ref", "--secret-ref <name>"),
      targetEnvVar,
    };
  }

  const input: Parameters<typeof createHermesWorkerPreset>[0] = {
    baseUrl: findOptionValue(args, "--base-url") ?? "http://127.0.0.1:8000/v1",
    id: findOptionValue(args, "--id") ?? slugifyWorkerId(name, "hermes-worker"),
    name,
  };
  const approach = findOptionValue(args, "--approach");
  const profile = findOptionValue(args, "--profile");
  const prompt = findOptionValue(args, "--prompt");
  const title = findOptionValue(args, "--title");
  const voice = findOptionValue(args, "--voice");
  const workerClass = findOptionValue(args, "--class");

  if (auth) input.auth = auth;
  if (approach) input.approach = approach;
  if (profile) input.profile = profile;
  if (prompt) input.prompt = prompt;
  if (title) input.title = title;
  if (voice) input.voice = voice;
  if (workerClass) input.workerClass = workerClass;

  return createHermesWorkerPreset(input);
}

function summarizeSliceState(slice: QuestRunSliceState): RunSliceSummary {
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

function summarizeRunDetail(run: QuestRunDocument): RunDetailSummary {
  const sliceCounts = run.slices.reduce<Record<string, number>>((counts, slice) => {
    counts[slice.status] = (counts[slice.status] ?? 0) + 1;
    return counts;
  }, {});
  const integrationCounts = run.slices.reduce<Record<string, number>>((counts, slice) => {
    const status = slice.integrationStatus ?? "pending";
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});

  let integrationStatus: RunDetailSummary["integration"]["status"] = "not_started";
  if (run.events.some((event) => event.type === "run_integrated")) {
    integrationStatus = "integrated";
  } else if (run.events.some((event) => event.type === "run_integration_checks_failed")) {
    integrationStatus = "failed";
  } else if (run.integrationWorkspacePath) {
    integrationStatus = "started";
  }

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

async function checkHermesApi(baseUrl: string): Promise<DoctorCheck> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`);
    const body = await response.text();
    return {
      details: {
        baseUrl,
        body: body.length > 0 ? body.slice(0, 500) : null,
        status: response.status,
      },
      name: "hermes-api",
      ok: response.ok,
    };
  } catch (error: unknown) {
    return {
      details: {
        baseUrl,
        message: error instanceof Error ? error.message : String(error),
      },
      name: "hermes-api",
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
  const hermesBaseUrl =
    findOptionValue(args, "--hermes-base-url") ?? Bun.env.QUEST_RUNNER_HERMES_BASE_URL ?? null;
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
  if (hermesBaseUrl) {
    checks.push(await checkHermesApi(hermesBaseUrl));
  }

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

function definedPathOptions<
  T extends
    | "explicitRegistryPath"
    | "explicitRunsRoot"
    | "explicitWorkspacesRoot"
    | "explicitCalibrationsRoot"
    | "explicitObservabilityConfigPath"
    | "explicitObservabilityDeliveriesPath",
>(
  stateRoot: string | undefined,
  key: T,
  value: string | undefined,
): { stateRoot?: string } & Partial<Record<T, string>> {
  const partial: Partial<Record<T, string>> = {};
  if (value) {
    partial[key] = value;
  }
  return stateRoot ? { stateRoot, ...partial } : partial;
}

function pushOption(args: string[], flag: string, value: string | undefined): void {
  if (!value) {
    return;
  }

  args.push(flag, value);
}

async function runSetup(
  args: string[],
  registry: WorkerRegistry,
  secretStore: SecretStore,
): Promise<Record<string, unknown>> {
  const stateRootOption = findOptionValue(args, "--state-root");
  const stateRoot = resolveQuestStateRoot(stateRootOption);
  const registryPath = resolveWorkerRegistryPath(
    definedPathOptions(stateRoot, "explicitRegistryPath", findOptionValue(args, "--registry")),
  );
  const runsRoot = resolveQuestRunsRoot(
    definedPathOptions(stateRoot, "explicitRunsRoot", findOptionValue(args, "--runs-root")),
  );
  const workspacesRoot = resolveQuestWorkspacesRoot(
    definedPathOptions(
      stateRoot,
      "explicitWorkspacesRoot",
      findOptionValue(args, "--workspaces-root"),
    ),
  );
  const calibrationsRoot = resolveQuestCalibrationsRoot(
    definedPathOptions(
      stateRoot,
      "explicitCalibrationsRoot",
      findOptionValue(args, "--calibrations-root"),
    ),
  );
  const observabilityConfigPath = resolveQuestObservabilityConfigPath(
    definedPathOptions(
      stateRoot,
      "explicitObservabilityConfigPath",
      findOptionValue(args, "--observability-config"),
    ),
  );
  const observabilityDeliveriesPath = resolveQuestObservabilityDeliveriesPath(
    definedPathOptions(
      stateRoot,
      "explicitObservabilityDeliveriesPath",
      findOptionValue(args, "--observability-deliveries"),
    ),
  );

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

  const backend = findOptionValue(args, "--backend") ?? "codex";
  const shouldCreateWorker =
    hasFlag(args, "--create-worker") ||
    (!hasFlag(args, "--skip-worker") &&
      ((backend === "codex" &&
        checkOk(doctor.checks, "codex-binary") &&
        checkOk(doctor.checks, "codex-login")) ||
        (backend === "hermes" && checkOk(doctor.checks, "hermes-api"))));

  const interactive = stdinIsTty() && !hasFlag(args, "--yes");
  let createdWorker: RegisteredWorker | null = null;

  if (shouldCreateWorker) {
    let workerName =
      findOptionValue(args, "--worker-name") ??
      (backend === "hermes" ? "Hermes Worker" : "Codex Worker");
    let profile =
      findOptionValue(args, "--profile") ?? (backend === "hermes" ? "hermes" : "gpt-5.4");
    let baseUrl =
      findOptionValue(args, "--base-url") ??
      findOptionValue(args, "--hermes-base-url") ??
      "http://127.0.0.1:8000/v1";
    let createWorker = true;

    if (interactive) {
      createWorker = await confirmWithDefault(`Create a ${backend} worker now?`, true);
      if (createWorker) {
        workerName = await promptWithDefault("Worker name", workerName);
        profile = await promptWithDefault("Worker profile", profile);
        if (backend === "hermes") {
          baseUrl = await promptWithDefault("Hermes base URL", baseUrl);
        }
      }
    }

    if (createWorker) {
      const workerArgs = [
        "--name",
        workerName,
        "--profile",
        profile,
        "--id",
        findOptionValue(args, "--worker-id") ?? slugifyWorkerId(workerName),
      ];
      if (backend === "hermes") {
        workerArgs.push("--base-url", baseUrl);
      }
      if (backend === "codex") {
        workerArgs.push("--auth-mode", findOptionValue(args, "--auth-mode") ?? "native-login");
      } else {
        pushOption(workerArgs, "--auth-mode", findOptionValue(args, "--auth-mode"));
      }
      pushOption(workerArgs, "--env-var", findOptionValue(args, "--env-var"));
      pushOption(workerArgs, "--secret-ref", findOptionValue(args, "--secret-ref"));
      pushOption(workerArgs, "--target-env-var", findOptionValue(args, "--target-env-var"));
      pushOption(workerArgs, "--title", findOptionValue(args, "--title"));
      pushOption(workerArgs, "--class", findOptionValue(args, "--class"));
      pushOption(workerArgs, "--voice", findOptionValue(args, "--voice"));
      pushOption(workerArgs, "--approach", findOptionValue(args, "--approach"));
      pushOption(workerArgs, "--prompt", findOptionValue(args, "--prompt"));
      pushOption(workerArgs, "--executable", findOptionValue(args, "--executable"));

      createdWorker = await registry.upsertWorker(
        registeredWorkerSchema.parse(
          (backend === "hermes" ? buildHermesWorker : buildCodexWorker)(workerArgs),
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

function formatCountMap(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    return "none";
  }

  return entries.map(([label, count]) => `${label}=${count}`).join(", ");
}

function formatWorkerLine(worker: RegisteredWorker): string {
  return [
    `${worker.id} (${worker.name})`,
    `${worker.backend.runner}/${worker.backend.adapter}`,
    worker.enabled ? "enabled" : "disabled",
    `trust ${worker.trust.rating.toFixed(2)}`,
  ].join(" | ");
}

function formatDoctorCheck(check: DoctorCheck): string {
  const detailEntries = Object.entries(check.details ?? {}).filter(([, value]) => value !== null);
  const detailText =
    detailEntries.length === 0
      ? ""
      : ` - ${detailEntries
          .map(([key, value]) =>
            typeof value === "string" || typeof value === "number" || typeof value === "boolean"
              ? `${key}=${value}`
              : `${key}=${JSON.stringify(value)}`,
          )
          .join(", ")}`;
  return `${check.ok ? "[ok]" : "[fail]"} ${check.name}${detailText}`;
}

function formatSinkLine(sink: {
  enabled: boolean;
  eventTypes: string[];
  id: string;
  type: string;
}): string {
  const events = sink.eventTypes.length > 0 ? sink.eventTypes.join(",") : "all";
  return `${sink.id} | ${sink.type} | ${sink.enabled ? "enabled" : "disabled"} | events=${events}`;
}

function formatRunSummaryBlock(summary: ReturnType<typeof summarizeRunDetail>): string[] {
  return [
    `Run ${summary.id}`,
    `  title: ${summary.title}`,
    `  status: ${summary.status}`,
    `  updated: ${summary.updatedAt}`,
    `  waves: ${summary.waves}`,
    `  slices: ${formatCountMap(summary.counts.slices)}`,
    `  integration: ${summary.integration.status} (${formatCountMap(summary.counts.integration)})`,
    ...summary.slices.map(
      (slice) =>
        `  - [${slice.status}] ${slice.id} | worker=${slice.workerId ?? "unassigned"} | integration=${slice.integrationStatus}`,
    ),
  ];
}

function formatPrettyOutput(commandId: QuestCliCommand, value: unknown): string {
  const candidate =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  if (!candidate) {
    return JSON.stringify(value, null, 2);
  }

  switch (commandId) {
    case "doctor": {
      const checks = (candidate.checks as DoctorCheck[] | undefined) ?? [];
      const ok = candidate.ok === true ? "ok" : "fail";
      return ["Quest Runner Doctor", `status: ${ok}`, "", ...checks.map(formatDoctorCheck)].join(
        "\n",
      );
    }
    case "setup": {
      const doctor = candidate.doctor as { checks: DoctorCheck[]; ok: boolean } | undefined;
      const createdWorker = candidate.createdWorker as RegisteredWorker | null | undefined;
      const workers = (candidate.workers as RegisteredWorker[] | undefined) ?? [];
      const paths = (candidate.paths as Record<string, string> | undefined) ?? {};
      return [
        "Quest Runner Setup",
        `status: ${doctor?.ok === true ? "ok" : "fail"}`,
        createdWorker
          ? `created worker: ${formatWorkerLine(createdWorker)}`
          : "created worker: none",
        `workers: ${workers.length}`,
        "",
        "Paths",
        ...Object.entries(paths).map(([key, path]) => `  ${key}: ${path}`),
        "",
        "Checks",
        ...(doctor?.checks ?? []).map((check) => `  ${formatDoctorCheck(check)}`),
      ].join("\n");
    }
    case "workers:list": {
      const workers = (candidate.workers as RegisteredWorker[] | undefined) ?? [];
      return ["Workers", ...workers.map((worker) => `  - ${formatWorkerLine(worker)}`)].join("\n");
    }
    case "workers:add:codex":
    case "workers:add:hermes":
    case "workers:upsert": {
      const worker = candidate.worker as RegisteredWorker | undefined;
      if (!worker) {
        return JSON.stringify(value, null, 2);
      }

      return [
        `Worker ${worker.id} saved`,
        `  name: ${worker.name}`,
        `  backend: ${worker.backend.runner}/${worker.backend.adapter}`,
        `  profile: ${worker.backend.profile}`,
        `  enabled: ${worker.enabled}`,
      ].join("\n");
    }
    case "workers:calibrate": {
      const result = candidate.result as
        | {
            calibration: {
              score: number;
              status: string;
              suiteId: string;
              xpAwarded: number;
            };
            run: { id: string; status: string };
            worker: RegisteredWorker;
          }
        | undefined;
      if (!result) {
        return JSON.stringify(value, null, 2);
      }

      return [
        `Calibration ${result.calibration.status}`,
        `  worker: ${result.worker.id}`,
        `  suite: ${result.calibration.suiteId}`,
        `  score: ${result.calibration.score}`,
        `  xp awarded: ${result.calibration.xpAwarded}`,
        `  run: ${result.run.id} (${result.run.status})`,
      ].join("\n");
    }
    case "observability:sinks:list": {
      const sinks =
        (candidate.sinks as
          | Array<{ enabled: boolean; eventTypes: string[]; id: string; type: string }>
          | undefined) ?? [];
      return ["Observability Sinks", ...sinks.map((sink) => `  - ${formatSinkLine(sink)}`)].join(
        "\n",
      );
    }
    case "observability:webhook:upsert":
    case "observability:telegram:upsert": {
      const sink = candidate.sink as
        | { enabled: boolean; eventTypes: string[]; id: string; type: string }
        | undefined;
      return sink ? `Sink saved\n  ${formatSinkLine(sink)}` : JSON.stringify(value, null, 2);
    }
    case "observability:events:list": {
      const events =
        (candidate.events as
          | Array<{ at: string; eventType: string; runId?: string }>
          | undefined) ?? [];
      return [
        `Events (${events.length})`,
        ...events.map(
          (event) => `  - ${event.at} | ${event.eventType} | run=${event.runId ?? "-"}`,
        ),
      ].join("\n");
    }
    case "observability:deliveries:list": {
      const deliveries =
        (candidate.deliveries as
          | Array<{
              attempts: number;
              eventType: string;
              sinkId: string;
              status: string;
            }>
          | undefined) ?? [];
      return [
        `Deliveries (${deliveries.length})`,
        ...deliveries.map(
          (delivery) =>
            `  - [${delivery.status}] ${delivery.sinkId} | ${delivery.eventType} | attempts=${delivery.attempts}`,
        ),
      ].join("\n");
    }
    case "observability:deliveries:retry": {
      const attempts =
        (candidate.attempts as
          | Array<{
              eventType: string;
              ok: boolean;
              sinkId: string;
              status: string;
            }>
          | undefined) ?? [];
      return [
        `Delivery attempts (${attempts.length})`,
        ...attempts.map(
          (attempt) =>
            `  - [${attempt.ok ? "ok" : "fail"}] ${attempt.sinkId} | ${attempt.eventType} | ${attempt.status}`,
        ),
      ].join("\n");
    }
    case "plan": {
      const plan = candidate.plan as
        | {
            unassigned: Array<{ id: string; reason: string }>;
            warnings: string[];
            waves: Array<{
              index: number;
              slices: Array<{ assignedWorkerId?: string | null; id: string }>;
            }>;
          }
        | undefined;
      if (!plan) {
        return JSON.stringify(value, null, 2);
      }

      return [
        `Plan: ${plan.waves.length} wave(s), ${plan.unassigned.length} unassigned, ${plan.warnings.length} warning(s)`,
        ...plan.waves.map(
          (wave) =>
            `  wave ${wave.index}: ${wave.slices
              .map((slice) => `${slice.id}@${slice.assignedWorkerId ?? "unassigned"}`)
              .join(", ")}`,
        ),
        ...plan.unassigned.map((slice) => `  unassigned: ${slice.id} (${slice.reason})`),
        ...plan.warnings.map((warning) => `  warning: ${warning}`),
      ].join("\n");
    }
    case "run":
    case "runs:status":
    case "runs:execute":
    case "runs:integrate":
    case "runs:cleanup":
    case "runs:abort":
    case "runs:rerun": {
      const run = candidate.run as QuestRunDocument | undefined;
      return run
        ? formatRunSummaryBlock(summarizeRunDetail(run)).join("\n")
        : JSON.stringify(value, null, 2);
    }
    case "runs:summary": {
      if (candidate.summary) {
        return formatRunSummaryBlock(
          candidate.summary as ReturnType<typeof summarizeRunDetail>,
        ).join("\n");
      }

      const runs = (candidate.runs as QuestRunDocument[] | undefined) ?? [];
      const lines = [
        "Runs",
        ...runs.map(
          (run) =>
            `  - ${formatRunSummaryBlock(summarizeRunDetail(run))[0]} | status=${run.status}`,
        ),
      ];
      return lines.join("\n");
    }
    case "runs:list": {
      const runs = (candidate.runs as QuestRunDocument[] | undefined) ?? [];
      return [
        `Runs (${runs.length})`,
        ...runs.map((run) => `  - ${run.id} | ${run.status} | ${run.spec.title}`),
      ].join("\n");
    }
    case "runs:logs": {
      const logs =
        (candidate.logs as
          | Array<{ checkName?: string | null; sliceId: string; status?: string; stdout: string }>
          | undefined) ?? [];
      return [
        `Logs (${logs.length})`,
        ...logs.map(
          (log) =>
            `  - slice=${log.sliceId} ${log.checkName ? `check=${log.checkName}` : "worker"}${log.status ? ` status=${log.status}` : ""}`,
        ),
      ].join("\n");
    }
    case "secrets:status": {
      const secret = candidate.secret as
        | { exists: boolean; name: string; platform: string }
        | undefined;
      return secret
        ? [
            `Secret ${secret.name}`,
            `  exists: ${secret.exists}`,
            `  platform: ${secret.platform}`,
          ].join("\n")
        : JSON.stringify(value, null, 2);
    }
    case "secrets:set":
    case "secrets:delete": {
      return JSON.stringify(value, null, 2);
    }
    default:
      return JSON.stringify(value, null, 2);
  }
}

function writeOutput(commandId: QuestCliCommand, mode: OutputMode, value: unknown): void {
  if (mode === "json") {
    writeJson(value);
    return;
  }

  void Bun.write(Bun.stdout, `${formatPrettyOutput(commandId, value)}\n`);
}

function writeError(error: unknown, mode: OutputMode): void {
  if (error instanceof ZodError) {
    const payload = {
      error: "validation_failed",
      details: error.flatten(),
      message: "Input validation failed",
    };
    if (mode === "json") {
      void Bun.write(Bun.stderr, `${JSON.stringify(payload, null, 2)}\n`);
    } else {
      void Bun.write(
        Bun.stderr,
        `Validation failed\n${JSON.stringify(payload.details, null, 2)}\n`,
      );
    }
    return;
  }

  if (isQuestDomainError(error)) {
    const payload = {
      error: error.code,
      details: error.details,
      message: error.message,
    };
    if (mode === "json") {
      void Bun.write(Bun.stderr, `${JSON.stringify(payload, null, 2)}\n`);
    } else {
      void Bun.write(
        Bun.stderr,
        [
          `Error: ${payload.error}`,
          `message: ${payload.message}`,
          payload.details ? `details: ${JSON.stringify(payload.details, null, 2)}` : null,
        ]
          .filter((line) => line !== null)
          .join("\n")
          .concat("\n"),
      );
    }
    return;
  }

  const payload = {
    error: "cli_failure",
    message: error instanceof Error ? error.message : String(error),
  };
  if (mode === "json") {
    void Bun.write(Bun.stderr, `${JSON.stringify(payload, null, 2)}\n`);
  } else {
    void Bun.write(Bun.stderr, `Error: ${payload.error}\nmessage: ${payload.message}\n`);
  }
}

const commandDefinitions: QuestCliCommandDefinition[] = [
  {
    id: "setup",
    matches: (args) => args.length >= 1 && args[0] === "setup",
    run: async ({ args, registry, secretStore }) => await runSetup(args, registry, secretStore),
    usage:
      "quest setup [--yes] [--backend <codex|hermes>] [--create-worker] [--skip-worker] [--worker-name <name>] [--worker-id <id>] [--profile <model>] [--base-url <url>] [--codex-executable <path>] [--hermes-base-url <url>] [--state-root <path>]",
  },
  {
    id: "doctor",
    matches: (args) => args.length >= 1 && args[0] === "doctor",
    run: async ({ args, secretStore }) =>
      await runDoctor(
        args,
        secretStore,
        resolveQuestStateRoot(findOptionValue(args, "--state-root")),
        resolveQuestCalibrationsRoot(
          definedPathOptions(
            findOptionValue(args, "--state-root"),
            "explicitCalibrationsRoot",
            findOptionValue(args, "--calibrations-root"),
          ),
        ),
        resolveQuestObservabilityConfigPath(
          definedPathOptions(
            findOptionValue(args, "--state-root"),
            "explicitObservabilityConfigPath",
            findOptionValue(args, "--observability-config"),
          ),
        ),
        resolveQuestObservabilityDeliveriesPath(
          definedPathOptions(
            findOptionValue(args, "--state-root"),
            "explicitObservabilityDeliveriesPath",
            findOptionValue(args, "--observability-deliveries"),
          ),
        ),
        resolveQuestRunsRoot(
          definedPathOptions(
            findOptionValue(args, "--state-root"),
            "explicitRunsRoot",
            findOptionValue(args, "--runs-root"),
          ),
        ),
        resolveQuestWorkspacesRoot(
          definedPathOptions(
            findOptionValue(args, "--state-root"),
            "explicitWorkspacesRoot",
            findOptionValue(args, "--workspaces-root"),
          ),
        ),
        resolveWorkerRegistryPath(
          definedPathOptions(
            findOptionValue(args, "--state-root"),
            "explicitRegistryPath",
            findOptionValue(args, "--registry"),
          ),
        ),
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
        runId: findOptionValue(args, "--run-id"),
        sinkId: findOptionValue(args, "--sink-id"),
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
        runId: findOptionValue(args, "--run-id"),
        sinkId: findOptionValue(args, "--sink-id"),
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
    id: "observability:telegram:upsert",
    matches: (args) =>
      args.length >= 3 &&
      args[0] === "observability" &&
      args[1] === "telegram" &&
      args[2] === "upsert",
    run: async ({ args, observabilityStore }) => {
      const sink = telegramSinkSchema.parse({
        apiBaseUrl: findOptionValue(args, "--api-base-url") ?? undefined,
        botTokenEnv: findOptionValue(args, "--bot-token-env") ?? undefined,
        botTokenSecretRef: findOptionValue(args, "--bot-token-secret-ref") ?? undefined,
        chatId: requireOptionValue(args, "--chat-id", "--chat-id <id>"),
        disableNotification: hasFlag(args, "--disable-notification"),
        enabled: !hasFlag(args, "--disabled"),
        eventTypes: parseObservableEventTypes(findOptionValue(args, "--events")),
        id: findOptionValue(args, "--id") ?? "default-telegram",
        messageThreadId: findOptionValue(args, "--thread-id")
          ? Number(requireOptionValue(args, "--thread-id", "--thread-id <id>"))
          : undefined,
        parseMode:
          (findOptionValue(args, "--parse-mode") as "Markdown" | "MarkdownV2" | "HTML" | null) ??
          undefined,
        type: "telegram",
      });
      return { sink: await observabilityStore.upsertTelegramSink(sink) };
    },
    usage:
      "quest observability telegram upsert --chat-id <id> [--id <sink-id>] [--bot-token-env <name> | --bot-token-secret-ref <name>] [--api-base-url <url>] [--events <event,event>] [--thread-id <id>] [--parse-mode <Markdown|MarkdownV2|HTML>] [--disable-notification] [--disabled] [--observability-config <path>] [--state-root <path>]",
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
    id: "workers:add:hermes",
    matches: (args) =>
      args.length >= 3 && args[0] === "workers" && args[1] === "add" && args[2] === "hermes",
    run: async ({ args, registry }) => {
      const worker = registeredWorkerSchema.parse(buildHermesWorker(args));
      return { worker: await registry.upsertWorker(worker) };
    },
    usage:
      "quest workers add hermes --base-url <http://127.0.0.1:8000/v1> [--id <id>] [--name <name>] [--profile <model>] [--auth-mode <env-var|secret-store>] [--env-var <name>] [--secret-ref <name>]",
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
          forcedWorkerId: findOptionValue(args, "--worker-id") || undefined,
          sourceRepositoryPath:
            findOptionValue(args, "--source-repo") || previousRun.sourceRepositoryPath,
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
        sourceRepositoryPath: findOptionValue(args, "--source-repo") || undefined,
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
  const rawArgs = Bun.argv.slice(2);
  const outputMode = determineOutputMode(rawArgs);
  const args = stripGlobalOutputFlags(rawArgs);

  if (args.length === 0 || hasFlag(args, "--help")) {
    printUsage();
    return 0;
  }

  const command = commandDefinitions.find((definition) => definition.matches(args)) ?? null;
  if (!command) {
    printUsage();
    return 1;
  }

  const stateRootOption = findOptionValue(args, "--state-root");
  const stateRoot = resolveQuestStateRoot(stateRootOption);
  const registryPath = resolveWorkerRegistryPath(
    definedPathOptions(stateRoot, "explicitRegistryPath", findOptionValue(args, "--registry")),
  );
  const runsRoot = resolveQuestRunsRoot(
    definedPathOptions(stateRoot, "explicitRunsRoot", findOptionValue(args, "--runs-root")),
  );
  const workspacesRoot = resolveQuestWorkspacesRoot(
    definedPathOptions(
      stateRoot,
      "explicitWorkspacesRoot",
      findOptionValue(args, "--workspaces-root"),
    ),
  );
  const calibrationsRoot = resolveQuestCalibrationsRoot(
    definedPathOptions(
      stateRoot,
      "explicitCalibrationsRoot",
      findOptionValue(args, "--calibrations-root"),
    ),
  );
  const observabilityConfigPath = resolveQuestObservabilityConfigPath(
    definedPathOptions(
      stateRoot,
      "explicitObservabilityConfigPath",
      findOptionValue(args, "--observability-config"),
    ),
  );
  const observabilityDeliveriesPath = resolveQuestObservabilityDeliveriesPath(
    definedPathOptions(
      stateRoot,
      "explicitObservabilityDeliveriesPath",
      findOptionValue(args, "--observability-deliveries"),
    ),
  );
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
    writeOutput(command.id, outputMode, result);
    return 0;
  } catch (error: unknown) {
    writeError(error, outputMode);
    return 1;
  }
}

const exitCode = await main();
if (exitCode !== 0) {
  process.exit(exitCode);
}
