import { readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { QuestDomainError } from "../errors";
import { createObservableDaemonEvent, type ObservableDaemonEvent } from "../observability/schema";
import { QuestPartyStateStore } from "../party-state";
import { isPidAlive } from "../runs/process-monitor";
import { ensureDirectory, writeJsonFileAtomically } from "../storage";
import type { QuestDaemonProcess, QuestDaemonState, QuestParty } from "./schema";
import { questDaemonResultSchema, questDaemonSpecDocumentSchema } from "./schema";
import type { QuestDaemonStore, QuestPartyDirectories } from "./store";
import {
  type QuestDaemonTickDependencies,
  type QuestDaemonTickOutcome,
  resolveQuestCliCommand,
  runDaemonTick,
} from "./tick";

const SUPPORTED_SPEC_EXTENSIONS = [".json", ".yaml", ".yml"] as const;

export type QuestDaemonPartyStatus = {
  activeRunIds: string[];
  cooldownUntil: string | null;
  lastError: string | null;
  party: QuestParty;
  queueDepths: Record<keyof QuestPartyDirectories, number> | null;
  restReason: string | null;
};

export type QuestDaemonStatus = {
  parties: QuestDaemonPartyStatus[];
  process: QuestDaemonProcess | null;
  running: boolean;
  staleProcess: boolean;
  stateRoot: string;
};

export type RunDaemonTickLoopResult = {
  events: ObservableDaemonEvent[];
  outcomes: QuestDaemonTickOutcome[];
  stopped: boolean;
};

type TickLoopOptions = {
  cwd?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  onTickEvents?: ((events: ObservableDaemonEvent[]) => Promise<void>) | undefined;
  partyStateStore?: QuestPartyStateStore | undefined;
  questCommand?: string[] | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  tick?: typeof runDaemonTick | undefined;
};

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

function buildRecoveredSpecPayload(raw: unknown): unknown {
  const parsed = questDaemonSpecDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      daemon_result: questDaemonResultSchema.parse({
        completedAt: new Date().toISOString(),
        error: "Recovered unreadable spec from running queue",
        status: "retrying",
      }),
      invalid_input: raw,
    };
  }

  return questDaemonSpecDocumentSchema.parse({
    ...parsed.data,
    daemon_result: questDaemonResultSchema.parse({
      ...parsed.data.daemon_result,
      error: "Recovered spec from running queue",
      status: "retrying",
    }),
  });
}

function mergeTickState(latest: QuestDaemonState, next: QuestDaemonState): QuestDaemonState {
  return {
    ...latest,
    activeRunIds: next.activeRunIds,
    completedSpecTimestamps: next.completedSpecTimestamps,
    cooldownUntil: next.cooldownUntil,
    lastErrorByParty: next.lastErrorByParty,
    lastTickTime: next.lastTickTime,
    process: latest.process,
  };
}

async function clearStaleProcess(store: QuestDaemonStore): Promise<void> {
  const state = await store.readState();
  if (!state.process || isPidAlive(state.process.pid)) {
    return;
  }

  await store.updateProcess(null);
}

async function recoverPartyRunningSpecs(
  store: QuestDaemonStore,
  state: QuestDaemonState,
  partyName: string,
  events: ObservableDaemonEvent[],
): Promise<void> {
  const directories = await store.ensurePartyDirectories(partyName);
  const runningFiles = (await readdir(directories.running).catch(() => []))
    .filter(isSpecFileName)
    .sort((left, right) => left.localeCompare(right));

  for (const fileName of runningFiles) {
    const runningPath = join(directories.running, fileName);
    const inboxPath = join(directories.inbox, fileName);
    const raw = await readSpecInput(runningPath).catch(() => null);
    await writeSpecInput(runningPath, buildRecoveredSpecPayload(raw));
    await moveSpecFile(runningPath, inboxPath);
    events.push(
      createObservableDaemonEvent({
        at: new Date().toISOString(),
        eventType: "daemon_recovered",
        partyName,
        reason: "running_queue_recovered",
        specFile: fileName,
      }),
    );
  }

  state.activeRunIds[partyName] = [];
}

async function recoverRunningSpecs(store: QuestDaemonStore): Promise<ObservableDaemonEvent[]> {
  const state = await store.readState();
  const events: ObservableDaemonEvent[] = [];
  for (const party of state.parties) {
    await recoverPartyRunningSpecs(store, state, party.name, events);
  }
  await store.writeState(state);
  return events;
}

function buildTickDependencies(
  store: QuestDaemonStore,
  options: TickLoopOptions,
): QuestDaemonTickDependencies {
  return {
    cwd: options.cwd,
    daemonStore: store,
    env: options.env,
    partyStateStore:
      options.partyStateStore ??
      new QuestPartyStateStore(join(store.getStateRoot(), "party-state.json")),
    questCommand: options.questCommand ?? resolveQuestCliCommand(),
  };
}

