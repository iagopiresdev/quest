#!/usr/bin/env bun

import { unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { confirm as clackConfirm, isCancel } from "@clack/prompts";
import { ZodError } from "zod";
import { generateRunChronicle, writeRunChronicle } from "./core/chronicles/generator";
import {
  daemonStatus,
  type QuestDaemonPartyStatus,
  runDaemonTickLoop,
  runSingleDaemonTick,
  startDaemon,
  stopDaemon,
} from "./core/daemon/lifecycle";
import { QuestDaemonStore } from "./core/daemon/store";
import { isQuestDomainError, QuestDomainError } from "./core/errors";
import { EventDispatcher } from "./core/observability/event-dispatcher";
import { createSinkProbeEvent } from "./core/observability/probe";
import {
  type DeliveryStatus,
  deliveryStatusSchema,
  linearSinkSchema,
  type ObservableEventType,
  observableEventTypeSchema,
  openClawSinkSchema,
  slackSinkSchema,
  telegramSinkSchema,
  webhookSinkSchema,
} from "./core/observability/schema";
import { ObservabilityStore } from "./core/observability/store";
import { type QuestPartyState, QuestPartyStateStore } from "./core/party-state";
import { planQuest, rankTesterWorkersForSlice, rankWorkersForSlice } from "./core/planning/planner";
import { type QuestSpec, questSpecSchema } from "./core/planning/spec-schema";
import { parseOpenClawJsonOutput } from "./core/runs/adapters/openclaw-shared";
import { QuestRunCleanup } from "./core/runs/cleanup";
import { QuestRunExecutor } from "./core/runs/executor";
import { QuestRunIntegrator } from "./core/runs/integrator";
import { QuestRunLander } from "./core/runs/lander";
import { appendEvent } from "./core/runs/lifecycle";
import { QuestRunPipeline } from "./core/runs/pipeline";
import { runSubprocess } from "./core/runs/process";
import { buildProcessEnv } from "./core/runs/process-env";
import { QuestRunRefresher } from "./core/runs/refresher";
import type { QuestRunDocument, QuestRunEvent, QuestRunSliceState } from "./core/runs/schema";
import { QuestRunStore } from "./core/runs/store";
import { type RunUsageSummary, summarizeRunUsage } from "./core/runs/usage";
import { SecretStore } from "./core/secret-store";
import { QuestSettingsStore } from "./core/settings";
import {
  type DetectedCodexSetup,
  type DetectedHermesSetup,
  type DetectedOpenClawSetup,
  detectCodexSetup,
  detectHermesSetup,
  detectOpenClawSetup,
} from "./core/setup/detection";
import { isRecord } from "./core/shared/type-guards";
import {
  ensureDirectory,
  resolveQuestCalibrationsRoot,
  resolveQuestObservabilityConfigPath,
  resolveQuestObservabilityDeliveriesPath,
  resolveQuestPartyStatePath,
  resolveQuestRunsRoot,
  resolveQuestSettingsPath,
  resolveQuestStateRoot,
  resolveQuestWorkspacesRoot,
  resolveWorkerRegistryPath,
} from "./core/storage";
import { renderCategorizedHelp } from "./core/ui/help";
import { formatPrettyStatus } from "./core/ui/terminal";
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
  | "daemon:start"
  | "daemon:status"
  | "daemon:stop"
  | "daemon:tick"
  | "daemon:tick-loop"
  | "doctor"
  | "party:create"
  | "party:bonfire"
  | "party:list"
  | "party:remove"
  | "party:resume"
  | "party:status"
  | "observability:deliveries:list"
  | "observability:deliveries:retry"
  | "observability:events:list"
  | "observability:sinks:list"
  | "observability:sinks:test"
  | "observability:sink:delete"
  | "observability:linear:upsert"
  | "observability:openclaw:upsert"
  | "observability:slack:upsert"
  | "observability:telegram:upsert"
  | "observability:webhook:upsert"
  | "plan"
  | "run"
  | "workspaces:prune"
  | "runs:abort"
  | "runs:babysit"
  | "runs:cancel"
  | "runs:cleanup"
  | "runs:land"
  | "runs:integrate"
  | "runs:pause"
  | "runs:quarantine"
  | "runs:resume"
  | "runs:refresh-base"
  | "runs:rescue"
  | "runs:rerun"
  | "runs:execute"
  | "runs:logs"
  | "runs:list"
  | "runs:slices:reassign"
  | "runs:slices:retry"
  | "runs:slices:skip"
  | "runs:status"
  | "runs:summary"
  | "runs:usage"
  | "runs:validate"
  | "runs:watch"
  | "runs:chronicle"
  | "secrets:delete"
  | "secrets:set"
  | "secrets:status"
  | "setup"
  | "workers:add:codex"
  | "workers:add:hermes"
  | "workers:add:openclaw"
  | "workers:calibrate"
  | "workers:history"
  | "workers:inspect"
  | "workers:remove"
  | "workers:status"
  | "workers:summary"
  | "workers:update"
  | "workers:list"
  | "workers:upsert";

type QuestCliContext = {
  args: string[];
  calibrator: WorkerCalibrator;
  daemonStore: QuestDaemonStore;
  dispatcher: EventDispatcher;
  observabilityStore: ObservabilityStore;
  outputMode: OutputMode;
  partyStateStore: QuestPartyStateStore;
  runCleanup: QuestRunCleanup;
  registry: WorkerRegistry;
  runExecutor: QuestRunExecutor;
  runIntegrator: QuestRunIntegrator;
  runRefresher: QuestRunRefresher;
  runLander: QuestRunLander;
  runPipeline: QuestRunPipeline;
  runStore: QuestRunStore;
  settingsStore: QuestSettingsStore;
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
    landedAt: string | null;
    rescueNote: string | null;
    rescueStatus: string;
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

type PartyStateView = {
  events: QuestPartyState["events"];
  reason: string | null;
  status: QuestPartyState["status"];
  updatedAt: string;
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

function printCategorizedHelp(): void {
  void Bun.write(Bun.stdout, renderCategorizedHelp());
}

function stdinIsTty(): boolean {
  return Bun.env.QUEST_RUNNER_FORCE_INTERACTIVE === "1" || process.stdin.isTTY === true;
}

function stdoutIsTty(): boolean {
  return Bun.env.QUEST_RUNNER_FORCE_INTERACTIVE === "1" || process.stdout.isTTY === true;
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

function shouldImportExisting(args: string[]): boolean {
  return !hasFlag(args, "--no-import-existing");
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
      testerCandidates: rankTesterWorkersForSlice(
        slice,
        workers,
        undefined,
        spec.execution.testerSelectionStrategy,
      ).map((assignment) => ({
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

type LinearStateFlagKey = "blocked" | "dispatched" | "failed" | "in_review" | "landed" | "testing";

// Parse the six `--state-<phase>` flags into a LinearStateMap. Absent flags stay undefined
// (default behavior); explicit `none` strings opt out of transitions for that event type
// (stored as null). Daemon-level: dispatched, landed, failed. Run-level: testing, in_review,
// blocked.
function parseLinearStateMapFlags(
  args: string[],
): Partial<Record<LinearStateFlagKey, string | null>> | undefined {
  const entries: Array<[LinearStateFlagKey, string]> = [
    ["dispatched", "--state-dispatched"],
    ["landed", "--state-landed"],
    ["failed", "--state-failed"],
    ["testing", "--state-testing"],
    ["in_review", "--state-in-review"],
    ["blocked", "--state-blocked"],
  ];
  const map: Partial<Record<LinearStateFlagKey, string | null>> = {};
  let anySet = false;
  for (const [key, flag] of entries) {
    const value = findOptionValue(args, flag);
    if (value === undefined) {
      continue;
    }
    anySet = true;
    map[key] = value === "none" ? null : value;
  }
  return anySet ? map : undefined;
}

function parseDeliveryStatus(value: string | undefined): DeliveryStatus | undefined {
  return value ? deliveryStatusSchema.parse(value) : undefined;
}

function parseRescueStatus(value: string): "abandoned" | "pending" | "rescued" | "unset" {
  if (value === "abandoned" || value === "pending" || value === "rescued" || value === "unset") {
    return value;
  }

  throw new Error(`Invalid rescue status: ${value}`);
}

function parseDurationToMilliseconds(value: string): number {
  const match = value.trim().match(/^(\d+)(ms|s|m|h|d)$/i);
  if (!match) {
    throw new Error(`Invalid duration: ${value}`);
  }

  const amount = Number.parseInt(match[1] ?? "0", 10);
  const unit = (match[2] ?? "").toLowerCase();
  const multipliers: Record<string, number> = {
    d: 24 * 60 * 60 * 1000,
    h: 60 * 60 * 1000,
    m: 60 * 1000,
    ms: 1,
    s: 1000,
  };
  return amount * (multipliers[unit] ?? 0);
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return parsed;
}

function parsePruneStatuses(
  value: string | undefined,
):
  | Array<"aborted" | "completed" | "failed" | "integrated" | "landed" | "orphaned" | "rescued">
  | undefined {
  if (!value) {
    return undefined;
  }

  const allowed = new Set([
    "aborted",
    "completed",
    "failed",
    "integrated",
    "landed",
    "orphaned",
    "rescued",
  ]);

  return parseCommaSeparatedValues(value).map((entry) => {
    if (!allowed.has(entry)) {
      throw new Error(`Invalid workspace prune status: ${entry}`);
    }

    return entry as
      | "aborted"
      | "completed"
      | "failed"
      | "integrated"
      | "landed"
      | "orphaned"
      | "rescued";
  });
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

// Parse a text blob as JSON first, then retry as YAML when JSON rejects the first token.
// YAML is a superset of JSON for most operator-written specs, so this preserves the JSON
// fast path while giving YAML specs on --stdin the same ergonomics as --file spec.yaml.
function parseStructuredText(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (jsonError: unknown) {
    try {
      return Bun.YAML.parse(raw) as unknown;
    } catch {
      throw jsonError;
    }
  }
}

async function readJsonInput(args: string[]): Promise<unknown> {
  const filePath = findOptionValue(args, "--file");
  const useStdin = hasFlag(args, "--stdin");

  if (filePath) {
    const raw = await Bun.file(filePath).text();
    if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
      return Bun.YAML.parse(raw) as unknown;
    }
    return parseStructuredText(raw);
  }

  if (useStdin || !stdinIsTty()) {
    const raw = await readStdin();
    return parseStructuredText(raw);
  }

  throw new Error("Expected --file <path> or --stdin");
}

async function readQuestSpecInput(
  args: string[],
  settingsStore: QuestSettingsStore,
): Promise<QuestSpec> {
  const rawInput = await readJsonInput(args);
  const settings = await settingsStore.readSettings();
  if (!isRecord(rawInput)) {
    return questSpecSchema.parse(rawInput);
  }

  const execution = isRecord(rawInput.execution) ? rawInput.execution : {};

  return questSpecSchema.parse({
    ...rawInput,
    execution: {
      testerSelectionStrategy: settings.planner.testerSelectionStrategy,
      ...execution,
    },
  });
}

async function confirmWithDefault(question: string, fallback: boolean): Promise<boolean> {
  const answer = await clackConfirm({ initialValue: fallback, message: question });
  if (isCancel(answer)) {
    throw new Error(`Cancelled: ${question}`);
  }
  return answer;
}

function describeImportedBackendDefaults(
  backend: string,
  imported: DetectedCodexSetup | DetectedHermesSetup | DetectedOpenClawSetup | null,
): string | undefined {
  if (!imported) {
    return undefined;
  }

  if (backend === "codex") {
    const codex = imported as DetectedCodexSetup;
    if (codex.loginOk) {
      return `Codex login active via ${codex.executable}`;
    }

    if (codex.envVar) {
      return `Codex API key imported from ${codex.envVar}`;
    }

    return `Codex executable detected at ${codex.executable}`;
  }

  if (backend === "hermes") {
    const hermes = imported as DetectedHermesSetup;
    if (!hermes.ok) {
      return `Hermes probe failed for ${hermes.baseUrl}`;
    }
    return `Hermes models discovered at ${hermes.baseUrl}${hermes.profile ? ` (${hermes.profile})` : ""}`;
  }

  const openClaw = imported as DetectedOpenClawSetup;
  if (!openClaw.ok) {
    return `OpenClaw detected at ${openClaw.executable}`;
  }
  return `OpenClaw agent ${openClaw.agentId ?? "unknown"}${openClaw.profile ? ` on ${openClaw.profile}` : ""}`;
}

function asCodexSetup(
  imported: DetectedCodexSetup | DetectedHermesSetup | DetectedOpenClawSetup | null,
): DetectedCodexSetup | null {
  return imported && "loginOk" in imported ? imported : null;
}

function asHermesSetup(
  imported: DetectedCodexSetup | DetectedHermesSetup | DetectedOpenClawSetup | null,
): DetectedHermesSetup | null {
  return imported && "models" in imported ? imported : null;
}

function asOpenClawSetup(
  imported: DetectedCodexSetup | DetectedHermesSetup | DetectedOpenClawSetup | null,
): DetectedOpenClawSetup | null {
  return imported && "agents" in imported ? imported : null;
}

async function detectBackendDefaults(
  backend: string,
  args: string[],
): Promise<DetectedCodexSetup | DetectedHermesSetup | DetectedOpenClawSetup | null> {
  if (!shouldImportExisting(args)) {
    return null;
  }

  if (backend === "codex") {
    if (
      findOptionValue(args, "--profile") &&
      findOptionValue(args, "--auth-mode") &&
      findOptionValue(args, "--executable")
    ) {
      return null;
    }
    return await detectCodexSetup(
      findOptionValue(args, "--executable") ?? findOptionValue(args, "--codex-executable"),
    );
  }

  if (backend === "hermes") {
    if (findOptionValue(args, "--base-url") && findOptionValue(args, "--profile")) {
      return null;
    }
    return await detectHermesSetup(
      findOptionValue(args, "--base-url") ?? findOptionValue(args, "--hermes-base-url"),
    );
  }

  if (backend === "openclaw") {
    if (
      (findOptionValue(args, "--agent-id") || findOptionValue(args, "--session-id")) &&
      findOptionValue(args, "--profile")
    ) {
      return null;
    }
    const options: Parameters<typeof detectOpenClawSetup>[0] = {};
    const agentId = findOptionValue(args, "--agent-id");
    const executable =
      findOptionValue(args, "--executable") ?? findOptionValue(args, "--openclaw-executable");
    const gatewayUrl = findOptionValue(args, "--gateway-url");
    if (agentId) {
      options.agentId = agentId;
    }
    if (executable) {
      options.executable = executable;
    }
    if (gatewayUrl) {
      options.gatewayUrl = gatewayUrl;
    }
    return await detectOpenClawSetup(options);
  }

  return null;
}

function splitCommandLine(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of value.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error("Unclosed quote in --command");
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  if (tokens.length === 0) {
    throw new Error("Expected --command <command>");
  }
  return tokens;
}

function buildStandaloneWorker(args: string[]): RegisteredWorker {
  const name = findOptionValue(args, "--name") ?? "Standalone Worker";
  const commandArgs = findOptionValues(args, "--command-arg");
  const command =
    commandArgs.length > 0
      ? commandArgs
      : splitCommandLine(requireOptionValue(args, "--command", "--command <command>"));
  const runtime = parseWorkerRuntime(args);
  const baseWorker = registeredWorkerSchema.parse({
    backend: {
      adapter: "local-command",
      command,
      profile: findOptionValue(args, "--profile") ?? "standalone",
      ...(runtime ? { runtime } : {}),
      runner: "custom",
      toolPolicy: {
        allow: parseCommaSeparatedValues(findOptionValue(args, "--allow-tools")),
        deny: parseCommaSeparatedValues(findOptionValue(args, "--deny-tools")),
      },
    },
    calibration: {
      history: [],
    },
    class: "operator",
    enabled: true,
    id: findOptionValue(args, "--id") ?? slugifyWorkerId(name, "standalone-worker"),
    name,
    persona: {
      approach: "run the configured local command and report only durable changes",
      prompt: "Consume the quest-runner JSON payload from stdin and make the requested change.",
      voice: "direct",
    },
    progression: { level: 1, xp: 0 },
    role: workerRoleSchema.parse(findOptionValue(args, "--role") ?? "hybrid"),
    resources: { cpuCost: 1, gpuCost: 0, maxParallel: 1, memoryCost: 1 },
    stats: {
      coding: 70,
      contextEndurance: 55,
      docs: 45,
      mergeSafety: 70,
      research: 45,
      speed: 60,
      testing: 65,
    },
    tags: parseCommaSeparatedValues(findOptionValue(args, "--tags") ?? "standalone"),
    title: "Standalone Worker",
    trust: { calibratedAt: new Date().toISOString(), rating: 0.7 },
  });
  return applyWorkerUpdate(baseWorker, parseWorkerUpdate(args));
}

function buildWorkerFromDetectedBackend(
  backend: string,
  args: string[],
  importedDefaults: DetectedCodexSetup | DetectedHermesSetup | DetectedOpenClawSetup | null,
): RegisteredWorker {
  if (backend === "codex") {
    return buildCodexWorker(args, asCodexSetup(importedDefaults));
  }

  if (backend === "hermes") {
    return buildHermesWorker(args, asHermesSetup(importedDefaults));
  }

  if (backend === "standalone") {
    return buildStandaloneWorker(args);
  }

  return buildOpenClawWorker(args, asOpenClawSetup(importedDefaults));
}

async function runSetupCalibrations(
  calibrator: WorkerCalibrator,
  createdWorkers: RegisteredWorker[],
  calibrateWorkerIds: string[],
): Promise<Array<{ runId: string; status: string; workerId: string }>> {
  const calibrationResults: Array<{ runId: string; status: string; workerId: string }> = [];
  for (const worker of createdWorkers) {
    if (!calibrateWorkerIds.includes(worker.id)) {
      continue;
    }

    const result = await calibrator.calibrateWorker(worker.id);
    calibrationResults.push({
      runId: result.run.id,
      status: result.calibration.status,
      workerId: result.worker.id,
    });
  }
  return calibrationResults;
}

function buildNonInteractiveSetupWorkerArgs(
  args: string[],
  backend: string,
  workerName: string,
  profile: string,
  baseUrl: string,
  agentId: string,
  importedCodex: DetectedCodexSetup | null,
): string[] {
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
    workerArgs.push(
      "--auth-mode",
      findOptionValue(args, "--auth-mode") ?? importedCodex?.authMode ?? "native-login",
    );
  } else if (backend === "hermes" || backend === "openclaw") {
    pushOption(workerArgs, "--auth-mode", findOptionValue(args, "--auth-mode"));
  }
  pushOption(workerArgs, "--env-var", findOptionValue(args, "--env-var") ?? importedCodex?.envVar);
  pushOption(workerArgs, "--secret-ref", findOptionValue(args, "--secret-ref"));
  pushOption(workerArgs, "--target-env-var", findOptionValue(args, "--target-env-var"));
  pushOption(workerArgs, "--title", findOptionValue(args, "--title"));
  pushOption(workerArgs, "--class", findOptionValue(args, "--class"));
  pushOption(workerArgs, "--role", findOptionValue(args, "--role"));
  pushOption(workerArgs, "--voice", findOptionValue(args, "--voice"));
  pushOption(workerArgs, "--approach", findOptionValue(args, "--approach"));
  pushOption(workerArgs, "--prompt", findOptionValue(args, "--prompt"));
  pushOption(workerArgs, "--command", findOptionValue(args, "--command"));
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
  findOptionValues(args, "--command-arg").forEach((entry) => {
    workerArgs.push("--command-arg", entry);
  });
  return workerArgs;
}

type SetupPaths = {
  calibrationsRoot: string;
  observabilityConfigPath: string;
  observabilityDeliveriesPath: string;
  registryPath: string;
  runsRoot: string;
  settingsPath: string;
  stateRoot: string;
  workspacesRoot: string;
};

type SetupImports = {
  backend: string;
  importedCodex: DetectedCodexSetup | null;
  importedDefaults: DetectedCodexSetup | DetectedHermesSetup | DetectedOpenClawSetup | null;
  importedHermes: DetectedHermesSetup | null;
  importedOpenClaw: DetectedOpenClawSetup | null;
  importedSummary: string | undefined;
};

type SetupWorkerState = {
  createdWorker: RegisteredWorker | null;
  createdWorkers: RegisteredWorker[];
};

function resolveSetupPaths(args: string[]): SetupPaths {
  const stateRootOption = findOptionValue(args, "--state-root");
  const stateRoot = resolveQuestStateRoot(stateRootOption);

  return {
    calibrationsRoot: resolveQuestCalibrationsRoot(
      definedPathOptions(
        stateRoot,
        "explicitCalibrationsRoot",
        findOptionValue(args, "--calibrations-root"),
      ),
    ),
    observabilityConfigPath: resolveQuestObservabilityConfigPath(
      definedPathOptions(
        stateRoot,
        "explicitObservabilityConfigPath",
        findOptionValue(args, "--observability-config"),
      ),
    ),
    observabilityDeliveriesPath: resolveQuestObservabilityDeliveriesPath(
      definedPathOptions(
        stateRoot,
        "explicitObservabilityDeliveriesPath",
        findOptionValue(args, "--observability-deliveries"),
      ),
    ),
    registryPath: resolveWorkerRegistryPath(
      definedPathOptions(stateRoot, "explicitRegistryPath", findOptionValue(args, "--registry")),
    ),
    runsRoot: resolveQuestRunsRoot(
      definedPathOptions(stateRoot, "explicitRunsRoot", findOptionValue(args, "--runs-root")),
    ),
    settingsPath: resolveQuestSettingsPath(
      definedPathOptions(stateRoot, "explicitSettingsPath", findOptionValue(args, "--settings")),
    ),
    stateRoot,
    workspacesRoot: resolveQuestWorkspacesRoot(
      definedPathOptions(
        stateRoot,
        "explicitWorkspacesRoot",
        findOptionValue(args, "--workspaces-root"),
      ),
    ),
  };
}

async function detectSetupImports(args: string[]): Promise<SetupImports> {
  const backend = findOptionValue(args, "--backend") ?? "codex";
  const importedDefaults = await detectBackendDefaults(backend, args);
  const shouldImportOpenClawDefaults =
    shouldImportExisting(args) &&
    (backend === "openclaw" ||
      findOptionValue(args, "--agent-id") !== undefined ||
      findOptionValue(args, "--openclaw-executable") !== undefined ||
      findOptionValue(args, "--gateway-url") !== undefined);
  const openClawOptions: Parameters<typeof detectOpenClawSetup>[0] = {};
  const preferredAgentId = findOptionValue(args, "--agent-id");
  const openClawExecutable =
    findOptionValue(args, "--executable") ?? findOptionValue(args, "--openclaw-executable");
  const openClawGatewayUrl = findOptionValue(args, "--gateway-url");
  if (preferredAgentId) {
    openClawOptions.agentId = preferredAgentId;
  }
  if (openClawExecutable) {
    openClawOptions.executable = openClawExecutable;
  }
  if (openClawGatewayUrl) {
    openClawOptions.gatewayUrl = openClawGatewayUrl;
  }
  const importedOpenClaw =
    asOpenClawSetup(importedDefaults) ??
    (shouldImportOpenClawDefaults ? await detectOpenClawSetup(openClawOptions) : null);
  return {
    backend,
    importedCodex: asCodexSetup(importedDefaults),
    importedDefaults,
    importedHermes: asHermesSetup(importedDefaults),
    importedOpenClaw,
    importedSummary: describeImportedBackendDefaults(backend, importedDefaults),
  };
}

function shouldCreateSetupWorker(
  backend: string,
  args: string[],
  doctorChecks: DoctorCheck[],
  importedCodex: DetectedCodexSetup | null,
): boolean {
  if (hasFlag(args, "--create-worker")) {
    return true;
  }

  if (hasFlag(args, "--skip-worker")) {
    return false;
  }

  if (backend === "codex") {
    return (
      checkOk(doctorChecks, "codex-binary") &&
      (checkOk(doctorChecks, "codex-login") || importedCodex?.authMode === "env-var")
    );
  }

  if (backend === "hermes") {
    return checkOk(doctorChecks, "hermes-api");
  }

  if (backend === "standalone") {
    return (
      findOptionValue(args, "--command") !== undefined ||
      findOptionValues(args, "--command-arg").length > 0
    );
  }

  return checkOk(doctorChecks, "openclaw-binary") && checkOk(doctorChecks, "openclaw-status");
}

function shouldRunSetupCalibration(args: string[]): boolean {
  if (hasFlag(args, "--skip-calibration")) {
    return false;
  }
  return hasFlag(args, "--calibrate") || hasFlag(args, "--training");
}

type NonInteractiveSetupInputs = {
  agentId: string;
  baseUrl: string;
  createWorker: boolean;
  profile: string;
  workerName: string;
};

async function resolveNonInteractiveSetupInputs(
  args: string[],
  backend: string,
  importedHermes: DetectedHermesSetup | null,
  importedOpenClaw: DetectedOpenClawSetup | null,
): Promise<NonInteractiveSetupInputs> {
  const workerName = findOptionValue(args, "--worker-name") ?? defaultSetupWorkerName(backend);
  const profile =
    findOptionValue(args, "--profile") ??
    importedHermes?.profile ??
    importedOpenClaw?.profile ??
    defaultSetupProfile(backend);
  const baseUrl =
    findOptionValue(args, "--base-url") ??
    findOptionValue(args, "--hermes-base-url") ??
    importedHermes?.baseUrl ??
    importedOpenClaw?.gatewayUrl ??
    "http://127.0.0.1:8000/v1";
  const agentId = findOptionValue(args, "--agent-id") ?? importedOpenClaw?.agentId ?? "main";

  return {
    agentId,
    baseUrl,
    createWorker: true,
    profile,
    workerName,
  };
}

async function runNonInteractiveSetupFlow(
  args: string[],
  backend: string,
  importedCodex: DetectedCodexSetup | null,
  importedDefaults: DetectedCodexSetup | DetectedHermesSetup | DetectedOpenClawSetup | null,
  importedHermes: DetectedHermesSetup | null,
  importedOpenClaw: DetectedOpenClawSetup | null,
  registry: WorkerRegistry,
): Promise<SetupWorkerState> {
  const inputs = await resolveNonInteractiveSetupInputs(
    args,
    backend,
    importedHermes,
    importedOpenClaw,
  );
  if (!inputs.createWorker) {
    return {
      createdWorker: null,
      createdWorkers: [],
    };
  }

  const workerArgs = buildNonInteractiveSetupWorkerArgs(
    args,
    backend,
    inputs.workerName,
    inputs.profile,
    inputs.baseUrl,
    inputs.agentId,
    importedCodex,
  );
  const createdWorker = await registry.upsertWorker(
    registeredWorkerSchema.parse(
      buildWorkerFromDetectedBackend(backend, workerArgs, importedDefaults),
    ),
  );

  return {
    createdWorker,
    createdWorkers: [createdWorker],
  };
}

function buildCodexWorker(args: string[], detected?: DetectedCodexSetup | null): RegisteredWorker {
  const name = findOptionValue(args, "--name") ?? "Codex Worker";
  const authMode = findOptionValue(args, "--auth-mode") ?? detected?.authMode ?? "native-login";
  const targetEnvVar = findOptionValue(args, "--target-env-var") ?? "OPENAI_API_KEY";
  let auth: Parameters<typeof createCodexWorkerPreset>[0]["auth"];
  if (authMode === "env-var") {
    auth = {
      envVar: findOptionValue(args, "--env-var") ?? detected?.envVar ?? "OPENAI_API_KEY",
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
    executable:
      findOptionValue(args, "--executable") ??
      detected?.executable ??
      Bun.env.QUEST_RUNNER_CODEX_EXECUTABLE,
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

function buildHermesWorker(
  args: string[],
  detected?: DetectedHermesSetup | null,
): RegisteredWorker {
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
    baseUrl: findOptionValue(args, "--base-url") ?? detected?.baseUrl ?? "http://127.0.0.1:8000/v1",
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
  if (profile ?? detected?.profile) input.profile = profile ?? detected?.profile ?? undefined;
  if (prompt) input.prompt = prompt;
  if (title) input.title = title;
  if (voice) input.voice = voice;
  if (workerClass) input.workerClass = workerClass;

  return applyWorkerUpdate(createHermesWorkerPreset(input), parseWorkerUpdate(args));
}

function buildOpenClawWorker(
  args: string[],
  detected?: DetectedOpenClawSetup | null,
): RegisteredWorker {
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

  const agentId = findOptionValue(args, "--agent-id") ?? detected?.agentId ?? "main";
  const input: Parameters<typeof createOpenClawWorkerPreset>[0] = {
    agentId,
    ...(auth ? { auth } : {}),
    executable:
      findOptionValue(args, "--executable") ??
      detected?.executable ??
      Bun.env.QUEST_RUNNER_OPENCLAW_EXECUTABLE,
    gatewayUrl:
      findOptionValue(args, "--gateway-url") ??
      detected?.gatewayUrl ??
      Bun.env.OPENCLAW_GATEWAY_URL,
    id: findOptionValue(args, "--id") ?? slugifyWorkerId(name, "openclaw-worker"),
    ...(hasFlag(args, "--local") ? { local: true } : {}),
    name,
    profile: findOptionValue(args, "--profile") ?? detected?.profile ?? `openclaw/${agentId}`,
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

  if (backend === "standalone") {
    return "Standalone Worker";
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

  if (backend === "standalone") {
    return "standalone";
  }

  return "gpt-5.4";
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
  if (run.landedAt) {
    integrationStatus = "landed";
  } else if (run.events.some((event) => event.type === "run_integrated")) {
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
      landedAt: run.landedAt ?? null,
      rescueNote: run.integrationRescueNote ?? null,
      rescueStatus: run.integrationRescueStatus ?? "unset",
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

function summarizePartyState(state: QuestPartyState): PartyStateView {
  return {
    events: state.events,
    reason: state.reason ?? null,
    status: state.status,
    updatedAt: state.updatedAt,
  };
}

async function summarizeDaemonParty(
  daemonStore: QuestDaemonStore,
  partyName: string,
): Promise<QuestDaemonPartyStatus> {
  await daemonStore.getParty(partyName);
  const status = await daemonStatus(daemonStore);
  const party = status.parties.find((candidate) => candidate.party.name === partyName);
  if (!party) {
    throw new QuestDomainError({
      code: "quest_daemon_party_not_found",
      details: { name: partyName },
      message: `Quest daemon party ${partyName} was not found`,
      statusCode: 1,
    });
  }

  return party;
}

// Party-admin CLI handlers emit a best-effort daemon event so observability sinks see party
// create/bonfire/resume transitions even though they happen outside the tick loop. Sink failures
// must never bubble up from an operator command; delivery failures are already persisted.
async function safeDispatchPartyAdminEvent(
  dispatcher: EventDispatcher,
  input: {
    eventType: "daemon_party_created" | "daemon_party_resting" | "daemon_party_resumed";
    partyName: string;
    reason?: string | null | undefined;
  },
): Promise<void> {
  try {
    await dispatcher.dispatchDaemon({
      at: new Date().toISOString(),
      eventType: input.eventType,
      partyName: input.partyName,
      reason: input.reason ?? undefined,
    });
  } catch {
    // Sink errors are recorded in delivery records; the operator command still succeeds.
  }
}

async function dispatchResultEvents(value: unknown, dispatcher: EventDispatcher): Promise<void> {
  if (!isRecord(value)) {
    return;
  }

  const runCandidate = value.run;
  if (isRecord(runCandidate) && "events" in runCandidate) {
    await dispatcher.dispatchRun(runCandidate as QuestRunDocument);
  }

  const resultCandidate = value.result;
  if (isRecord(resultCandidate) && "run" in resultCandidate) {
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

async function testObservabilitySinks(
  dispatcher: EventDispatcher,
  observabilityStore: ObservabilityStore,
  options: { label: string; sinkId?: string | undefined } = { label: "doctor" },
): Promise<DoctorCheck[]> {
  const sinks = await observabilityStore.listSinks();
  const selectedSinks = options.sinkId
    ? sinks.filter((sink) => sink.id === options.sinkId)
    : sinks.filter((sink) => sink.enabled);

  if (options.sinkId && selectedSinks.length === 0) {
    return [
      {
        details: { sinkId: options.sinkId },
        name: "sink-probe",
        ok: false,
      },
    ];
  }

  const checks: DoctorCheck[] = [];
  for (const sink of selectedSinks) {
    const attempts = await dispatcher.dispatchProbe(createSinkProbeEvent(options.label), {
      sinkId: sink.id,
    });
    const attempt = attempts[0];
    checks.push({
      details: {
        sinkId: sink.id,
        sinkType: sink.type,
        status: attempt?.status ?? "skipped",
      },
      name: `sink:${sink.id}`,
      ok: attempt?.ok === true,
    });
  }

  return checks;
}

async function runDoctor(
  args: string[],
  dispatcher: EventDispatcher,
  observabilityStore: ObservabilityStore,
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
  const shouldTestSinks = hasFlag(args, "--test-sinks");
  const sinkId = findOptionValue(args, "--sink-id") ?? undefined;
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

  if (shouldTestSinks) {
    checks.push(
      ...(await testObservabilitySinks(dispatcher, observabilityStore, {
        label: "doctor",
        sinkId,
      })),
    );
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
    | "explicitSettingsPath"
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
  calibrator: WorkerCalibrator,
  observabilityStore: ObservabilityStore,
  registry: WorkerRegistry,
  settingsStore: QuestSettingsStore,
  secretStore: SecretStore,
): Promise<Record<string, unknown>> {
  const paths = resolveSetupPaths(args);

  const doctor = (await runDoctor(
    args,
    new EventDispatcher(observabilityStore, secretStore),
    observabilityStore,
    secretStore,
    paths.stateRoot,
    paths.calibrationsRoot,
    paths.observabilityConfigPath,
    paths.observabilityDeliveriesPath,
    paths.runsRoot,
    paths.workspacesRoot,
    paths.registryPath,
  )) as {
    checks: DoctorCheck[];
    ok: boolean;
  };

  const setupImports = await detectSetupImports(args);
  const shouldCreateWorker = shouldCreateSetupWorker(
    setupImports.backend,
    args,
    doctor.checks,
    setupImports.importedCodex,
  );

  let workerState: SetupWorkerState = {
    createdWorker: null,
    createdWorkers: [],
  };
  let calibrationResults: Array<{ runId: string; status: string; workerId: string }> = [];
  const configuredSink: Record<string, unknown> | null = null;
  let settings = await settingsStore.readSettings();

  const testerSelection = findOptionValue(args, "--tester-selection");
  if (testerSelection === "balanced" || testerSelection === "prefer-cheapest") {
    settings = await settingsStore.writeSettings({
      planner: {
        testerSelectionStrategy: testerSelection,
      },
    });
  }
  if (shouldCreateWorker) {
    workerState = await runNonInteractiveSetupFlow(
      args,
      setupImports.backend,
      setupImports.importedCodex,
      setupImports.importedDefaults,
      setupImports.importedHermes,
      setupImports.importedOpenClaw,
      registry,
    );
    if (shouldRunSetupCalibration(args)) {
      calibrationResults = await runSetupCalibrations(
        calibrator,
        workerState.createdWorkers,
        workerState.createdWorkers.map((worker) => worker.id),
      );
    }
  }

  return {
    createdWorker: workerState.createdWorker,
    createdWorkers: workerState.createdWorkers,
    calibrationResults,
    configuredSink,
    doctor,
    imports:
      setupImports.importedDefaults === null
        ? null
        : {
            backend: setupImports.backend,
            summary: setupImports.importedSummary ?? null,
          },
    paths,
    settings,
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
  bonfire: "Bonfire",
  bossFight: "Boss Fight",
  briefing: "Briefing",
  encounter: "Encounter",
  encounters: "Encounters",
  heartbeat: "Heartbeat",
  party: "Party",
  partySelection: "Party Selection",
  quest: "Quest",
  questStatus: "Quest Status",
  questLog: "Quest Log",
  roster: "Roster",
  trainingGrounds: "Training Grounds",
  turnIn: "Turn-in",
  trial: "Trial",
  trials: "Trials",
  wave: "Wave",
} as const;

function formatPartyStatePretty(
  partyState: PartyStateView,
  options: { includeEvents?: boolean | undefined } = {},
): string[] {
  const headline =
    partyState.status === "resting" ? "The party rests at a bonfire." : "The party presses on.";
  const lines = [
    `${prettyLabels.party}: ${partyState.status}`,
    `  status line: ${headline}`,
    `  updated at: ${partyState.updatedAt}`,
  ];
  if (partyState.reason) {
    lines.push(`  reason: ${partyState.reason}`);
  }
  if (options.includeEvents) {
    lines.push(
      ...partyState.events
        .slice(-5)
        .map(
          (event) =>
            `  event: ${event.type} @ ${event.at}${event.reason ? ` | ${event.reason}` : ""}`,
        ),
    );
  }
  return lines;
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
  return `${formatPrettyStatus(check.ok ? "ok" : "fail")} ${check.name}${detailText}`;
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

function sliceStatusToPrettyKind(status: string): "fail" | "info" | "ok" | "warn" {
  if (status === "completed") {
    return "ok";
  }
  if (status === "failed") {
    return "fail";
  }
  if (status === "blocked" || status === "aborted") {
    return "warn";
  }
  return "info";
}

function formatRunSummaryBlock(
  summary: ReturnType<typeof summarizeRunDetail>,
  partyState?: PartyStateView | undefined,
): string[] {
  // Turn-in status reflects whether landing finished, not whether boss-fight integration
  // succeeded. Keep the boss-fight value visible through bossFightStatus instead of collapsing
  // both into this single line.
  let turnInStatus: "pending" | "in_progress" | "ready_to_land" | "landed" | "failed" = "pending";
  switch (summary.integration.status) {
    case "landed":
      turnInStatus = "landed";
      break;
    case "integrated":
      turnInStatus = "ready_to_land";
      break;
    case "started":
      turnInStatus = "in_progress";
      break;
    case "failed":
      turnInStatus = "failed";
      break;
    case "not_started":
      turnInStatus = "pending";
      break;
  }
  let questStatus: "fail" | "info" | "ok" = "info";
  if (summary.status === "completed") {
    questStatus = "ok";
  } else if (summary.status === "failed") {
    questStatus = "fail";
  }

  let bossFightStatus: "fail" | "info" | "ok" = "info";
  if (summary.integration.status === "failed") {
    bossFightStatus = "fail";
  } else if (
    summary.integration.status === "integrated" ||
    summary.integration.status === "landed"
  ) {
    bossFightStatus = "ok";
  }
  return [
    ...(partyState ? [...formatPartyStatePretty(partyState), ""] : []),
    `${formatPrettyStatus(questStatus)} ${prettyLabels.quest} ${summary.id}`,
    `  ${prettyLabels.briefing}: ${summary.title}`,
    `  ${prettyLabels.questStatus}: ${summary.status}`,
    `  Updated: ${summary.updatedAt}`,
    `  ${prettyLabels.party}: ${summary.waves} wave(s)`,
    `  ${prettyLabels.encounters}: ${formatCountMap(summary.counts.slices)}`,
    `  ${prettyLabels.bossFight}: ${formatPrettyStatus(bossFightStatus)} ${summary.integration.status} (${formatCountMap(summary.counts.integration)})`,
    `  ${prettyLabels.turnIn}: ${turnInStatus}`,
    `  Rescue: ${summary.integration.rescueStatus}`,
    ...(summary.integration.rescueNote ? [`  Rescue Note: ${summary.integration.rescueNote}`] : []),
    ...(summary.integration.targetRef ? [`  Target Ref: ${summary.integration.targetRef}`] : []),
    ...(summary.integration.landedAt ? [`  Landed At: ${summary.integration.landedAt}`] : []),
    ...summary.slices.map((slice) => {
      const sliceStatus = sliceStatusToPrettyKind(slice.status);
      return `  ${formatPrettyStatus(sliceStatus)} ${prettyLabels.encounter}=${slice.id} [${slice.status}] | Builder=${slice.builderWorkerId ?? "unassigned"} | Tester=${slice.testerWorkerId ?? "unassigned"} | ${prettyLabels.bossFight}=${slice.integrationStatus}`;
    }),
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

function formatWorkerInspectPretty(worker: RegisteredWorker, status: WorkerStatusSummary): string {
  const runtime = worker.backend.runtime;
  return [
    `Party Member ${worker.id}`,
    `  name: ${worker.name}`,
    `  title: ${worker.title}`,
    `  class: ${worker.class}`,
    `  role: ${worker.role}`,
    `  backend: ${worker.backend.runner}/${worker.backend.adapter}`,
    `  profile: ${worker.backend.profile}`,
    `  enabled: ${worker.enabled}`,
    `  trust: ${worker.trust.rating.toFixed(2)}`,
    `  level/xp: ${worker.progression.level}/${worker.progression.xp}`,
    `  tags: ${worker.tags.join(", ") || "none"}`,
    `  strengths: ${status.strengths.map((entry) => `${entry.key}=${entry.score}`).join(", ")}`,
    ...(worker.backend.agentId ? [`  agent: ${worker.backend.agentId}`] : []),
    ...(worker.backend.baseUrl ? [`  baseUrl: ${worker.backend.baseUrl}`] : []),
    ...(worker.backend.gatewayUrl ? [`  gatewayUrl: ${worker.backend.gatewayUrl}`] : []),
    ...(worker.backend.executable ? [`  executable: ${worker.backend.executable}`] : []),
    ...(runtime
      ? [
          `  runtime: reasoning=${runtime.reasoningEffort ?? "default"}, maxOutputTokens=${runtime.maxOutputTokens ?? "default"}, temperature=${runtime.temperature ?? "default"}, topP=${runtime.topP ?? "default"}, contextWindow=${runtime.contextWindow ?? "default"}`,
          `  providerOptions: ${Object.keys(runtime.providerOptions).length > 0 ? JSON.stringify(runtime.providerOptions) : "{}"}`,
        ]
      : ["  runtime: default"]),
  ].join("\n");
}

function formatPlanWarningPretty(warning: {
  code: string;
  message: string;
  paths?: string[] | undefined;
  relatedSliceIds?: string[] | undefined;
  sliceId: string;
}): string {
  const details = [
    warning.relatedSliceIds && warning.relatedSliceIds.length > 0
      ? `slices=${warning.relatedSliceIds.join(",")}`
      : `slice=${warning.sliceId}`,
    warning.paths && warning.paths.length > 0 ? `paths=${warning.paths.join(",")}` : null,
  ]
    .filter((entry) => entry !== null)
    .join(" | ");

  return `  - warning [${warning.code}] ${warning.message}${details.length > 0 ? ` (${details})` : ""}`;
}

function formatPlanPretty(candidate: Record<string, unknown>, fallback: unknown): string {
  const plan = candidate.plan as
    | {
        unassigned: Array<{ id: string; message?: string; reason?: string }>;
        warnings: Array<{
          code: string;
          message: string;
          paths?: string[];
          relatedSliceIds?: string[];
          sliceId: string;
        }>;
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
    ...plan.waves.flatMap((wave) => [
      `  ${prettyLabels.wave} ${wave.index}:`,
      // Group each slice with its builder/tester so the assignment is visible at the point
      // where the slice id is introduced, not two levels deeper.
      ...wave.slices.flatMap((slice) => [
        `    • ${slice.id}`,
        `        Builder: ${slice.assignedWorkerId ?? "unassigned"}`,
        `        Tester:  ${slice.assignedTesterWorkerId ?? "unassigned"}`,
      ]),
    ]),
    ...plan.unassigned.map(
      (slice) =>
        `  unassigned ${prettyLabels.encounter}: ${slice.id} (${slice.message ?? slice.reason ?? "unassigned"})`,
    ),
    ...plan.warnings.map((warning) => formatPlanWarningPretty(warning)),
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
  const partyState = candidate.partyState as PartyStateView | undefined;
  return run
    ? formatRunSummaryBlock(summarizeRunDetail(run), partyState).join("\n")
    : JSON.stringify(fallback, null, 2);
}

function formatRunsSummaryPretty(candidate: Record<string, unknown>): string {
  const partyState = candidate.partyState as PartyStateView | undefined;
  if (candidate.summary) {
    return formatRunSummaryBlock(
      candidate.summary as ReturnType<typeof summarizeRunDetail>,
      partyState,
    ).join("\n");
  }

  const runs = (candidate.runs as QuestRunDocument[] | undefined) ?? [];
  return [
    ...(partyState ? [...formatPartyStatePretty(partyState), ""] : []),
    prettyLabels.questLog,
    ...runs.map(
      (run) => `  - ${formatRunSummaryBlock(summarizeRunDetail(run))[0]} | status=${run.status}`,
    ),
  ].join("\n");
}

function formatUsagePretty(summary: RunUsageSummary): string {
  const totalTokens = summary.totals.totalTokens ?? "unknown";
  return [
    `Usage for ${summary.runId}`,
    `  total tokens: ${totalTokens}`,
    `  input tokens: ${summary.totals.inputTokens ?? "unknown"}`,
    `  output tokens: ${summary.totals.outputTokens ?? "unknown"}`,
    `  reasoning tokens: ${summary.totals.reasoningTokens ?? "unknown"}`,
    `  accounted phases: ${summary.totals.knownPhaseCount}/${summary.phases.length}`,
    ...summary.phases.map(
      (phase) =>
        `  - ${phase.sliceId} ${phase.phase} worker=${phase.workerId ?? "unassigned"} tokens=${phase.tokens.totalTokens ?? "unknown"}${phase.summary ? ` | ${phase.summary}` : ""}`,
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
          lastTesterOutput?: { exitCode: number } | undefined;
          sliceId: string;
          status: string;
        }>;
      }
    | undefined;
  const logLines =
    logView?.slices.flatMap((slice) => [
      `  - ${prettyLabels.encounter}=${slice.sliceId} ${prettyLabels.party} status=${slice.status}${slice.lastOutput ? ` builder-exit=${slice.lastOutput.exitCode}` : ""}${slice.lastTesterOutput ? ` tester-exit=${slice.lastTesterOutput.exitCode}` : ""}`,
      ...(slice.lastChecks ?? []).map(
        (check) =>
          `    ${prettyLabels.trial}=${check.command.argv.join(" ")} status=${check.exitCode === 0 ? "passed" : "failed"} exit=${check.exitCode}`,
      ),
    ]) ?? [];
  return [`Chronicle${logView ? ` for ${logView.runId}` : ""}`, ...logLines].join("\n");
}

function formatWorkspacePrunePretty(candidate: Record<string, unknown>, value: unknown): string {
  const result = candidate.result as
    | {
        dryRun?: boolean;
        pruned: Array<{ runId: string; status: string }>;
        skipped: Array<{ reason: string; runId: string; status: string }>;
        usage?: { exceedsThreshold: boolean; thresholdBytes: number; workspaceBytes: number };
        warnings: Array<{ reason: string; runId: string }>;
      }
    | undefined;
  if (!result) {
    return JSON.stringify(value, null, 2);
  }

  return [
    `Workspace prune${result.dryRun ? " (dry run)" : ""}`,
    `  pruned: ${result.pruned.length}`,
    `  skipped: ${result.skipped.length}`,
    `  warnings: ${result.warnings.length}`,
    ...(result.usage
      ? [
          `  workspace bytes: ${result.usage.workspaceBytes}`,
          `  warning threshold: ${result.usage.thresholdBytes}`,
          `  threshold exceeded: ${result.usage.exceedsThreshold}`,
        ]
      : []),
    ...result.pruned.map((entry) => `  - pruned ${entry.runId} (${entry.status})`),
    ...result.skipped.map(
      (entry) => `  - skipped ${entry.runId} (${entry.status}) reason=${entry.reason}`,
    ),
    ...result.warnings.map((warning) => `  - warning ${warning.runId}: ${warning.reason}`),
  ].join("\n");
}

function formatRunsUsageListPretty(candidate: Record<string, unknown>): string {
  const runs = (candidate.runs as RunUsageSummary[] | undefined) ?? [];
  const warnings =
    (candidate.warnings as Array<{ reason: string; runId: string }> | undefined) ?? [];
  const runText =
    runs.length === 0 ? "Usage\n  no runs" : runs.map((run) => formatUsagePretty(run)).join("\n\n");
  if (warnings.length === 0) {
    return runText;
  }

  return [
    runText,
    "",
    "Warnings",
    ...warnings.map((warning) => `  - ${warning.runId}: ${warning.reason}`),
  ].join("\n");
}

function formatRunsListPretty(candidate: Record<string, unknown>): string {
  const partyState = candidate.partyState as PartyStateView | undefined;
  const runs =
    (candidate.runs as Array<{ id: string; questTitle: string; status: string }> | undefined) ?? [];
  const warnings =
    (candidate.warnings as Array<{ reason: string; runId: string }> | undefined) ?? [];
  return [
    ...(partyState ? [...formatPartyStatePretty(partyState), ""] : []),
    `${prettyLabels.questLog} (${runs.length})`,
    ...runs.map((run) => `  - ${run.id} | ${run.status} | ${run.questTitle}`),
    ...warnings.map((warning) => `  - warning ${warning.runId}: ${warning.reason}`),
  ].join("\n");
}

function formatSetupPretty(candidate: Record<string, unknown>): string {
  const doctor = candidate.doctor as { checks: DoctorCheck[]; ok: boolean } | undefined;
  const createdWorker = candidate.createdWorker as RegisteredWorker | null | undefined;
  const createdWorkers = (candidate.createdWorkers as RegisteredWorker[] | undefined) ?? [];
  const calibrationResults =
    (candidate.calibrationResults as
      | Array<{ runId: string; status: string; workerId: string }>
      | undefined) ?? [];
  const configuredSink = candidate.configuredSink as { id?: string; type?: string } | undefined;
  const imports = candidate.imports as { summary?: string | null } | null | undefined;
  const settings = candidate.settings as
    | { planner?: { testerSelectionStrategy?: string | null } }
    | undefined;
  const workers = (candidate.workers as RegisteredWorker[] | undefined) ?? [];
  const paths = (candidate.paths as Record<string, string> | undefined) ?? {};

  return [
    "Quest Runner Setup",
    `status: ${doctor?.ok === true ? "ok" : "fail"}`,
    `imported defaults: ${imports?.summary ?? "none"}`,
    createdWorker ? `created worker: ${formatWorkerLine(createdWorker)}` : "created worker: none",
    `party members created: ${createdWorkers.length}`,
    configuredSink
      ? `sink: ${configuredSink.id ?? "configured"} (${configuredSink.type ?? "unknown"})`
      : "sink: none",
    `training grounds: ${
      calibrationResults.length > 0
        ? calibrationResults.map((result) => `${result.workerId}:${result.status}`).join(", ")
        : "skipped"
    }`,
    `tester routing: ${settings?.planner?.testerSelectionStrategy ?? "balanced"}`,
    `workers: ${workers.length}`,
    "",
    "Paths",
    ...Object.entries(paths).map(([key, path]) => `  ${key}: ${path}`),
    "",
    "Checks",
    ...(doctor?.checks ?? []).map((check) => `  ${formatDoctorCheck(check)}`),
  ].join("\n");
}

function formatDeliveryAttemptsPretty(candidate: Record<string, unknown>): string {
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

function formatRunValidationPretty(candidate: Record<string, unknown>, value: unknown): string {
  const validation = candidate.validation as
    | { issues?: unknown; ok: boolean; path: string; reason: string; runId: string }
    | undefined;
  if (!validation) {
    return JSON.stringify(value, null, 2);
  }
  return [
    `Run validation: ${validation.runId}`,
    `  ok: ${validation.ok}`,
    `  reason: ${validation.reason}`,
    `  path: ${validation.path}`,
    ...(validation.issues ? ["", JSON.stringify(validation.issues, null, 2)] : []),
  ].join("\n");
}

function formatRunQuarantinePretty(candidate: Record<string, unknown>, value: unknown): string {
  const quarantine = candidate.quarantine as
    | { originalPath: string; quarantinedPath: string; runId: string }
    | undefined;
  if (!quarantine) {
    return JSON.stringify(value, null, 2);
  }
  return [
    `Quarantined run: ${quarantine.runId}`,
    `  from: ${quarantine.originalPath}`,
    `  to: ${quarantine.quarantinedPath}`,
  ].join("\n");
}

function hasRunWatchSettled(run: QuestRunDocument): boolean {
  return run.executionStage === undefined && run.status !== "running";
}

function formatWatchHeartbeat(
  run: QuestRunDocument,
  partyState?: PartyStateView | undefined,
): string {
  return [
    ...(partyState ? [...formatPartyStatePretty(partyState), ""] : []),
    `${prettyLabels.heartbeat}:`,
    `  ${prettyLabels.questStatus}: ${run.status}`,
    `  Stage: ${run.executionStage ?? "idle"}`,
    `  Active Processes: ${run.activeProcesses.length}`,
  ].join("\n");
}

function formatWatchEventLine(event: QuestRunEvent): string {
  const details = event.details;
  switch (event.type) {
    case "run_started":
      return `[${event.at}] ${formatPrettyStatus("info")} ${prettyLabels.quest} started`;
    case "run_completed":
      return `[${event.at}] ${formatPrettyStatus("ok")} ${prettyLabels.quest} completed`;
    case "run_failed":
      return `[${event.at}] ${formatPrettyStatus("fail")} ${prettyLabels.quest} failed`;
    case "run_integrated":
      return `[${event.at}] ${formatPrettyStatus("ok")} ${prettyLabels.bossFight} cleared`;
    case "run_landed":
      return `[${event.at}] ${formatPrettyStatus("ok")} ${prettyLabels.turnIn} complete`;
    case "slice_started":
      return `[${event.at}] ${formatPrettyStatus("info")} ${prettyLabels.encounter} started: ${String(details.sliceId ?? "unknown")}`;
    case "slice_testing_started":
      return `[${event.at}] ${formatPrettyStatus("info")} ${prettyLabels.trial} started: ${String(details.sliceId ?? "unknown")}`;
    case "slice_completed":
      return `[${event.at}] ${formatPrettyStatus("ok")} ${prettyLabels.encounter} cleared: ${String(details.sliceId ?? "unknown")}`;
    case "slice_testing_completed":
      return `[${event.at}] ${formatPrettyStatus("ok")} ${prettyLabels.trial} cleared: ${String(details.sliceId ?? "unknown")}`;
    default:
      return `[${event.at}] ${event.type}`;
  }
}

async function watchQuestRun(
  partyStateStore: QuestPartyStateStore,
  runStore: QuestRunStore,
  runId: string,
  options: { outputMode: OutputMode; pollMs: number },
): Promise<QuestRunDocument> {
  let seenEventCount = 0;
  let heartbeatTick = 0;
  const heartbeatEvery = Math.max(1, Math.ceil(1000 / options.pollMs));

  while (true) {
    const run = await runStore.getRun(runId);
    const partyState = summarizePartyState(await partyStateStore.readState());

    if (options.outputMode === "pretty") {
      const newEvents = run.events.slice(seenEventCount);
      for (const event of newEvents) {
        void Bun.write(Bun.stdout, `${formatWatchEventLine(event)}\n`);
      }
      seenEventCount = run.events.length;

      if (!hasRunWatchSettled(run)) {
        if (newEvents.length === 0 && heartbeatTick % heartbeatEvery === 0) {
          void Bun.write(Bun.stdout, `${formatWatchHeartbeat(run, partyState)}\n`);
        }
        heartbeatTick += 1;
      }
    }

    if (hasRunWatchSettled(run)) {
      return run;
    }

    await Bun.sleep(options.pollMs);
  }
}

function formatPrettyOutput(commandId: QuestCliCommand, value: unknown): string {
  const candidate = isRecord(value) ? value : null;
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
      return formatSetupPretty(candidate);
    }
    case "party:bonfire":
    case "party:resume":
    case "party:status": {
      const partyState = candidate.partyState as PartyStateView | undefined;
      return partyState
        ? formatPartyStatePretty(partyState, { includeEvents: true }).join("\n")
        : JSON.stringify(value, null, 2);
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
    case "workers:inspect": {
      const worker = candidate.worker as RegisteredWorker | undefined;
      const status = candidate.status as WorkerStatusSummary | undefined;
      return worker && status
        ? formatWorkerInspectPretty(worker, status)
        : JSON.stringify(value, null, 2);
    }
    case "workers:status": {
      const worker = candidate.worker as RegisteredWorker | undefined;
      const status = candidate.status as WorkerStatusSummary | undefined;
      if (!worker || !status) {
        return JSON.stringify(value, null, 2);
      }

      return formatWorkerStatusPretty(worker, status);
    }
    case "workers:remove": {
      const worker = candidate.worker as RegisteredWorker | undefined;
      return worker
        ? `Removed worker ${worker.id} (${worker.name})`
        : JSON.stringify(value, null, 2);
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
    case "observability:sinks:test":
    case "observability:deliveries:retry": {
      return formatDeliveryAttemptsPretty(candidate);
    }
    case "observability:webhook:upsert":
    case "observability:telegram:upsert":
    case "observability:openclaw:upsert":
    case "observability:slack:upsert":
    case "observability:linear:upsert": {
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
    case "plan": {
      return formatPlanPretty(candidate, value);
    }
    case "workspaces:prune": {
      return formatWorkspacePrunePretty(candidate, value);
    }
    case "runs:validate": {
      return formatRunValidationPretty(candidate, value);
    }
    case "runs:quarantine": {
      return formatRunQuarantinePretty(candidate, value);
    }
    case "run":
    case "runs:status":
    case "runs:execute":
    case "runs:integrate":
    case "runs:land":
    case "runs:refresh-base":
    case "runs:cleanup":
    case "runs:abort":
    case "runs:cancel":
    case "runs:babysit":
    case "runs:pause":
    case "runs:resume":
    case "runs:rescue":
    case "runs:rerun": {
      return formatRunPretty(candidate, value);
    }
    case "runs:watch": {
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
    case "runs:usage": {
      const summary = candidate.usage as RunUsageSummary | undefined;
      if (summary) {
        return formatUsagePretty(summary);
      }

      return formatRunsUsageListPretty(candidate);
    }
    case "runs:list": {
      return formatRunsListPretty(candidate);
    }
    case "runs:logs": {
      return formatLogsPretty(candidate);
    }
    case "runs:chronicle": {
      const chronicle = candidate.chronicle;
      return typeof chronicle === "string" ? chronicle : JSON.stringify(value, null, 2);
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

function formatDomainErrorDetailsPretty(details: unknown): string[] {
  if (!isRecord(details)) {
    // Keep non-record details visible as a one-line literal so operators still see the value.
    return [`  details: ${JSON.stringify(details)}`];
  }
  const lines: string[] = [];
  for (const [key, value] of Object.entries(details)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      lines.push(`  ${key}: ${value}`);
      continue;
    }
    if (Array.isArray(value)) {
      const preview = value.slice(0, 5).map((entry) => String(entry));
      const remainder = value.length - preview.length;
      const suffix = remainder > 0 ? `, +${remainder} more` : "";
      lines.push(`  ${key}: [${preview.join(", ")}${suffix}]`);
      continue;
    }
    // Nested objects stay as compact JSON so the message never hides internal state completely.
    lines.push(`  ${key}: ${JSON.stringify(value)}`);
  }
  return lines;
}

function formatZodIssuesPretty(error: ZodError): string {
  const lines: string[] = [];
  for (const issue of error.issues) {
    const fieldPath = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    lines.push(`  • ${fieldPath}: ${issue.message}`);
  }
  return lines.length > 0 ? lines.join("\n") : "  (no field-level details)";
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
        `${formatPrettyStatus("fail")} validation_failed: ${payload.message}\n${formatZodIssuesPretty(error)}\n`,
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
      const details =
        payload.details === undefined ? [] : formatDomainErrorDetailsPretty(payload.details);
      void Bun.write(
        Bun.stderr,
        `${[`${formatPrettyStatus("fail")} ${payload.error}: ${payload.message}`, ...details].join("\n")}\n`,
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
    void Bun.write(
      Bun.stderr,
      `${formatPrettyStatus("fail")} ${payload.error}\n${payload.message}\n`,
    );
  }
}

const commandDefinitions: QuestCliCommandDefinition[] = [
  {
    id: "daemon:start",
    matches: (args) => args.length >= 2 && args[0] === "daemon" && args[1] === "start",
    run: async ({ daemonStore }) => await startDaemon(daemonStore),
    usage: "quest daemon start [--state-root <path>]",
  },
  {
    id: "daemon:stop",
    matches: (args) => args.length >= 2 && args[0] === "daemon" && args[1] === "stop",
    run: async ({ daemonStore }) => await stopDaemon(daemonStore),
    usage: "quest daemon stop [--state-root <path>]",
  },
  {
    id: "daemon:status",
    matches: (args) => args.length >= 2 && args[0] === "daemon" && args[1] === "status",
    run: async ({ daemonStore }) => await daemonStatus(daemonStore),
    usage: "quest daemon status [--state-root <path>]",
  },
  {
    id: "daemon:tick-loop",
    matches: (args) => args.length >= 3 && args[0] === "daemon" && args[1] === "_tick-loop",
    run: async ({ daemonStore, dispatcher, partyStateStore }) =>
      await runDaemonTickLoop(daemonStore, {
        onTickEvents: async (events) => {
          // Emission is best-effort so a flaky sink never blocks daemon dispatch.
          try {
            await dispatcher.dispatchDaemonEvents(events);
          } catch {
            // Sink failures are persisted into delivery records; the loop keeps going.
          }
        },
        partyStateStore,
      }),
    usage: "quest daemon _tick-loop [--state-root <path>]",
  },
  {
    id: "daemon:tick",
    matches: (args) => args.length >= 2 && args[0] === "daemon" && args[1] === "tick",
    // One-shot tick for canaries and scripted operator checks; the long-running supervisor uses
    // _tick-loop in production.
    run: async ({ daemonStore, dispatcher, partyStateStore }) =>
      await runSingleDaemonTick(daemonStore, {
        onTickEvents: async (events) => {
          try {
            await dispatcher.dispatchDaemonEvents(events);
          } catch {
            // Sink failures are persisted into delivery records; the one-shot tick still returns.
          }
        },
        partyStateStore,
      }),
    usage: "quest daemon tick [--state-root <path>]",
  },
  {
    id: "setup",
    matches: (args) => args.length >= 1 && args[0] === "setup",
    run: async ({ args, calibrator, observabilityStore, registry, settingsStore, secretStore }) =>
      await runSetup(args, calibrator, observabilityStore, registry, settingsStore, secretStore),
    usage:
      "quest setup [--yes] [--backend <codex|hermes|openclaw|standalone>] [--tester-selection <balanced|prefer-cheapest>] [--create-worker] [--skip-worker] [--calibrate] [--skip-calibration] [--worker-name <name>] [--worker-id <id>] [--profile <model>] [--command <cmd>] [--command-arg <arg>] [--base-url <url>] [--codex-executable <path>] [--openclaw-executable <path>] [--hermes-base-url <url>] [--gateway-url <url>] [--agent-id <id>] [--session-id <id>] [--local] [--role <builder|tester|hybrid>] [--coding <n>] [--testing <n>] [--docs <n>] [--research <n>] [--speed <n>] [--merge-safety <n>] [--context-endurance <n>] [--cpu-cost <n>] [--memory-cost <n>] [--gpu-cost <n>] [--max-parallel <n>] [--reasoning-effort <none|minimal|low|medium|high|xhigh>] [--max-output-tokens <n>] [--temperature <n>] [--top-p <n>] [--context-window <n>] [--provider-option <key=value>] [--state-root <path>]",
  },
  {
    id: "doctor",
    matches: (args) => args.length >= 1 && args[0] === "doctor",
    run: async ({ args, dispatcher, observabilityStore, secretStore }) =>
      await runDoctor(
        args,
        dispatcher,
        observabilityStore,
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
      "quest doctor [--codex-executable <path>] [--openclaw-executable <path>] [--check-openclaw] [--gateway-url <url>] [--agent-id <id>] [--test-sinks] [--sink-id <id>] [--registry <path>] [--runs-root <path>] [--workspaces-root <path>] [--calibrations-root <path>] [--observability-config <path>] [--observability-deliveries <path>] [--state-root <path>]",
  },
  {
    id: "party:create",
    matches: (args) => args.length >= 2 && args[0] === "party" && args[1] === "create",
    run: async ({ args, daemonStore, dispatcher }) => {
      const linearDefaultIssueId = findOptionValue(args, "--linear-default-issue-id");
      const party = await daemonStore.createParty({
        budget: {
          maxConcurrent: 1,
          maxSpecsPerHour: 10,
        },
        enabled: true,
        name: requireOptionValue(args, "--name", "--name <party-name>"),
        sourceRepo: requireOptionValue(args, "--source-repo", "--source-repo <path>"),
        targetRef: requireOptionValue(args, "--target-ref", "--target-ref <ref>"),
        ...(linearDefaultIssueId
          ? { tracker: { linear: { defaultIssueId: linearDefaultIssueId } } }
          : {}),
      });
      await safeDispatchPartyAdminEvent(dispatcher, {
        eventType: "daemon_party_created",
        partyName: party.name,
        reason: `target_ref:${party.targetRef}`,
      });
      return { party };
    },
    usage:
      "quest party create --name <party-name> --source-repo <path> --target-ref <ref> [--linear-default-issue-id <id>] [--state-root <path>]",
  },
  {
    id: "party:remove",
    matches: (args) => args.length >= 2 && args[0] === "party" && args[1] === "remove",
    run: async ({ args, daemonStore }) => ({
      party: await daemonStore.removeParty(
        requireOptionValue(args, "--name", "--name <party-name>"),
      ),
    }),
    usage: "quest party remove --name <party-name> [--state-root <path>]",
  },
  {
    id: "party:list",
    matches: (args) => args.length >= 2 && args[0] === "party" && args[1] === "list",
    run: async ({ daemonStore }) => ({
      parties: (await daemonStatus(daemonStore)).parties,
    }),
    usage: "quest party list [--state-root <path>]",
  },
  {
    id: "party:status",
    matches: (args) => args.length >= 2 && args[0] === "party" && args[1] === "status",
    run: async ({ args, daemonStore, partyStateStore }) => {
      const partyName = findOptionValue(args, "--name");
      if (partyName) {
        return {
          party: await summarizeDaemonParty(daemonStore, partyName),
        };
      }

      return {
        partyState: summarizePartyState(await partyStateStore.readState()),
      };
    },
    usage: "quest party status [--name <party-name>] [--state-root <path>]",
  },
  {
    id: "party:bonfire",
    matches: (args) => args.length >= 2 && args[0] === "party" && args[1] === "bonfire",
    run: async ({ args, daemonStore, dispatcher, partyStateStore }) => {
      const partyName = findOptionValue(args, "--name");
      const reason = findOptionValue(args, "--reason") ?? undefined;
      if (partyName) {
        await daemonStore.restParty(partyName, reason);
        await safeDispatchPartyAdminEvent(dispatcher, {
          eventType: "daemon_party_resting",
          partyName,
          reason: reason ?? null,
        });
        return {
          party: await summarizeDaemonParty(daemonStore, partyName),
        };
      }

      const nextState = await partyStateStore.lightBonfire(reason);
      await safeDispatchPartyAdminEvent(dispatcher, {
        eventType: "daemon_party_resting",
        partyName: "*",
        reason: nextState.reason ?? null,
      });
      return { partyState: summarizePartyState(nextState) };
    },
    usage: "quest party bonfire [--name <party-name>] [--reason <text>] [--state-root <path>]",
  },
  {
    id: "party:resume",
    matches: (args) => args.length >= 2 && args[0] === "party" && args[1] === "resume",
    run: async ({ args, daemonStore, dispatcher, partyStateStore }) => {
      const partyName = findOptionValue(args, "--name");
      if (partyName) {
        await daemonStore.resumeParty(partyName);
        await safeDispatchPartyAdminEvent(dispatcher, {
          eventType: "daemon_party_resumed",
          partyName,
        });
        return {
          party: await summarizeDaemonParty(daemonStore, partyName),
        };
      }

      const nextState = await partyStateStore.resumeParty();
      await safeDispatchPartyAdminEvent(dispatcher, {
        eventType: "daemon_party_resumed",
        partyName: "*",
      });
      return { partyState: summarizePartyState(nextState) };
    },
    usage: "quest party resume [--name <party-name>] [--state-root <path>]",
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
    id: "observability:sinks:test",
    matches: (args) =>
      args.length >= 3 && args[0] === "observability" && args[1] === "sinks" && args[2] === "test",
    run: async ({ args, dispatcher }) => ({
      attempts: await dispatcher.dispatchProbe(
        createSinkProbeEvent(findOptionValue(args, "--label") ?? "manual"),
        { sinkId: findOptionValue(args, "--id") ?? undefined },
      ),
    }),
    usage:
      "quest observability sinks test [--id <sink-id>] [--label <manual>] [--observability-config <path>] [--observability-deliveries <path>] [--state-root <path>]",
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
    id: "observability:slack:upsert",
    matches: (args) =>
      args.length >= 3 &&
      args[0] === "observability" &&
      args[1] === "slack" &&
      args[2] === "upsert",
    run: async ({ args, observabilityStore }) => {
      const sink = slackSinkSchema.parse({
        enabled: !hasFlag(args, "--disabled"),
        eventTypes: parseObservableEventTypes(findOptionValue(args, "--events")),
        id: findOptionValue(args, "--id") ?? "default-slack",
        secretRef: findOptionValue(args, "--secret-ref") ?? undefined,
        textPrefix: findOptionValue(args, "--text-prefix") ?? undefined,
        type: "slack",
        url: findOptionValue(args, "--url") ?? undefined,
        urlEnv: findOptionValue(args, "--url-env") ?? undefined,
      });
      return { sink: await observabilityStore.upsertSlackSink(sink) };
    },
    usage:
      "quest observability slack upsert [--url <https://...>] [--url-env <name>] [--secret-ref <name>] [--id <sink-id>] [--events <event,event>] [--text-prefix <text>] [--disabled] [--observability-config <path>] [--state-root <path>]",
  },
  {
    id: "observability:linear:upsert",
    matches: (args) =>
      args.length >= 3 &&
      args[0] === "observability" &&
      args[1] === "linear" &&
      args[2] === "upsert",
    run: async ({ args, observabilityStore }) => {
      const sink = linearSinkSchema.parse({
        apiBaseUrl: findOptionValue(args, "--api-base-url") ?? undefined,
        apiKeyEnv: findOptionValue(args, "--api-key-env") ?? undefined,
        apiKeySecretRef: findOptionValue(args, "--api-key-secret-ref") ?? undefined,
        enabled: !hasFlag(args, "--disabled"),
        eventTypes: parseObservableEventTypes(findOptionValue(args, "--events")),
        id: findOptionValue(args, "--id") ?? "default-linear",
        issueId: requireOptionValue(args, "--issue-id", "--issue-id <id>"),
        stateMap: parseLinearStateMapFlags(args),
        titlePrefix: findOptionValue(args, "--title-prefix") ?? undefined,
        type: "linear",
        useRpgCards: hasFlag(args, "--rpg-cards") ? true : undefined,
      });
      return { sink: await observabilityStore.upsertLinearSink(sink) };
    },
    usage:
      "quest observability linear upsert --issue-id <id> [--id <sink-id>] [--api-key-env <name> | --api-key-secret-ref <name>] [--api-base-url <url>] [--events <event,event>] [--title-prefix <text>] [--rpg-cards] [--state-dispatched <name>] [--state-landed <name>] [--state-failed <name>] [--state-testing <name>] [--state-in-review <name>] [--state-blocked <name>] [--disabled] [--observability-config <path>] [--state-root <path>]",
  },
  {
    id: "observability:openclaw:upsert",
    matches: (args) =>
      args.length >= 3 &&
      args[0] === "observability" &&
      args[1] === "openclaw" &&
      args[2] === "upsert",
    run: async ({ args, observabilityStore }) => {
      const sink = openClawSinkSchema.parse({
        agentId: requireOptionValue(args, "--agent-id", "--agent-id <id>"),
        enabled: !hasFlag(args, "--disabled"),
        eventTypes: parseObservableEventTypes(findOptionValue(args, "--events")),
        executable: findOptionValue(args, "--openclaw-executable") ?? undefined,
        gatewayUrl: findOptionValue(args, "--gateway-url") ?? undefined,
        id: findOptionValue(args, "--id") ?? "default-openclaw",
        promptPrefix: findOptionValue(args, "--prompt-prefix") ?? undefined,
        sessionId: findOptionValue(args, "--session-id") ?? undefined,
        type: "openclaw",
      });
      return { sink: await observabilityStore.upsertOpenClawSink(sink) };
    },
    usage:
      "quest observability openclaw upsert --agent-id <id> [--id <sink-id>] [--session-id <id>] [--gateway-url <url>] [--openclaw-executable <path>] [--events <event,event>] [--prompt-prefix <text>] [--disabled] [--observability-config <path>] [--state-root <path>]",
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
      const importedDefaults = (await detectBackendDefaults(
        "codex",
        args,
      )) as DetectedCodexSetup | null;
      const worker = registeredWorkerSchema.parse(buildCodexWorker(args, importedDefaults));
      return { worker: await registry.upsertWorker(worker) };
    },
    usage:
      "quest workers add codex [--id <id>] [--name <name>] [--profile <model>] [--tags <a,b>] [--role <builder|tester|hybrid>] [--coding <n>] [--testing <n>] [--docs <n>] [--research <n>] [--speed <n>] [--merge-safety <n>] [--context-endurance <n>] [--cpu-cost <n>] [--memory-cost <n>] [--gpu-cost <n>] [--max-parallel <n>] [--trust-rating <n>] [--level <n>] [--xp <n>] [--reasoning-effort <none|minimal|low|medium|high|xhigh>] [--max-output-tokens <n>] [--temperature <n>] [--top-p <n>] [--context-window <n>] [--provider-option <key=value>] [--auth-mode <native-login|env-var|secret-store>] [--env-var <name>] [--secret-ref <name>] [--no-import-existing]",
  },
  {
    id: "workers:add:hermes",
    matches: (args) =>
      args.length >= 3 && args[0] === "workers" && args[1] === "add" && args[2] === "hermes",
    run: async ({ args, registry }) => {
      const importedDefaults = (await detectBackendDefaults(
        "hermes",
        args,
      )) as DetectedHermesSetup | null;
      const worker = registeredWorkerSchema.parse(buildHermesWorker(args, importedDefaults));
      return { worker: await registry.upsertWorker(worker) };
    },
    usage:
      "quest workers add hermes [--base-url <http://127.0.0.1:8000/v1>] [--id <id>] [--name <name>] [--tags <a,b>] [--role <builder|tester|hybrid>] [--coding <n>] [--testing <n>] [--docs <n>] [--research <n>] [--speed <n>] [--merge-safety <n>] [--context-endurance <n>] [--cpu-cost <n>] [--memory-cost <n>] [--gpu-cost <n>] [--max-parallel <n>] [--trust-rating <n>] [--level <n>] [--xp <n>] [--profile <model>] [--reasoning-effort <none|minimal|low|medium|high|xhigh>] [--max-output-tokens <n>] [--temperature <n>] [--top-p <n>] [--context-window <n>] [--provider-option <key=value>] [--auth-mode <env-var|secret-store>] [--env-var <name>] [--secret-ref <name>] [--no-import-existing]",
  },
  {
    id: "workers:add:openclaw",
    matches: (args) =>
      args.length >= 3 && args[0] === "workers" && args[1] === "add" && args[2] === "openclaw",
    run: async ({ args, registry }) => {
      const importedDefaults = (await detectBackendDefaults(
        "openclaw",
        args,
      )) as DetectedOpenClawSetup | null;
      const worker = registeredWorkerSchema.parse(buildOpenClawWorker(args, importedDefaults));
      return { worker: await registry.upsertWorker(worker) };
    },
    usage:
      "quest workers add openclaw [--agent-id <id> | --session-id <id>] [--gateway-url <url>] [--local] [--executable <path>] [--id <id>] [--name <name>] [--profile <name>] [--tags <a,b>] [--role <builder|tester|hybrid>] [--coding <n>] [--testing <n>] [--docs <n>] [--research <n>] [--speed <n>] [--merge-safety <n>] [--context-endurance <n>] [--cpu-cost <n>] [--memory-cost <n>] [--gpu-cost <n>] [--max-parallel <n>] [--trust-rating <n>] [--level <n>] [--xp <n>] [--reasoning-effort <none|minimal|low|medium|high|xhigh>] [--max-output-tokens <n>] [--temperature <n>] [--top-p <n>] [--context-window <n>] [--provider-option <key=value>] [--auth-mode <env-var|secret-store>] [--env-var <name>] [--secret-ref <name>] [--target-env-var <name>] [--no-import-existing]",
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
    id: "workers:inspect",
    matches: (args) => args.length >= 2 && args[0] === "workers" && args[1] === "inspect",
    run: async ({ args, registry }) => {
      const worker = await registry.getWorker(requireOptionValue(args, "--id", "--id <worker-id>"));
      return { status: buildWorkerStatusSummary(worker), worker };
    },
    usage: "quest workers inspect --id <worker-id> [--registry <path>]",
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
    id: "workers:remove",
    matches: (args) => args.length >= 2 && args[0] === "workers" && args[1] === "remove",
    run: async ({ args, registry }) => {
      const workerId = requireOptionValue(args, "--id", "--id <worker-id>");
      const confirmed =
        hasFlag(args, "--yes") || !stdinIsTty()
          ? true
          : await confirmWithDefault(`Remove worker ${workerId}?`, false);
      if (!confirmed) {
        throw new Error(`Removal cancelled for worker ${workerId}`);
      }

      return { worker: await registry.removeWorker(workerId) };
    },
    usage: "quest workers remove --id <worker-id> [--yes] [--registry <path>]",
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
    run: async ({ args, registry, settingsStore }) => {
      const spec = await readQuestSpecInput(args, settingsStore);
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
    run: async ({ args, registry, runStore, settingsStore }) => {
      const spec = await readQuestSpecInput(args, settingsStore);
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
    id: "workspaces:prune",
    matches: (args) => args.length >= 2 && args[0] === "workspaces" && args[1] === "prune",
    run: async ({ args, runCleanup, settingsStore }) => ({
      result: await runCleanup.pruneWorkspaces({
        dryRun: hasFlag(args, "--dry-run"),
        olderThanMs: findOptionValue(args, "--older-than")
          ? parseDurationToMilliseconds(
              requireOptionValue(args, "--older-than", "--older-than <72h>"),
            )
          : undefined,
        skipInvalidSchema: hasFlag(args, "--skip-invalid"),
        statuses: parsePruneStatuses(findOptionValue(args, "--status")),
        warningThresholdBytes: findOptionValue(args, "--warning-threshold-bytes")
          ? parsePositiveInteger(
              requireOptionValue(
                args,
                "--warning-threshold-bytes",
                "--warning-threshold-bytes <n>",
              ),
              "warning-threshold-bytes",
            )
          : (await settingsStore.readSettings()).maintenance.workspaceWarningBytes,
      }),
    }),
    usage:
      "quest workspaces prune [--older-than <72h>] [--status <landed,completed,aborted,orphaned>] [--dry-run] [--skip-invalid] [--warning-threshold-bytes <n>] [--runs-root <path>] [--workspaces-root <path>] [--settings <path>] [--state-root <path>]",
  },
  {
    id: "runs:list",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "list",
    run: async ({ args, partyStateStore, runStore }) => {
      const listed = await runStore.listRunsWithWarnings({
        skipInvalidSchema: hasFlag(args, "--skip-invalid"),
      });
      return {
        partyState: summarizePartyState(await partyStateStore.readState()),
        runs: listed.runs,
        warnings: listed.warnings,
      };
    },
    usage:
      "quest runs list [--skip-invalid] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:validate",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "validate",
    run: async ({ args, runStore }) => ({
      validation: await runStore.validateRunDocument(
        requireOptionValue(args, "--id", "--id <run-id>"),
      ),
    }),
    usage:
      "quest runs validate --id <run-id> [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:quarantine",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "quarantine",
    run: async ({ args, runStore }) => ({
      quarantine: await runStore.quarantineRunDocument(
        requireOptionValue(args, "--id", "--id <run-id>"),
      ),
    }),
    usage:
      "quest runs quarantine --id <run-id> [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
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
    id: "runs:cancel",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "cancel",
    run: async ({ args, runStore }) => ({
      run: await runStore.cancelRun(requireOptionValue(args, "--id", "--id <run-id>")),
    }),
    usage:
      "quest runs cancel --id <run-id> [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:babysit",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "babysit",
    run: async ({ args, runStore }) => ({
      results: await runStore.babysitRuns({
        runId: findOptionValue(args, "--id") ?? undefined,
        staleMinutes: findOptionValue(args, "--stale-minutes")
          ? Number(requireOptionValue(args, "--stale-minutes", "--stale-minutes <n>"))
          : undefined,
      }),
    }),
    usage:
      "quest runs babysit [--id <run-id>] [--stale-minutes <n>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
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
    id: "runs:land",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "land",
    run: async ({ args, runLander }) => ({
      run: await runLander.landRun(requireOptionValue(args, "--id", "--id <run-id>"), {
        sourceRepositoryPath: findOptionValue(args, "--source-repo") ?? undefined,
        targetRef: findOptionValue(args, "--target-ref") ?? undefined,
      }),
    }),
    usage:
      "quest runs land --id <run-id> [--source-repo <path>] [--target-ref <ref>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:refresh-base",
    matches: (args) => args.length >= 3 && args[0] === "runs" && args[1] === "refresh-base",
    run: async ({ args, runRefresher }) => ({
      run: await runRefresher.refreshBase(requireOptionValue(args, "--id", "--id <run-id>"), {
        sourceRepositoryPath: findOptionValue(args, "--source-repo") ?? undefined,
        targetRef: findOptionValue(args, "--target-ref") ?? undefined,
      }),
    }),
    usage:
      "quest runs refresh-base --id <run-id> [--source-repo <path>] [--target-ref <ref>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:rescue",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "rescue",
    run: async ({ args, runStore }) => ({
      run: await runStore.updateIntegrationRescueStatus(
        requireOptionValue(args, "--id", "--id <run-id>"),
        parseRescueStatus(
          requireOptionValue(args, "--status", "--status <pending|rescued|abandoned|unset>"),
        ),
        findOptionValue(args, "--note") ?? undefined,
      ),
    }),
    usage:
      "quest runs rescue --id <run-id> --status <pending|rescued|abandoned|unset> [--note <text>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
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
    run: async ({ args, partyStateStore, runPipeline }) => ({
      partyState: summarizePartyState(await partyStateStore.readState()),
      run: await runPipeline.executeRun(requireOptionValue(args, "--id", "--id <run-id>"), {
        autoIntegrate: hasFlag(args, "--auto-integrate"),
        dryRun: hasFlag(args, "--dry-run"),
        land: hasFlag(args, "--land"),
        sourceRepositoryPath: findOptionValue(args, "--source-repo") || undefined,
        targetRef: findOptionValue(args, "--target-ref") || undefined,
      }),
    }),
    usage:
      "quest runs execute --id <run-id> [--dry-run] [--auto-integrate] [--land] [--target-ref <ref>] [--source-repo <path>] [--registry <path>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
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
    id: "runs:chronicle",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "chronicle",
    run: async ({ args, runStore }) => {
      const run = await runStore.getRun(requireOptionValue(args, "--id", "--id <run-id>"));
      const write = hasFlag(args, "--write");
      if (!write) {
        return { chronicle: generateRunChronicle(run), run };
      }

      const path = await writeRunChronicle(run);
      const generatedAt = new Date().toISOString();
      appendEvent(
        run,
        "run_feature_doc_written",
        {
          featureDocPath: path,
          runId: run.id,
        },
        generatedAt,
      );
      run.featureDocGeneratedAt = generatedAt;
      run.featureDocPath = path;
      return { chronicle: generateRunChronicle(run), path, run: await runStore.saveRun(run) };
    },
    usage:
      "quest runs chronicle --id <run-id> [--write] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:status",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "status",
    run: async ({ args, partyStateStore, runStore }) => ({
      partyState: summarizePartyState(await partyStateStore.readState()),
      run: await runStore.getRun(requireOptionValue(args, "--id", "--id <run-id>")),
    }),
    usage:
      "quest runs status --id <run-id> [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:watch",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "watch",
    run: async ({ args, outputMode, partyStateStore, runStore }) => {
      const run = await watchQuestRun(
        partyStateStore,
        runStore,
        requireOptionValue(args, "--id", "--id <run-id>"),
        {
          outputMode,
          pollMs: findOptionValue(args, "--poll-ms")
            ? parsePositiveInteger(
                requireOptionValue(args, "--poll-ms", "--poll-ms <1000>"),
                "poll-ms",
              )
            : 1000,
        },
      );
      return {
        partyState: summarizePartyState(await partyStateStore.readState()),
        run,
      };
    },
    usage:
      "quest runs watch --id <run-id> [--poll-ms <1000>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:summary",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "summary",
    run: async ({ args, partyStateStore, runStore }) => {
      const runId = findOptionValue(args, "--id");
      if (runId) {
        return {
          partyState: summarizePartyState(await partyStateStore.readState()),
          summary: summarizeRunDetail(await runStore.getRun(runId)),
        };
      }

      return {
        partyState: summarizePartyState(await partyStateStore.readState()),
        runs: await runStore.listRuns(),
      };
    },
    usage:
      "quest runs summary [--id <run-id>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:usage",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "usage",
    run: async ({ args, runStore }) => {
      const runId = findOptionValue(args, "--id");
      if (runId) {
        return { usage: summarizeRunUsage(await runStore.getRun(runId)) };
      }

      const listed = await runStore.listRunsWithWarnings();
      const usage = await Promise.all(
        listed.runs.map(async (run) => summarizeRunUsage(await runStore.getRun(run.id))),
      );
      return { runs: usage, warnings: listed.warnings };
    },
    usage:
      "quest runs usage [--id <run-id> | --all] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
];

async function main(): Promise<number> {
  const rawArgs = Bun.argv.slice(2);
  const outputMode = determineOutputMode(rawArgs);
  const args = stripGlobalOutputFlags(rawArgs);

  // `quest --help` still prints the flat every-flag dump for scripts and power users.
  // `quest` with no args, or `quest help`, gets the categorized grouped view so operators who are
  // scanning the binary for the first time see sections and inline comments instead of a wall of
  // usage lines.
  if (hasFlag(args, "--help")) {
    printUsage();
    return 0;
  }

  if (args.length === 0 || args[0] === "help") {
    printCategorizedHelp();
    return 0;
  }

  const command = commandDefinitions.find((definition) => definition.matches(args)) ?? null;
  if (!command) {
    printCategorizedHelp();
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
  const settingsPath = resolveQuestSettingsPath(
    definedPathOptions(stateRoot, "explicitSettingsPath", findOptionValue(args, "--settings")),
  );
  const partyStatePath = resolveQuestPartyStatePath({
    stateRoot,
  });
  const daemonStore = new QuestDaemonStore(stateRoot);
  const registry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const secretStore = new SecretStore();
  const settingsStore = new QuestSettingsStore(settingsPath);
  const partyStateStore = new QuestPartyStateStore(partyStatePath);
  const observabilityStore = new ObservabilityStore(
    observabilityConfigPath,
    observabilityDeliveriesPath,
  );
  const runCleanup = new QuestRunCleanup(runStore, registry, secretStore);
  const runExecutor = new QuestRunExecutor(runStore, registry, secretStore);
  const runIntegrator = new QuestRunIntegrator(runStore);
  const runLander = new QuestRunLander(runStore);
  const runRefresher = new QuestRunRefresher(runStore, runIntegrator);
  const runPipeline = new QuestRunPipeline(runExecutor, runIntegrator, runLander, partyStateStore);
  const calibrator = new WorkerCalibrator(registry, runStore, runExecutor, calibrationsRoot);
  const dispatcher = new EventDispatcher(observabilityStore, secretStore);

  try {
    const result = await command.run({
      args,
      calibrator,
      daemonStore,
      dispatcher,
      observabilityStore,
      outputMode,
      partyStateStore,
      registry,
      runCleanup,
      runExecutor,
      runIntegrator,
      runLander,
      runPipeline,
      runRefresher,
      runStore,
      settingsStore,
      secretStore,
    });
    if (command.id !== "runs:watch") {
      await dispatchResultEvents(result, dispatcher);
    }
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
