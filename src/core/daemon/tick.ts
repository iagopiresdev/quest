import { readdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { QuestPartyStateStore } from "../party-state";
import { questSpecSchema } from "../planning/spec-schema";
import { runSubprocess, type SubprocessResult } from "../runs/process";
import { isRecord } from "../shared/type-guards";
import { ensureDirectory, writeJsonFileAtomically } from "../storage";
import {
  type QuestDaemonConfig,
  type QuestDaemonResult,
  type QuestDaemonSpecDocument,
  type QuestDaemonState,
  type QuestParty,
  questDaemonResultSchema,
  questDaemonSpecDocumentSchema,
} from "./schema";
import type { QuestDaemonStore, QuestPartyDirectories } from "./store";

const SUPPORTED_SPEC_EXTENSIONS = [".json", ".yaml", ".yml"] as const;

export type QuestDaemonTickOutcome =
  | { party: string; reason: string; type: "party_skipped" }
  | { party: string; runId?: string; specFile: string; type: "spec_done" }
  | { error: string; party: string; runId?: string; specFile: string; type: "spec_failed" }
  | { reason: string; type: "tick_complete" };

export type QuestDaemonTickDependencies = {
  cwd?: string | undefined;
  daemonStore: QuestDaemonStore;
  env?: Record<string, string | undefined> | undefined;
  now?: (() => Date) | undefined;
  partyStateStore: QuestPartyStateStore;
  questCommand?: string[] | undefined;
};

type SpecCandidate = {
  document: QuestDaemonSpecDocument;
  fileName: string;
  inboxPath: string;
};

type InvalidSpecCandidate = {
  error: string;
  fileName: string;
};

type TickFailureResult = {
  error: string;
  runId?: string | undefined;
};

export function resolveQuestCliCommand(): string[] {
  const installedCommand = Bun.which("quest");
  if (installedCommand) {
    return [installedCommand];
  }

  return [resolve(import.meta.dir, "../../../bin/quest")];
}

function readNow(deps: QuestDaemonTickDependencies): Date {
  return deps.now?.() ?? new Date();
}

function isSpecFileName(fileName: string): boolean {
  return SUPPORTED_SPEC_EXTENSIONS.some((extension) => fileName.endsWith(extension));
}

async function readSpecInput(path: string): Promise<unknown> {
  const content = await Bun.file(path).text();
  if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    return Bun.YAML.parse(content) as unknown;
  }

  return JSON.parse(content) as unknown;
}

async function writeSpecInput(path: string, payload: unknown): Promise<void> {
  await ensureDirectory(dirname(path));
  await writeJsonFileAtomically(path, payload);
}

async function moveSpecFile(sourcePath: string, destinationPath: string): Promise<void> {
  await ensureDirectory(dirname(destinationPath));
  await rename(sourcePath, destinationPath);
}

function compareCandidates(left: SpecCandidate, right: SpecCandidate): number {
  const priorityDifference = left.document.priority - right.document.priority;
  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  return left.fileName.localeCompare(right.fileName);
}

function buildFailureMessage(result: SubprocessResult, label: string): string {
  const stderr = result.stderr.trim();
  if (stderr) {
    try {
      const parsed = JSON.parse(stderr) as unknown;
      if (isRecord(parsed) && typeof parsed.message === "string" && parsed.message.trim()) {
        return parsed.message;
      }
    } catch {
      // Fall back to plain stderr when the command did not emit structured JSON.
    }
  }

  const stdout = result.stdout.trim();
  const detail = stderr || stdout || `${label} exited with code ${result.exitCode}`;
  return `${label} failed: ${detail}`.slice(0, 2_000);
}

const DAEMON_ONLY_KEYS = ["daemon_result", "priority", "retry_count", "retry_limit"] as const;

function stripDaemonFields(document: QuestDaemonSpecDocument): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (!DAEMON_ONLY_KEYS.includes(key as (typeof DAEMON_ONLY_KEYS)[number])) {
      clean[key] = value;
    }
  }
  return clean;
}

function serializeQuestSpecInput(document: QuestDaemonSpecDocument): string {
  const clean = stripDaemonFields(document);
  return JSON.stringify(questSpecSchema.parse(clean), null, 2);
}

function updateDaemonResult(
  document: QuestDaemonSpecDocument,
  patch: Partial<QuestDaemonResult>,
): QuestDaemonSpecDocument {
  return questDaemonSpecDocumentSchema.parse({
    ...document,
    daemon_result: questDaemonResultSchema.parse({
      ...document.daemon_result,
      ...patch,
    }),
  });
}

