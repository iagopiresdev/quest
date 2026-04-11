import {
  type QuestRunCheckResult,
  type QuestRunDocument,
  type QuestRunEvent,
  type QuestRunEventType,
  type QuestRunSliceOutput,
  type QuestRunSliceState,
  type QuestRunSliceStatus,
  type QuestRunStatus,
} from "./run-schema";

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

export function setSliceStatus(
  sliceState: QuestRunSliceState,
  status: QuestRunSliceStatus,
  options: {
    completedAt?: string;
    lastChecks?: QuestRunCheckResult[] | undefined;
    lastError?: string | undefined;
    lastOutput?: QuestRunSliceOutput | undefined;
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

  if (options.lastChecks !== undefined || "lastChecks" in options) {
    sliceState.lastChecks = options.lastChecks;
  }
}
