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
import { planQuest, rankTesterWorkersForSlice, rankWorkersForSlice } from "./core/planning/planner";
import { type QuestSpec, questSpecSchema } from "./core/planning/spec-schema";
import { parseOpenClawJsonOutput } from "./core/runs/adapters/openclaw-shared";
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
  applyWorkerUpdate,
  getLatestCalibration,
  topWorkerStrengths,
  type WorkerUpdate,
} from "./core/workers/management";
import {
  createCodexWorkerPreset,
  createHermesWorkerPreset,
  createOpenClawWorkerPreset,
  slugifyWorkerId,
} from "./core/workers/presets";
import { WorkerRegistry } from "./core/workers/registry";
import { workerRuntimeSchema } from "./core/workers/runtime";
import {
  type RegisteredWorker,
  registeredWorkerSchema,
  type WorkerCalibrationSuite,
  workerRoleSchema,
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
  | "runs:pause"
  | "runs:resume"
  | "runs:rerun"
  | "runs:execute"
  | "runs:logs"
  | "runs:list"
  | "runs:slices:reassign"
  | "runs:slices:retry"
  | "runs:slices:skip"
  | "runs:status"
  | "runs:summary"
  | "secrets:delete"
  | "secrets:set"
  | "secrets:status"
  | "setup"
  | "workers:add:codex"
  | "workers:add:hermes"
  | "workers:add:openclaw"
  | "workers:calibrate"
  | "workers:history"
  | "workers:status"
  | "workers:summary"
  | "workers:update"
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
  builderWorkerId: string | null;
  id: string;
  integrationStatus: string;
  lastError: string | null;
  status: string;
  testerWorkerId: string | null;
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

type WorkerStatusSummary = {
  calibrationHistoryCount: number;
  enabled: boolean;
  id: string;
  latestCalibration: ReturnType<typeof getLatestCalibration>;
  name: string;
  role: RegisteredWorker["role"];
  runner: RegisteredWorker["backend"]["runner"];
  strengths: ReturnType<typeof topWorkerStrengths>;
  title: string;
  trustRating: number;
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

function findOptionValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const value = args[index + 1];
      if (value) {
        values.push(value);
      }
    }
  }
  return values;
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