function buildFailurePayload(raw: unknown, message: string, now: string): unknown {
  const daemonResult = questDaemonResultSchema.parse({
    completedAt: now,
    error: message.slice(0, 2_000),
    status: "failed",
  });
  if (isRecord(raw)) {
    return {
      ...raw,
      daemon_result: daemonResult,
    };
  }

  return {
    daemon_result: daemonResult,
    invalid_input: raw,
  };
}

async function listInboxCandidates(directories: QuestPartyDirectories): Promise<{
  candidates: SpecCandidate[];
  invalid: InvalidSpecCandidate[];
}> {
  let entries: string[];
  try {
    entries = await readdir(directories.inbox);
  } catch {
    return { candidates: [], invalid: [] };
  }

  const candidates: SpecCandidate[] = [];
  const invalid: InvalidSpecCandidate[] = [];
  for (const fileName of entries.filter(isSpecFileName)) {
    const inboxPath = join(directories.inbox, fileName);
    let raw: unknown;
    try {
      raw = await readSpecInput(inboxPath);
    } catch (error: unknown) {
      invalid.push({
        error: error instanceof Error ? error.message : String(error),
        fileName,
      });
      continue;
    }

    const parsed = questDaemonSpecDocumentSchema.safeParse(raw);
    if (parsed.success) {
      candidates.push({
        document: parsed.data,
        fileName,
        inboxPath,
      });
      continue;
    }

    invalid.push({
      error: parsed.error.message,
      fileName,
    });
  }

  return {
    candidates: candidates.sort(compareCandidates),
    invalid,
  };
}

async function failUnreadableSpec(
  directories: QuestPartyDirectories,
  fileName: string,
  error: unknown,
): Promise<TickFailureResult> {
  const inboxPath = join(directories.inbox, fileName);
  const failedPath = join(directories.failed, fileName);
  const message = error instanceof Error ? error.message : String(error);
  const failedAt = new Date().toISOString();
  const raw = await readSpecInput(inboxPath).catch(() => null);

  await writeSpecInput(inboxPath, buildFailurePayload(raw, message, failedAt));
  await moveSpecFile(inboxPath, failedPath);
  return { error: message.slice(0, 2_000) };
}

function countRecentSpecs(timestamps: string[], now: Date): number {
  const cutoff = now.getTime() - 60 * 60 * 1_000;
  return timestamps.filter((timestamp) => Date.parse(timestamp) >= cutoff).length;
}

function pruneCompletedTimestamps(timestamps: string[], now: Date): string[] {
  const cutoff = now.getTime() - 60 * 60 * 1_000;
  return timestamps.filter((timestamp) => Date.parse(timestamp) >= cutoff).sort();
}

function isPartyInCooldown(state: QuestDaemonState, partyName: string, now: Date): boolean {
  const cooldownUntil = state.cooldownUntil[partyName];
  return cooldownUntil !== undefined && Date.parse(cooldownUntil) > now.getTime();
}

function removeActiveRunId(state: QuestDaemonState, partyName: string, runId?: string): void {
  if (!runId) {
    return;
  }

  state.activeRunIds[partyName] = (state.activeRunIds[partyName] ?? []).filter(
    (candidate) => candidate !== runId,
  );
}

function markPartyFailure(
  state: QuestDaemonState,
  config: QuestDaemonConfig,
  partyName: string,
  message: string,
  failedAt: Date,
): void {
  state.cooldownUntil[partyName] = new Date(failedAt.getTime() + config.cooldownMs).toISOString();
  state.lastErrorByParty[partyName] = message.slice(0, 2_000);
}

async function runQuestCommand(
  deps: QuestDaemonTickDependencies,
  commandArgs: string[],
  stdin?: string | undefined,
): Promise<SubprocessResult> {
  return await runSubprocess({
    cmd: [...(deps.questCommand ?? resolveQuestCliCommand()), ...commandArgs],
    cwd: deps.cwd ?? deps.daemonStore.getStateRoot(),
    env: {
      ...Bun.env,
      ...deps.env,
    },
    stdin,
  });
}

function extractRunId(result: SubprocessResult): string {
  const parsed = JSON.parse(result.stdout) as unknown;
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.run) ||
    typeof parsed.run.id !== "string" ||
    parsed.run.id.trim().length === 0
  ) {
    throw new Error("quest run did not return a run id");
  }

  return parsed.run.id;
}

