import type {
  QuestRunActiveProcess,
  QuestRunCheckResult,
  QuestRunDocument,
  QuestRunEvent,
  QuestRunEventType,
  QuestRunSliceOutput,
  QuestRunSliceState,
  QuestRunSliceStatus,
  QuestRunStatus,
} from "./schema";

export function nowIsoString(): string {
  return new Date().toISOString();
}

export function appendEvent(
  run: QuestRunDocument,
  type: QuestRunEventType,
  details: QuestRunEvent["details"] = {},
  at: string = nowIsoString(),
): string {
  run.events.push({ at, details, type });
  run.updatedAt = at;
  return at;
}

export function setRunStatus(run: QuestRunDocument, status: QuestRunStatus): void {
  run.status = status;
}

export function setRunExecutionState(
  run: QuestRunDocument,
  options: {
    activeProcesses?: QuestRunActiveProcess[] | undefined;
    heartbeatAt?: string | undefined;
    hostPid?: number | undefined;
    stage?: "execute" | "integrate" | "land" | undefined;
  } = {},
): void {
  if ("activeProcesses" in options) {
    run.activeProcesses = options.activeProcesses ?? [];
  }

  if ("heartbeatAt" in options) {
    run.executionHeartbeatAt = options.heartbeatAt;
  }

  if ("hostPid" in options) {
    run.executionHostPid = options.hostPid;
  }

  if ("stage" in options) {
    run.executionStage = options.stage;
  }
}

export function setSliceStatus(
  sliceState: QuestRunSliceState,
  status: QuestRunSliceStatus,
  options: {
    completedAt?: string;
    lastChecks?: QuestRunCheckResult[] | undefined;
    lastError?: string | undefined;
    lastOutput?: QuestRunSliceOutput | undefined;
    lastTesterOutput?: QuestRunSliceOutput | undefined;
    startedAt?: string;
  } = {},
): void {
  sliceState.status = status;

  if (options.startedAt !== undefined) {
    sliceState.startedAt = options.startedAt;
  }

  if (options.completedAt !== undefined) {
    sliceState.completedAt = options.completedAt;
  }

  if (options.lastError !== undefined || "lastError" in options) {
    sliceState.lastError = options.lastError;
  }

  if (options.lastOutput !== undefined || "lastOutput" in options) {
    sliceState.lastOutput = options.lastOutput;
  }

  if (options.lastTesterOutput !== undefined || "lastTesterOutput" in options) {
    sliceState.lastTesterOutput = options.lastTesterOutput;
  }

  if (options.lastChecks !== undefined || "lastChecks" in options) {
    sliceState.lastChecks = options.lastChecks;
  }
}