async function waitForNextTick(
  store: QuestDaemonStore,
  durationMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  let remainingMs = durationMs;
  while (remainingMs > 0) {
    const chunkMs = Math.min(remainingMs, 250);
    await sleep(chunkMs);
    remainingMs -= chunkMs;
    if ((await store.readState()).process?.stopRequested) {
      return true;
    }
  }

  return false;
}

export async function startDaemon(
  store: QuestDaemonStore,
  options: {
    env?: Record<string, string | undefined> | undefined;
    questCommand?: string[] | undefined;
  } = {},
): Promise<QuestDaemonStatus> {
  await clearStaleProcess(store);
  const state = await store.readState();
  if (state.process) {
    throw new QuestDomainError({
      code: "quest_daemon_already_running",
      details: { pid: state.process.pid, startedAt: state.process.startedAt },
      message: "Quest daemon is already running",
      statusCode: 1,
    });
  }

  await ensureDirectory(store.getStateRoot());
  const command = [
    ...(options.questCommand ?? resolveQuestCliCommand()),
    "daemon",
    "_tick-loop",
    "--state-root",
    store.getStateRoot(),
  ];
  const child = Bun.spawn({
    cmd: command,
    cwd: store.getStateRoot(),
    env: {
      ...Bun.env,
      ...options.env,
    },
    stderr: "ignore",
    stdin: "ignore",
    stdout: "ignore",
  });
  child.unref();
  await store.updateProcess({
    pid: child.pid,
    startedAt: new Date().toISOString(),
    stopRequested: false,
  });
  return await daemonStatus(store);
}

export async function stopDaemon(store: QuestDaemonStore): Promise<QuestDaemonStatus> {
  await clearStaleProcess(store);
  await store.requestStop();
  return await daemonStatus(store);
}

export async function daemonStatus(store: QuestDaemonStore): Promise<QuestDaemonStatus> {
  const state = await store.readState();
  const process = state.process ?? null;
  const running = process ? isPidAlive(process.pid) : false;
  const parties = await Promise.all(
    state.parties.map(async (party) => ({
      activeRunIds: state.activeRunIds[party.name] ?? [],
      cooldownUntil: state.cooldownUntil[party.name] ?? null,
      lastError: state.lastErrorByParty[party.name] ?? null,
      party,
      queueDepths: await store.listQueueDepths(party.name),
      restReason: state.partyRestReasons[party.name] ?? null,
    })),
  );

  return {
    parties,
    process,
    running,
    staleProcess: process !== null && !running,
    stateRoot: store.getStateRoot(),
  };
}

// Single-shot tick used by canaries and scripted operator checks that want one dispatch pass
// without spinning up the long-running supervisor. The loop version remains the production path.
export async function runSingleDaemonTick(
  store: QuestDaemonStore,
  options: Omit<TickLoopOptions, "sleep"> = {},
): Promise<{
  events: ObservableDaemonEvent[];
  outcomes: QuestDaemonTickOutcome[];
  recoveredEvents: ObservableDaemonEvent[];
}> {
  const tick = options.tick ?? runDaemonTick;
  const deps = buildTickDependencies(store, options);
  const recoveredEvents = await recoverRunningSpecs(store);
  if (recoveredEvents.length > 0) {
    await options.onTickEvents?.(recoveredEvents);
  }

  const config = await store.readConfig();
  const currentState = await store.readState();
  const tickResult = await tick(currentState, config, deps);
  const latestState = await store.readState();
  await store.writeState(mergeTickState(latestState, tickResult.state));
  if (tickResult.events.length > 0) {
    await options.onTickEvents?.(tickResult.events);
  }

  return {
    events: tickResult.events,
    outcomes: tickResult.outcomes,
    recoveredEvents,
  };
}

export async function runDaemonTickLoop(
  store: QuestDaemonStore,
  options: TickLoopOptions = {},
): Promise<RunDaemonTickLoopResult> {
  const tick = options.tick ?? runDaemonTick;
  const sleep = options.sleep ?? Bun.sleep;
  const deps = buildTickDependencies(store, options);
  const outcomes: QuestDaemonTickOutcome[] = [];
  const events: ObservableDaemonEvent[] = [];

  const recoveryEvents = await recoverRunningSpecs(store);
  events.push(...recoveryEvents);
  if (recoveryEvents.length > 0) {
    await options.onTickEvents?.(recoveryEvents);
  }

  try {
    while (true) {
      const currentState = await store.readState();
      if (currentState.process?.stopRequested) {
        return { events, outcomes, stopped: true };
      }

      const config = await store.readConfig();
      const tickResult = await tick(currentState, config, deps);
      outcomes.push(...tickResult.outcomes);
      events.push(...tickResult.events);
      const latestState = await store.readState();
      await store.writeState(mergeTickState(latestState, tickResult.state));
      if (tickResult.events.length > 0) {
        await options.onTickEvents?.(tickResult.events);
      }

      if ((await store.readState()).process?.stopRequested) {
        return { events, outcomes, stopped: true };
      }

      if (await waitForNextTick(store, config.tickIntervalMs, sleep)) {
        return { events, outcomes, stopped: true };
      }
    }
  } finally {
    await store.updateProcess(null);
  }
}