async function withPreparedQuestSpecFile<T>(
  specPath: string,
  document: QuestDaemonSpecDocument,
  work: (preparedPath: string) => Promise<T>,
): Promise<T> {
  const preparedPath = `${specPath}.prepared.json`;
  await writeSpecInput(preparedPath, JSON.parse(serializeQuestSpecInput(document)) as unknown);

  try {
    return await work(preparedPath);
  } finally {
    await unlink(preparedPath).catch(() => undefined);
  }
}

async function planDaemonSpec(
  deps: QuestDaemonTickDependencies,
  stateRoot: string,
  specPath: string,
  document: QuestDaemonSpecDocument,
): Promise<void> {
  await withPreparedQuestSpecFile(specPath, document, async (preparedPath) => {
    const planResult = await runQuestCommand(deps, [
      "plan",
      "--file",
      preparedPath,
      "--state-root",
      stateRoot,
    ]);
    if (planResult.exitCode !== 0) {
      throw new Error(buildFailureMessage(planResult, "quest plan"));
    }
  });
}

async function createRunFromSpec(
  deps: QuestDaemonTickDependencies,
  stateRoot: string,
  specPath: string,
  document: QuestDaemonSpecDocument,
): Promise<string> {
  return await withPreparedQuestSpecFile(specPath, document, async (preparedPath) => {
    const runResult = await runQuestCommand(deps, [
      "run",
      "--file",
      preparedPath,
      "--state-root",
      stateRoot,
    ]);
    if (runResult.exitCode !== 0) {
      throw new Error(buildFailureMessage(runResult, "quest run"));
    }

    return extractRunId(runResult);
  });
}

async function executeRunForParty(
  deps: QuestDaemonTickDependencies,
  stateRoot: string,
  party: QuestParty,
  runId: string,
): Promise<void> {
  const executeResult = await runQuestCommand(deps, [
    "runs",
    "execute",
    "--id",
    runId,
    "--auto-integrate",
    "--land",
    "--source-repo",
    party.sourceRepo,
    "--target-ref",
    party.targetRef,
    "--state-root",
    stateRoot,
  ]);
  if (executeResult.exitCode !== 0) {
    throw new Error(buildFailureMessage(executeResult, "quest runs execute"));
  }
}

async function completeSpecSuccess(
  runningPath: string,
  destinationPath: string,
  document: QuestDaemonSpecDocument,
  runId: string,
): Promise<void> {
  const completedAt = new Date().toISOString();
  await writeSpecInput(
    runningPath,
    updateDaemonResult(document, {
      completedAt,
      runId,
      status: "done",
    }),
  );
  await moveSpecFile(runningPath, destinationPath);
}

async function completeSpecFailure(
  runningPath: string,
  destinationPath: string,
  document: QuestDaemonSpecDocument,
  error: string,
  runId?: string,
): Promise<void> {
  await writeSpecInput(
    runningPath,
    updateDaemonResult(document, {
      completedAt: new Date().toISOString(),
      error: error.slice(0, 2_000),
      runId,
      status: "failed",
    }),
  );
  await moveSpecFile(runningPath, destinationPath);
}