function parseRepeatedKeyValuePairs(args: string[], flag: string): Record<string, string> {
  return Object.fromEntries(
    findOptionValues(args, flag).map((entry) => {
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

function parseIntegerOptionValue(args: string[], flag: string): number | undefined {
  const raw = findOptionValue(args, flag);
  if (!raw) {
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`Expected integer for ${flag}`);
  }

  return value;
}

function parseNumberOptionValue(args: string[], flag: string): number | undefined {
  const raw = findOptionValue(args, flag);
  if (!raw) {
    return undefined;
  }

  const value = Number(raw);
  if (Number.isNaN(value)) {
    throw new Error(`Expected number for ${flag}`);
  }

  return value;
}

function parseWorkerRuntime(args: string[]): RegisteredWorker["backend"]["runtime"] {
  const providerOptions = parseRepeatedKeyValuePairs(args, "--provider-option");
  const runtimeCandidate = {
    contextWindow: parseIntegerOptionValue(args, "--context-window"),
    maxOutputTokens: parseIntegerOptionValue(args, "--max-output-tokens"),
    providerOptions,
    reasoningEffort: findOptionValue(args, "--reasoning-effort"),
    temperature: parseNumberOptionValue(args, "--temperature"),
    topP: parseNumberOptionValue(args, "--top-p"),
  };

  const hasRuntimeOptions =
    runtimeCandidate.contextWindow !== undefined ||
    runtimeCandidate.maxOutputTokens !== undefined ||
    runtimeCandidate.reasoningEffort !== undefined ||
    runtimeCandidate.temperature !== undefined ||
    runtimeCandidate.topP !== undefined ||
    Object.keys(runtimeCandidate.providerOptions).length > 0;

  if (!hasRuntimeOptions) {
    return undefined;
  }

  return workerRuntimeSchema.parse(runtimeCandidate);
}

function parseWorkerStatOverrides(args: string[]): Partial<RegisteredWorker["stats"]> {
  const stats: Partial<RegisteredWorker["stats"]> = {};
  const assignStat = (key: keyof RegisteredWorker["stats"], flag: string): void => {
    const value = parseIntegerOptionValue(args, flag);
    if (value !== undefined) {
      stats[key] = value;
    }
  };

  assignStat("coding", "--coding");
  assignStat("testing", "--testing");
  assignStat("docs", "--docs");
  assignStat("research", "--research");
  assignStat("speed", "--speed");
  assignStat("mergeSafety", "--merge-safety");
  assignStat("contextEndurance", "--context-endurance");
  return stats;
}

function parseWorkerResourceOverrides(args: string[]): Partial<RegisteredWorker["resources"]> {
  const resources: Partial<RegisteredWorker["resources"]> = {};
  const assignResource = (key: keyof RegisteredWorker["resources"], flag: string): void => {
    const value = parseIntegerOptionValue(args, flag);
    if (value !== undefined) {
      resources[key] = value;
    }
  };

  assignResource("cpuCost", "--cpu-cost");
  assignResource("memoryCost", "--memory-cost");
  assignResource("gpuCost", "--gpu-cost");
  assignResource("maxParallel", "--max-parallel");
  return resources;
}

function parseWorkerUpdate(args: string[]): WorkerUpdate {
  const stats = parseWorkerStatOverrides(args);
  const resources = parseWorkerResourceOverrides(args);
  const runtime = parseWorkerRuntime(args);
  let enabled: boolean | undefined;
  if (hasFlag(args, "--enable")) {
    enabled = true;
  } else if (hasFlag(args, "--disable")) {
    enabled = false;
  }
  const tagsOption = findOptionValue(args, "--tags");
  const trustRating = parseNumberOptionValue(args, "--trust-rating");
  const level = parseIntegerOptionValue(args, "--level");
  const xp = parseIntegerOptionValue(args, "--xp");

  const update: WorkerUpdate = {};
  const name = findOptionValue(args, "--name");
  const title = findOptionValue(args, "--title");
  const workerClass = findOptionValue(args, "--class");
  const role = findOptionValue(args, "--role");
  const voice = findOptionValue(args, "--voice");
  const approach = findOptionValue(args, "--approach");
  const personaPrompt = findOptionValue(args, "--prompt");

  if (enabled !== undefined) update.enabled = enabled;
  if (name) update.name = name;
  if (title) update.title = title;
  if (workerClass) update.workerClass = workerClass;
  if (role) update.role = workerRoleSchema.parse(role);
  if (voice) update.voice = voice;
  if (approach) update.approach = approach;
  if (personaPrompt) update.personaPrompt = personaPrompt;
  if (Object.keys(stats).length > 0) update.stats = stats;
  if (Object.keys(resources).length > 0) update.resources = resources;
  if (tagsOption !== undefined) update.tags = parseCommaSeparatedValues(tagsOption);
  if (trustRating !== undefined) update.trustRating = trustRating;
  if (level !== undefined) update.level = level;
  if (xp !== undefined) update.xp = xp;

  const backend: NonNullable<WorkerUpdate["backend"]> = {};
  const profile = findOptionValue(args, "--profile");
  const executable = findOptionValue(args, "--executable");
  const agentId = findOptionValue(args, "--agent-id");
  const baseUrl = findOptionValue(args, "--base-url");
  const gatewayUrl = findOptionValue(args, "--gateway-url");
  const allowTools = findOptionValue(args, "--allow-tools");
  const denyTools = findOptionValue(args, "--deny-tools");
  const sessionId = findOptionValue(args, "--session-id");

  if (agentId) backend.agentId = agentId;
  if (profile) backend.profile = profile;
  if (executable) backend.executable = executable;
  if (baseUrl) backend.baseUrl = baseUrl;
  if (gatewayUrl) backend.gatewayUrl = gatewayUrl;
  if (sessionId) backend.sessionId = sessionId;
  if (hasFlag(args, "--local")) backend.local = true;
  if (hasFlag(args, "--no-local")) backend.local = false;
  if (runtime) backend.runtime = runtime;
  if (allowTools !== undefined) backend.toolAllow = parseCommaSeparatedValues(allowTools);
  if (denyTools !== undefined) backend.toolDeny = parseCommaSeparatedValues(denyTools);
  if (Object.keys(backend).length > 0) update.backend = backend;

  return update;
}

function buildWorkerStatusSummary(worker: RegisteredWorker): WorkerStatusSummary {
  return {
    calibrationHistoryCount: worker.calibration.history.length,
    enabled: worker.enabled,
    id: worker.id,
    latestCalibration: getLatestCalibration(worker),
    name: worker.name,
    role: worker.role,
    runner: worker.backend.runner,
    strengths: topWorkerStrengths(worker),
    title: worker.title,
    trustRating: worker.trust.rating,
  };
}

function buildPlanExplanation(spec: QuestSpec, workers: RegisteredWorker[]) {
  return {
    slices: spec.slices.map((slice) => ({
      builderCandidates: rankWorkersForSlice(slice, workers).map((assignment) => ({
        role: assignment.worker.role,
        runner: assignment.worker.backend.runner,
        score: assignment.score,
        strengths: topWorkerStrengths(assignment.worker),
        trustRating: assignment.worker.trust.rating,
        workerId: assignment.worker.id,
      })),
      discipline: slice.discipline,
      preferredRunner: slice.preferredRunner ?? null,
      preferredTesterRunner: slice.preferredTesterRunner ?? null,
      preferredTesterWorkerId: slice.preferredTesterWorkerId ?? null,
      preferredWorkerId: slice.preferredWorkerId ?? null,
      sliceId: slice.id,
      testerCandidates: rankTesterWorkersForSlice(slice, workers).map((assignment) => ({
        role: assignment.worker.role,
        runner: assignment.worker.backend.runner,
        score: assignment.score,
        strengths: topWorkerStrengths(assignment.worker),
        trustRating: assignment.worker.trust.rating,
        workerId: assignment.worker.id,
      })),
      title: slice.title,
    })),
  };
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
    runtime: parseWorkerRuntime(args),
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

  return applyWorkerUpdate(createCodexWorkerPreset(input), parseWorkerUpdate(args));
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
    runtime: parseWorkerRuntime(args),
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

  return applyWorkerUpdate(createHermesWorkerPreset(input), parseWorkerUpdate(args));
}

function buildOpenClawWorker(args: string[]): RegisteredWorker {
  const name = findOptionValue(args, "--name") ?? "OpenClaw Worker";
  const authMode = findOptionValue(args, "--auth-mode");
  const targetEnvVar = findOptionValue(args, "--target-env-var") ?? "OPENCLAW_GATEWAY_TOKEN";
  let auth: Parameters<typeof createOpenClawWorkerPreset>[0]["auth"];
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

  const agentId = findOptionValue(args, "--agent-id") ?? "main";
  const input: Parameters<typeof createOpenClawWorkerPreset>[0] = {
    agentId,
    ...(auth ? { auth } : {}),
    executable: findOptionValue(args, "--executable") ?? Bun.env.QUEST_RUNNER_OPENCLAW_EXECUTABLE,
    gatewayUrl: findOptionValue(args, "--gateway-url") ?? Bun.env.OPENCLAW_GATEWAY_URL,
    id: findOptionValue(args, "--id") ?? slugifyWorkerId(name, "openclaw-worker"),
    ...(hasFlag(args, "--local") ? { local: true } : {}),
    name,
    profile: findOptionValue(args, "--profile") ?? `openclaw/${agentId}`,
    runtime: parseWorkerRuntime(args),
    sessionId: findOptionValue(args, "--session-id"),
    tags: parseCommaSeparatedValues(findOptionValue(args, "--tags")),
  };
  const approach = findOptionValue(args, "--approach");
  const prompt = findOptionValue(args, "--prompt");
  const title = findOptionValue(args, "--title");
  const voice = findOptionValue(args, "--voice");
  const workerClass = findOptionValue(args, "--class");

  if (approach) input.approach = approach;
  if (prompt) input.prompt = prompt;
  if (title) input.title = title;
  if (voice) input.voice = voice;
  if (workerClass) input.workerClass = workerClass;

  return applyWorkerUpdate(createOpenClawWorkerPreset(input), parseWorkerUpdate(args));
}

function defaultSetupWorkerName(backend: string): string {
  if (backend === "hermes") {
    return "Hermes Worker";
  }

  if (backend === "openclaw") {
    return "OpenClaw Worker";
  }

  return "Codex Worker";
}

function defaultSetupProfile(backend: string): string {
  if (backend === "hermes") {
    return "hermes";
  }

  if (backend === "openclaw") {
    return "openclaw/main";
  }

  return "gpt-5.4";
}

function buildSetupWorker(backend: string, workerArgs: string[]): RegisteredWorker {
  if (backend === "hermes") {
    return buildHermesWorker(workerArgs);
  }

  if (backend === "openclaw") {
    return buildOpenClawWorker(workerArgs);
  }

  return buildCodexWorker(workerArgs);
}

function summarizeSliceState(slice: QuestRunSliceState): RunSliceSummary {
  return {
    builderWorkerId: slice.assignedWorkerId,
    id: slice.sliceId,
    integrationStatus: slice.integrationStatus ?? "pending",
    lastError: slice.lastError ?? null,
    status: slice.status,
    testerWorkerId: slice.assignedTesterWorkerId ?? null,
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

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths)];
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

async function checkOpenClawExecutable(executable: string): Promise<DoctorCheck> {
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
      name: "openclaw-binary",
      ok: result.exitCode === 0,
    };
  } catch (error: unknown) {
    return {
      details: {
        executable,
        message: error instanceof Error ? error.message : String(error),
      },
      name: "openclaw-binary",
      ok: false,
    };
  }
}

async function checkOpenClawStatus(
  executable: string,
  options: {
    agentId?: string | undefined;
    gatewayUrl?: string | undefined;
  } = {},
): Promise<DoctorCheck> {
  try {
    const result = await runSubprocess({
      cmd: [executable, "status", "--json"],
      cwd: Bun.env.PWD ?? ".",
      env: buildProcessEnv(
        options.gatewayUrl ? { OPENCLAW_GATEWAY_URL: options.gatewayUrl } : undefined,
      ),
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) {
      return {
        details: {
          executable,
          exitCode: result.exitCode,
          stderr: result.stderr.trim() || null,
          stdout: result.stdout.trim() || null,
        },
        name: "openclaw-status",
        ok: false,
      };
    }

    const parsed = parseOpenClawJsonOutput(result.stdout, result.stderr) as {
      agents?: { agents?: Array<{ id?: string }> };
      gateway?: { reachable?: boolean; url?: string };
    };
    const agentIds =
      parsed.agents?.agents
        ?.map((agent) => (typeof agent.id === "string" ? agent.id : null))
        .filter((agentId): agentId is string => agentId !== null) ?? [];
    const agentExists =
      options.agentId === undefined ||
      options.agentId.length === 0 ||
      agentIds.includes(options.agentId);

    return {
      details: {
        agentExists,
        agentId: options.agentId ?? null,
        executable,
        gatewayReachable: parsed.gateway?.reachable ?? null,
        gatewayUrl: parsed.gateway?.url ?? null,
      },
      name: "openclaw-status",
      ok: (parsed.gateway?.reachable ?? false) && agentExists,
    };
  } catch (error: unknown) {
    return {
      details: {
        agentId: options.agentId ?? null,
        executable,
        message: error instanceof Error ? error.message : String(error),
      },
      name: "openclaw-status",
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
  const openClawExecutable =
    findOptionValue(args, "--openclaw-executable") ??
    Bun.env.QUEST_RUNNER_OPENCLAW_EXECUTABLE ??
    "openclaw";
  const openClawGatewayUrl =
    findOptionValue(args, "--gateway-url") ?? Bun.env.OPENCLAW_GATEWAY_URL ?? null;
  const openClawAgentId = findOptionValue(args, "--agent-id") ?? undefined;
  const shouldCheckOpenClaw =
    (findOptionValue(args, "--backend") ?? "") === "openclaw" ||
    hasFlag(args, "--check-openclaw") ||
    findOptionValue(args, "--openclaw-executable") !== undefined;
  const writableChecks = await Promise.all(
    dedupePaths([
      stateRoot,
      calibrationsRoot,
      runsRoot,
      workspacesRoot,
      dirname(registryPath),
      dirname(observabilityConfigPath),
      dirname(observabilityDeliveriesPath),
    ]).map((path) => checkPathWritable(path)),
  );
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
    ...writableChecks,
    await checkCodexExecutable(codexExecutable),
  ];

  const codexLogin = await checkCodexLogin(codexExecutable);
  checks.push(codexLogin);
  if (hermesBaseUrl) {
    checks.push(await checkHermesApi(hermesBaseUrl));
  }
  if (shouldCheckOpenClaw) {
    checks.push(await checkOpenClawExecutable(openClawExecutable));
    checks.push(
      await checkOpenClawStatus(openClawExecutable, {
        agentId: openClawAgentId,
        gatewayUrl: openClawGatewayUrl ?? undefined,
      }),
    );
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
        (backend === "hermes" && checkOk(doctor.checks, "hermes-api")) ||
        (backend === "openclaw" &&
          checkOk(doctor.checks, "openclaw-binary") &&
          checkOk(doctor.checks, "openclaw-status"))));

  const interactive = stdinIsTty() && !hasFlag(args, "--yes");
  let createdWorker: RegisteredWorker | null = null;

  if (shouldCreateWorker) {
    let workerName = findOptionValue(args, "--worker-name") ?? defaultSetupWorkerName(backend);
    let profile = findOptionValue(args, "--profile") ?? defaultSetupProfile(backend);
    let baseUrl =
      findOptionValue(args, "--base-url") ??
      findOptionValue(args, "--hermes-base-url") ??
      "http://127.0.0.1:8000/v1";
    let agentId = findOptionValue(args, "--agent-id") ?? "main";
    let createWorker = true;

    if (interactive) {
      createWorker = await confirmWithDefault(`Create a ${backend} worker now?`, true);
      if (createWorker) {
        workerName = await promptWithDefault("Worker name", workerName);
        profile = await promptWithDefault("Worker profile", profile);
        if (backend === "hermes") {
          baseUrl = await promptWithDefault("Hermes base URL", baseUrl);
        }
        if (backend === "openclaw") {
          agentId = await promptWithDefault("OpenClaw agent id", agentId);
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
      if (backend === "openclaw") {
        workerArgs.push("--agent-id", agentId);
      }
      if (backend === "codex") {
        workerArgs.push("--auth-mode", findOptionValue(args, "--auth-mode") ?? "native-login");
      } else if (backend === "hermes" || backend === "openclaw") {
        pushOption(workerArgs, "--auth-mode", findOptionValue(args, "--auth-mode"));
      }
      pushOption(workerArgs, "--env-var", findOptionValue(args, "--env-var"));
      pushOption(workerArgs, "--secret-ref", findOptionValue(args, "--secret-ref"));
      pushOption(workerArgs, "--target-env-var", findOptionValue(args, "--target-env-var"));
      pushOption(workerArgs, "--title", findOptionValue(args, "--title"));
      pushOption(workerArgs, "--class", findOptionValue(args, "--class"));
      pushOption(workerArgs, "--role", findOptionValue(args, "--role"));
      pushOption(workerArgs, "--voice", findOptionValue(args, "--voice"));
      pushOption(workerArgs, "--approach", findOptionValue(args, "--approach"));
      pushOption(workerArgs, "--prompt", findOptionValue(args, "--prompt"));
      pushOption(workerArgs, "--executable", findOptionValue(args, "--executable"));
      pushOption(workerArgs, "--gateway-url", findOptionValue(args, "--gateway-url"));
      pushOption(workerArgs, "--session-id", findOptionValue(args, "--session-id"));
      if (hasFlag(args, "--local")) {
        workerArgs.push("--local");
      }
      pushOption(workerArgs, "--tags", findOptionValue(args, "--tags"));
      pushOption(workerArgs, "--reasoning-effort", findOptionValue(args, "--reasoning-effort"));
      pushOption(workerArgs, "--max-output-tokens", findOptionValue(args, "--max-output-tokens"));
      pushOption(workerArgs, "--temperature", findOptionValue(args, "--temperature"));
      pushOption(workerArgs, "--top-p", findOptionValue(args, "--top-p"));
      pushOption(workerArgs, "--context-window", findOptionValue(args, "--context-window"));
      pushOption(workerArgs, "--coding", findOptionValue(args, "--coding"));
      pushOption(workerArgs, "--testing", findOptionValue(args, "--testing"));
      pushOption(workerArgs, "--docs", findOptionValue(args, "--docs"));
      pushOption(workerArgs, "--research", findOptionValue(args, "--research"));
      pushOption(workerArgs, "--speed", findOptionValue(args, "--speed"));
      pushOption(workerArgs, "--merge-safety", findOptionValue(args, "--merge-safety"));
      pushOption(workerArgs, "--context-endurance", findOptionValue(args, "--context-endurance"));
      pushOption(workerArgs, "--cpu-cost", findOptionValue(args, "--cpu-cost"));
      pushOption(workerArgs, "--memory-cost", findOptionValue(args, "--memory-cost"));
      pushOption(workerArgs, "--gpu-cost", findOptionValue(args, "--gpu-cost"));
      pushOption(workerArgs, "--max-parallel", findOptionValue(args, "--max-parallel"));
      pushOption(workerArgs, "--trust-rating", findOptionValue(args, "--trust-rating"));
      pushOption(workerArgs, "--level", findOptionValue(args, "--level"));
      pushOption(workerArgs, "--xp", findOptionValue(args, "--xp"));
      findOptionValues(args, "--provider-option").forEach((entry) => {
        workerArgs.push("--provider-option", entry);
      });

      createdWorker = await registry.upsertWorker(
        registeredWorkerSchema.parse(buildSetupWorker(backend, workerArgs)),
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
    `role ${worker.role}`,
    `${worker.backend.runner}/${worker.backend.adapter}`,
    worker.enabled ? "enabled" : "disabled",
    `trust ${worker.trust.rating.toFixed(2)}`,
  ].join(" | ");
}

const prettyLabels = {
  bossFight: "Boss Fight",
  briefing: "Briefing",
  encounter: "encounter",
  encounters: "encounters",
  party: "party",
  partySelection: "Party Selection",
  quest: "Quest",
  questLog: "Quest Log",
  roster: "Roster",
  trainingGrounds: "Training Grounds",
  turnIn: "Turn-in",
  trial: "trial",
  trials: "trials",
} as const;

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
  const turnInStatus =
    summary.integration.status === "integrated" ? prettyLabels.turnIn.toLowerCase() : "pending";
  return [
    `${prettyLabels.quest} ${summary.id}`,
    `  briefing: ${summary.title}`,
    `  quest status: ${summary.status}`,
    `  updated: ${summary.updatedAt}`,
    `  party waves: ${summary.waves}`,
    `  ${prettyLabels.encounters}: ${formatCountMap(summary.counts.slices)}`,
    `  ${prettyLabels.bossFight.toLowerCase()}: ${summary.integration.status} (${formatCountMap(summary.counts.integration)})`,
    `  ${prettyLabels.turnIn.toLowerCase()}: ${turnInStatus}`,
    ...summary.slices.map(
      (slice) =>
        `  - [${slice.status}] ${prettyLabels.encounter}=${slice.id} | builder=${slice.builderWorkerId ?? "unassigned"} | tester=${slice.testerWorkerId ?? "unassigned"} | ${prettyLabels.bossFight.toLowerCase()}=${slice.integrationStatus}`,
    ),
  ];
}

function formatWorkerStatusPretty(worker: RegisteredWorker, status: WorkerStatusSummary): string {
  return [
    `Party Member ${worker.id}`,
    `  name: ${worker.name}`,
    `  title: ${worker.title}`,
    `  backend: ${worker.backend.runner}/${worker.backend.adapter}`,
    `  profile: ${worker.backend.profile}`,
    `  role: ${status.role}`,
    `  enabled: ${worker.enabled}`,
    `  trust: ${worker.trust.rating.toFixed(2)}`,
    `  level/xp: ${worker.progression.level}/${worker.progression.xp}`,
    `  strengths: ${status.strengths.map((entry) => `${entry.key}=${entry.score}`).join(", ")}`,
    `  latest calibration: ${
      status.latestCalibration
        ? `${status.latestCalibration.suiteId} ${status.latestCalibration.status} ${status.latestCalibration.score}`
        : "none"
    }`,
  ].join("\n");
}

function formatWorkersSummaryPretty(
  entries: Array<{ status: WorkerStatusSummary; worker: RegisteredWorker }>,
): string {
  return [
    `${prettyLabels.roster} (${entries.length})`,
    ...entries.map(
      ({ status, worker }) =>
        `  - ${worker.id} | role=${status.role} | ${worker.backend.profile} | trust=${status.trustRating.toFixed(2)} | strengths=${status.strengths.map((entry) => `${entry.key}=${entry.score}`).join(", ")}`,
    ),
  ].join("\n");
}

function formatWorkerHistoryPretty(worker: RegisteredWorker): string {
  return [
    `${prettyLabels.trainingGrounds} history for ${worker.id}`,
    `  calibration entries: ${worker.calibration.history.length}`,
    ...worker.calibration.history.map(
      (entry) =>
        `  - ${entry.at} | ${entry.suiteId} | ${entry.status} | score=${entry.score} | xp=${entry.xpAwarded} | run=${entry.runId}`,
    ),
  ].join("\n");
}

function formatPlanPretty(candidate: Record<string, unknown>, fallback: unknown): string {
  const plan = candidate.plan as
    | {
        unassigned: Array<{ id: string; reason: string }>;
        warnings: string[];
        waves: Array<{
          index: number;
          slices: Array<{
            assignedTesterWorkerId?: string | null;
            assignedWorkerId?: string | null;
            id: string;
          }>;
        }>;
      }
    | undefined;
  const explanation = candidate.explanation as
    | {
        slices: Array<{
          builderCandidates: Array<{
            runner: string;
            role: string;
            score: number;
            strengths: Array<{ key: string; score: number }>;
            trustRating: number;
            workerId: string;
          }>;
          discipline: string;
          testerCandidates: Array<{
            runner: string;
            role: string;
            score: number;
            strengths: Array<{ key: string; score: number }>;
            trustRating: number;
            workerId: string;
          }>;
          sliceId: string;
        }>;
      }
    | undefined;
  if (!plan) {
    return JSON.stringify(fallback, null, 2);
  }

  const lines = [
    `${prettyLabels.briefing}: ${plan.waves.length} wave(s), ${plan.unassigned.length} unassigned, ${plan.warnings.length} warning(s)`,
    ...plan.waves.map(
      (wave) =>
        `  party wave ${wave.index}: ${wave.slices
          .map(
            (slice) =>
              `${slice.id}@builder:${slice.assignedWorkerId ?? "unassigned"}/tester:${slice.assignedTesterWorkerId ?? "unassigned"}`,
          )
          .join(", ")}`,
    ),
    ...plan.unassigned.map(
      (slice) => `  unassigned ${prettyLabels.encounter}: ${slice.id} (${slice.reason})`,
    ),
    ...plan.warnings.map((warning) => `  warning: ${warning}`),
  ];

  if (explanation) {
    lines.push("", prettyLabels.partySelection);
    explanation.slices.forEach((slice) => {
      lines.push(`  ${prettyLabels.encounter} ${slice.sliceId} (${slice.discipline})`);
      lines.push("    builders");
      slice.builderCandidates.slice(0, 3).forEach((candidateEntry) => {
        lines.push(
          `      - ${candidateEntry.workerId} ${candidateEntry.runner} role=${candidateEntry.role} score=${candidateEntry.score} trust=${candidateEntry.trustRating.toFixed(2)} strengths=${candidateEntry.strengths.map((entry) => `${entry.key}=${entry.score}`).join(", ")}`,
        );
      });
      lines.push("    testers");
      slice.testerCandidates.slice(0, 3).forEach((candidateEntry) => {
        lines.push(
          `      - ${candidateEntry.workerId} ${candidateEntry.runner} role=${candidateEntry.role} score=${candidateEntry.score} trust=${candidateEntry.trustRating.toFixed(2)} strengths=${candidateEntry.strengths.map((entry) => `${entry.key}=${entry.score}`).join(", ")}`,
        );
      });
    });
  }

  return lines.join("\n");
}

function formatRunPretty(candidate: Record<string, unknown>, fallback: unknown): string {
  const run = candidate.run as QuestRunDocument | undefined;
  return run
    ? formatRunSummaryBlock(summarizeRunDetail(run)).join("\n")
    : JSON.stringify(fallback, null, 2);
}

function formatRunsSummaryPretty(candidate: Record<string, unknown>): string {
  if (candidate.summary) {
    return formatRunSummaryBlock(candidate.summary as ReturnType<typeof summarizeRunDetail>).join(
      "\n",
    );
  }

  const runs = (candidate.runs as QuestRunDocument[] | undefined) ?? [];
  return [
    prettyLabels.questLog,
    ...runs.map(
      (run) => `  - ${formatRunSummaryBlock(summarizeRunDetail(run))[0]} | status=${run.status}`,
    ),
  ].join("\n");
}

function formatLogsPretty(candidate: Record<string, unknown>): string {
  const logView = candidate.logs as
    | {
        runId: string;
        slices: Array<{
          lastChecks?: Array<{ command: { argv: string[] }; exitCode: number }> | undefined;
          lastOutput?: { exitCode: number } | undefined;
          sliceId: string;
          status: string;
        }>;
      }
    | undefined;
  const logLines =
    logView?.slices.flatMap((slice) => [
      `  - ${prettyLabels.encounter}=${slice.sliceId} ${prettyLabels.party} status=${slice.status}${slice.lastOutput ? ` exit=${slice.lastOutput.exitCode}` : ""}`,
      ...(slice.lastChecks ?? []).map(
        (check) =>
          `    ${prettyLabels.trial}=${check.command.argv.join(" ")} status=${check.exitCode === 0 ? "passed" : "failed"} exit=${check.exitCode}`,
      ),
    ]) ?? [];
  return [`Chronicle${logView ? ` for ${logView.runId}` : ""}`, ...logLines].join("\n");
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
      return [
        prettyLabels.roster,
        ...workers.map((worker) => `  - ${formatWorkerLine(worker)}`),
      ].join("\n");
    }
    case "workers:summary": {
      const entries =
        (candidate.workers as
          | Array<{ status: WorkerStatusSummary; worker: RegisteredWorker }>
          | undefined) ?? [];
      return formatWorkersSummaryPretty(entries);
    }
    case "workers:history": {
      const worker = candidate.worker as RegisteredWorker | undefined;
      return worker ? formatWorkerHistoryPretty(worker) : JSON.stringify(value, null, 2);
    }
    case "workers:status": {
      const worker = candidate.worker as RegisteredWorker | undefined;
      const status = candidate.status as WorkerStatusSummary | undefined;
      if (!worker || !status) {
        return JSON.stringify(value, null, 2);
      }

      return formatWorkerStatusPretty(worker, status);
    }
    case "workers:add:codex":
    case "workers:add:hermes":
    case "workers:add:openclaw":
    case "workers:update":
    case "workers:upsert": {
      const worker = candidate.worker as RegisteredWorker | undefined;
      if (!worker) {
        return JSON.stringify(value, null, 2);
      }

      return [
        `${prettyLabels.roster} updated: ${worker.id}`,
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
        `${prettyLabels.trainingGrounds}: ${result.calibration.status}`,
        `  party member: ${result.worker.id}`,
        `  suite: ${result.calibration.suiteId}`,
        `  score: ${result.calibration.score}`,
        `  xp awarded: ${result.calibration.xpAwarded}`,
        `  quest: ${result.run.id} (${result.run.status})`,
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
      return formatPlanPretty(candidate, value);
    }
    case "run":
    case "runs:status":
    case "runs:execute":
    case "runs:integrate":
    case "runs:cleanup":
    case "runs:abort":
    case "runs:pause":
    case "runs:resume":
    case "runs:rerun": {
      return formatRunPretty(candidate, value);
    }
    case "runs:slices:reassign":
    case "runs:slices:retry":
    case "runs:slices:skip": {
      return formatRunPretty(candidate, value);
    }
    case "runs:summary": {
      return formatRunsSummaryPretty(candidate);
    }
    case "runs:list": {
      const runs = (candidate.runs as QuestRunDocument[] | undefined) ?? [];
      return [
        `${prettyLabels.questLog} (${runs.length})`,
        ...runs.map((run) => `  - ${run.id} | ${run.status} | ${run.spec.title}`),
      ].join("\n");
    }
    case "runs:logs": {
      return formatLogsPretty(candidate);
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
      "quest setup [--yes] [--backend <codex|hermes|openclaw>] [--create-worker] [--skip-worker] [--worker-name <name>] [--worker-id <id>] [--profile <model>] [--base-url <url>] [--codex-executable <path>] [--openclaw-executable <path>] [--hermes-base-url <url>] [--gateway-url <url>] [--agent-id <id>] [--session-id <id>] [--local] [--role <builder|tester|hybrid>] [--coding <n>] [--testing <n>] [--docs <n>] [--research <n>] [--speed <n>] [--merge-safety <n>] [--context-endurance <n>] [--cpu-cost <n>] [--memory-cost <n>] [--gpu-cost <n>] [--max-parallel <n>] [--reasoning-effort <none|minimal|low|medium|high|xhigh>] [--max-output-tokens <n>] [--temperature <n>] [--top-p <n>] [--context-window <n>] [--provider-option <key=value>] [--state-root <path>]",
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
      "quest doctor [--codex-executable <path>] [--openclaw-executable <path>] [--check-openclaw] [--gateway-url <url>] [--agent-id <id>] [--registry <path>] [--runs-root <path>] [--workspaces-root <path>] [--calibrations-root <path>] [--observability-config <path>] [--observability-deliveries <path>] [--state-root <path>]",
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
      "quest workers add codex [--id <id>] [--name <name>] [--profile <model>] [--tags <a,b>] [--role <builder|tester|hybrid>] [--coding <n>] [--testing <n>] [--docs <n>] [--research <n>] [--speed <n>] [--merge-safety <n>] [--context-endurance <n>] [--cpu-cost <n>] [--memory-cost <n>] [--gpu-cost <n>] [--max-parallel <n>] [--trust-rating <n>] [--level <n>] [--xp <n>] [--reasoning-effort <none|minimal|low|medium|high|xhigh>] [--max-output-tokens <n>] [--temperature <n>] [--top-p <n>] [--context-window <n>] [--provider-option <key=value>] [--auth-mode <native-login|env-var|secret-store>] [--env-var <name>] [--secret-ref <name>]",
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
      "quest workers add hermes --base-url <http://127.0.0.1:8000/v1> [--id <id>] [--name <name>] [--tags <a,b>] [--role <builder|tester|hybrid>] [--coding <n>] [--testing <n>] [--docs <n>] [--research <n>] [--speed <n>] [--merge-safety <n>] [--context-endurance <n>] [--cpu-cost <n>] [--memory-cost <n>] [--gpu-cost <n>] [--max-parallel <n>] [--trust-rating <n>] [--level <n>] [--xp <n>] [--profile <model>] [--reasoning-effort <none|minimal|low|medium|high|xhigh>] [--max-output-tokens <n>] [--temperature <n>] [--top-p <n>] [--context-window <n>] [--provider-option <key=value>] [--auth-mode <env-var|secret-store>] [--env-var <name>] [--secret-ref <name>]",
  },
  {
    id: "workers:add:openclaw",
    matches: (args) =>
      args.length >= 3 && args[0] === "workers" && args[1] === "add" && args[2] === "openclaw",
    run: async ({ args, registry }) => {
      const worker = registeredWorkerSchema.parse(buildOpenClawWorker(args));
      return { worker: await registry.upsertWorker(worker) };
    },
    usage:
      "quest workers add openclaw [--agent-id <id> | --session-id <id>] [--gateway-url <url>] [--local] [--executable <path>] [--id <id>] [--name <name>] [--profile <name>] [--tags <a,b>] [--role <builder|tester|hybrid>] [--coding <n>] [--testing <n>] [--docs <n>] [--research <n>] [--speed <n>] [--merge-safety <n>] [--context-endurance <n>] [--cpu-cost <n>] [--memory-cost <n>] [--gpu-cost <n>] [--max-parallel <n>] [--trust-rating <n>] [--level <n>] [--xp <n>] [--reasoning-effort <none|minimal|low|medium|high|xhigh>] [--max-output-tokens <n>] [--temperature <n>] [--top-p <n>] [--context-window <n>] [--provider-option <key=value>] [--auth-mode <env-var|secret-store>] [--env-var <name>] [--secret-ref <name>] [--target-env-var <name>]",
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
    id: "workers:history",
    matches: (args) => args.length >= 2 && args[0] === "workers" && args[1] === "history",
    run: async ({ args, registry }) => ({
      worker: await registry.getWorker(requireOptionValue(args, "--id", "--id <worker-id>")),
    }),
    usage: "quest workers history --id <worker-id> [--registry <path>]",
  },
  {
    id: "workers:status",
    matches: (args) => args.length >= 2 && args[0] === "workers" && args[1] === "status",
    run: async ({ args, registry }) => {
      const worker = await registry.getWorker(requireOptionValue(args, "--id", "--id <worker-id>"));
      return { status: buildWorkerStatusSummary(worker), worker };
    },
    usage: "quest workers status --id <worker-id> [--registry <path>]",
  },
  {
    id: "workers:summary",
    matches: (args) => args.length >= 2 && args[0] === "workers" && args[1] === "summary",
    run: async ({ registry }) => {
      const workers = await registry.listWorkers();
      return {
        workers: workers.map((worker) => ({
          status: buildWorkerStatusSummary(worker),
          worker,
        })),
      };
    },
    usage: "quest workers summary [--registry <path>]",
  },
  {
    id: "workers:list",
    matches: (args) => args.length >= 2 && args[0] === "workers" && args[1] === "list",
    run: async ({ registry }) => ({ workers: await registry.listWorkers() }),
    usage: "quest workers list [--registry <path>]",
  },
  {
    id: "workers:update",
    matches: (args) => args.length >= 2 && args[0] === "workers" && args[1] === "update",
    run: async ({ args, registry }) => {
      const workerId = requireOptionValue(args, "--id", "--id <worker-id>");
      const worker = await registry.getWorker(workerId);
      const updated = applyWorkerUpdate(worker, parseWorkerUpdate(args));
      return { worker: await registry.upsertWorker(updated) };
    },
    usage:
      "quest workers update --id <worker-id> [--enable|--disable] [--name <name>] [--title <title>] [--class <class>] [--role <builder|tester|hybrid>] [--voice <voice>] [--approach <text>] [--prompt <text>] [--tags <a,b>] [--profile <model>] [--executable <path>] [--base-url <url>] [--allow-tools <a,b>] [--deny-tools <a,b>] [--reasoning-effort <none|minimal|low|medium|high|xhigh>] [--max-output-tokens <n>] [--temperature <n>] [--top-p <n>] [--context-window <n>] [--provider-option <key=value>] [--coding <n>] [--testing <n>] [--docs <n>] [--research <n>] [--speed <n>] [--merge-safety <n>] [--context-endurance <n>] [--cpu-cost <n>] [--memory-cost <n>] [--gpu-cost <n>] [--max-parallel <n>] [--trust-rating <n>] [--level <n>] [--xp <n>] [--registry <path>]",
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

      const plan = planQuest(plannedSpec, selectedWorkers);
      return hasFlag(args, "--explain")
        ? { explanation: buildPlanExplanation(plannedSpec, selectedWorkers), plan }
        : { plan };
    },
    usage: "quest plan --file <path> [--worker-id <worker-id>] [--explain] [--registry <path>]",
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
    id: "runs:pause",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "pause",
    run: async ({ args, runStore }) => ({
      run: await runStore.pauseRun(
        requireOptionValue(args, "--id", "--id <run-id>"),
        findOptionValue(args, "--reason") ?? undefined,
      ),
    }),
    usage:
      "quest runs pause --id <run-id> [--reason <text>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:resume",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "resume",
    run: async ({ args, runStore }) => ({
      run: await runStore.resumeRun(requireOptionValue(args, "--id", "--id <run-id>")),
    }),
    usage:
      "quest runs resume --id <run-id> [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
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
    id: "runs:slices:reassign",
    matches: (args) =>
      args.length >= 4 && args[0] === "runs" && args[1] === "slices" && args[2] === "reassign",
    run: async ({ args, registry, runStore }) => {
      const workerId = requireOptionValue(args, "--worker-id", "--worker-id <worker-id>");
      const worker = await registry.getWorker(workerId);
      return {
        run: await runStore.reassignSlice(
          requireOptionValue(args, "--id", "--id <run-id>"),
          requireOptionValue(args, "--slice", "--slice <slice-id>"),
          worker,
        ),
      };
    },
    usage:
      "quest runs slices reassign --id <run-id> --slice <slice-id> --worker-id <worker-id> [--registry <path>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:slices:retry",
    matches: (args) =>
      args.length >= 4 && args[0] === "runs" && args[1] === "slices" && args[2] === "retry",
    run: async ({ args, runStore }) => ({
      run: await runStore.retrySlice(
        requireOptionValue(args, "--id", "--id <run-id>"),
        requireOptionValue(args, "--slice", "--slice <slice-id>"),
      ),
    }),
    usage:
      "quest runs slices retry --id <run-id> --slice <slice-id> [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:slices:skip",
    matches: (args) =>
      args.length >= 4 && args[0] === "runs" && args[1] === "slices" && args[2] === "skip",
    run: async ({ args, runStore }) => ({
      run: await runStore.skipSlice(
        requireOptionValue(args, "--id", "--id <run-id>"),
        requireOptionValue(args, "--slice", "--slice <slice-id>"),
        findOptionValue(args, "--reason") ?? undefined,
      ),
    }),
    usage:
      "quest runs slices skip --id <run-id> --slice <slice-id> [--reason <text>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
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