async function processCandidateSpec(
  state: QuestDaemonState,
  config: QuestDaemonConfig,
  deps: QuestDaemonTickDependencies,
  party: QuestParty,
  directories: QuestPartyDirectories,
  candidate: SpecCandidate,
): Promise<QuestDaemonTickOutcome> {
  const startedAt = readNow(deps).toISOString();
  const stateRoot = deps.daemonStore.getStateRoot();
  const runningPath = join(directories.running, candidate.fileName);
  const donePath = join(directories.done, candidate.fileName);
  const failedPath = join(directories.failed, candidate.fileName);
  let runId: string | undefined;
  const runningDocument = updateDaemonResult(candidate.document, {
    startedAt,
    status: "running",
  });

  await moveSpecFile(candidate.inboxPath, runningPath);
  await writeSpecInput(runningPath, runningDocument);

  try {
    await planDaemonSpec(deps, stateRoot, runningPath, runningDocument);
    runId = await createRunFromSpec(deps, stateRoot, runningPath, runningDocument);
    state.activeRunIds[party.name] = [...(state.activeRunIds[party.name] ?? []), runId];
    // Status and crash recovery depend on active runs being durable before long-lived execution starts.
    await deps.daemonStore.writeState(state);
    await executeRunForParty(deps, stateRoot, party, runId);
    removeActiveRunId(state, party.name, runId);
    await completeSpecSuccess(runningPath, donePath, runningDocument, runId);
    state.completedSpecTimestamps[party.name] = pruneCompletedTimestamps(
      [...(state.completedSpecTimestamps[party.name] ?? []), new Date().toISOString()],
      readNow(deps),
    );
    state.lastErrorByParty[party.name] = null;
    return {
      party: party.name,
      runId,
      specFile: candidate.fileName,
      type: "spec_done",
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    removeActiveRunId(state, party.name, runId);
    await completeSpecFailure(runningPath, failedPath, runningDocument, message, runId);
    markPartyFailure(state, config, party.name, message, readNow(deps));
    return {
      error: message.slice(0, 2_000),
      party: party.name,
      ...(runId ? { runId } : {}),
      specFile: candidate.fileName,
      type: "spec_failed",
    };
  }
}

function canDispatchForParty(state: QuestDaemonState, party: QuestParty, now: Date): string | null {
  if (state.partyRestReasons[party.name] !== undefined) {
    return "party_resting";
  }

  if (!party.enabled) {
    return "disabled";
  }

  if (isPartyInCooldown(state, party.name, now)) {
    return "cooldown";
  }

  const activeRunIds = state.activeRunIds[party.name] ?? [];
  if (activeRunIds.length >= party.budget.maxConcurrent) {
    return "max_concurrent";
  }

  const completedCount = countRecentSpecs(state.completedSpecTimestamps[party.name] ?? [], now);
  if (completedCount >= party.budget.maxSpecsPerHour) {
    return "hourly_budget";
  }

  return null;
}

export async function runDaemonTick(
  state: QuestDaemonState,
  config: QuestDaemonConfig,
  deps: QuestDaemonTickDependencies,
): Promise<{ outcomes: QuestDaemonTickOutcome[]; state: QuestDaemonState }> {
  const now = readNow(deps);
  const outcomes: QuestDaemonTickOutcome[] = [];
  const globalPartyState = await deps.partyStateStore.readState();

  state.lastTickTime = now.toISOString();
  if (globalPartyState.status === "resting") {
    return {
      outcomes: [{ reason: globalPartyState.reason ?? "global_bonfire", type: "tick_complete" }],
      state,
    };
  }

  for (const party of state.parties) {
    state.activeRunIds[party.name] = state.activeRunIds[party.name] ?? [];
    state.completedSpecTimestamps[party.name] = pruneCompletedTimestamps(
      state.completedSpecTimestamps[party.name] ?? [],
      now,
    );
    state.lastErrorByParty[party.name] = state.lastErrorByParty[party.name] ?? null;

    const skipReason = canDispatchForParty(state, party, now);
    if (skipReason) {
      outcomes.push({ party: party.name, reason: skipReason, type: "party_skipped" });
      continue;
    }

    const directories = await deps.daemonStore.ensurePartyDirectories(party.name);
    const inboxFiles = (await readdir(directories.inbox).catch(() => []))
      .filter(isSpecFileName)
      .sort((left, right) => left.localeCompare(right));
    if (inboxFiles.length === 0) {
      outcomes.push({ party: party.name, reason: "empty_inbox", type: "party_skipped" });
      continue;
    }

    try {
      const { candidates, invalid } = await listInboxCandidates(directories);
      for (const invalidSpec of invalid) {
        const failure = await failUnreadableSpec(
          directories,
          invalidSpec.fileName,
          invalidSpec.error,
        );
        state.lastErrorByParty[party.name] = failure.error;
        outcomes.push({
          error: failure.error,
          party: party.name,
          specFile: invalidSpec.fileName,
          type: "spec_failed",
        });
      }

      if (candidates.length === 0) {
        continue;
      }

      const candidate = candidates[0];
      if (!candidate) {
        outcomes.push({ party: party.name, reason: "empty_inbox", type: "party_skipped" });
        continue;
      }

      outcomes.push(await processCandidateSpec(state, config, deps, party, directories, candidate));
    } catch (error: unknown) {
      const failure = await failUnreadableSpec(directories, inboxFiles[0] ?? "", error);
      markPartyFailure(state, config, party.name, failure.error, now);
      outcomes.push({
        error: failure.error,
        party: party.name,
        specFile: inboxFiles[0] ?? "unknown",
        type: "spec_failed",
      });
    }
  }

  outcomes.push({ reason: "complete", type: "tick_complete" });
  return { outcomes, state };
}
