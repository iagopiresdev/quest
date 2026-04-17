import { z } from "zod";

import type { QuestRunDocument, QuestRunEvent } from "../runs/schema";
import {
  type ObservableDaemonEventType,
  type ObservableRunEventType,
  observableCalibrationEventTypeSchema,
  observableDaemonEventTypeSchema,
  observableRunEventTypeSchema,
} from "./event-types";
import { nonEmptyString } from "./sinks/schema-helpers";

export const observableRunEventSchema = z
  .object({
    details: z.record(z.string(), z.unknown()),
    eventId: nonEmptyString(240),
    eventType: observableRunEventTypeSchema,
    kind: z.literal("run"),
    occurredAt: nonEmptyString(80),
    runId: nonEmptyString(80),
    runStatus: nonEmptyString(80),
    sourceRepositoryPath: nonEmptyString(400).nullable(),
    title: nonEmptyString(160),
    // Optional external tracker issue id pulled from `run.spec.tracker.linear.issueId` when the
    // spec opts in. Null for specs without a tracker block. Threaded through run-level events so
    // testing/review/blocked transitions can move the same Linear card as dispatch/land.
    trackerIssueId: nonEmptyString(120).nullable().default(null),
    workspace: nonEmptyString(160),
  })
  .strict();
export type ObservableRunEvent = z.infer<typeof observableRunEventSchema>;

export const observableCalibrationEventSchema = z
  .object({
    eventId: nonEmptyString(240),
    eventType: observableCalibrationEventTypeSchema,
    kind: z.literal("worker_calibration"),
    occurredAt: nonEmptyString(80),
    runId: nonEmptyString(80),
    score: z.number().int().min(0).max(100),
    status: z.enum(["passed", "failed"]),
    suiteId: nonEmptyString(80),
    workerId: nonEmptyString(80),
    workerName: nonEmptyString(80),
    xpAwarded: z.number().int().min(0).max(5000),
  })
  .strict();
export type ObservableCalibrationEvent = z.infer<typeof observableCalibrationEventSchema>;

export const observableDaemonEventSchema = z
  .object({
    error: nonEmptyString(1000).nullable(),
    eventId: nonEmptyString(240),
    eventType: observableDaemonEventTypeSchema,
    kind: z.literal("daemon"),
    occurredAt: nonEmptyString(80),
    partyName: nonEmptyString(120),
    reason: nonEmptyString(240).nullable(),
    runId: nonEmptyString(80).nullable(),
    // Party-admin and global-state events (party_created/resting/resumed, budget_exhausted) are not
    // tied to a specific spec file; nullable keeps the schema honest instead of coercing "".
    specFile: nonEmptyString(240).nullable(),
    // Optional external tracker issue id (e.g. Linear TEAM-123), populated by the daemon when a
    // spec carries a `tracker.linear.issueId` block. Null for admin events and tracker-less specs.
    trackerIssueId: nonEmptyString(120).nullable().default(null),
  })
  .strict();
export type ObservableDaemonEvent = z.infer<typeof observableDaemonEventSchema>;

export const observableEventSchema = z.discriminatedUnion("kind", [
  observableRunEventSchema,
  observableCalibrationEventSchema,
  observableDaemonEventSchema,
]);
export type ObservableEvent = z.infer<typeof observableEventSchema>;

export function createObservableRunEvent(
  run: QuestRunDocument,
  event: QuestRunEvent,
  index: number,
): ObservableRunEvent {
  return {
    details: event.details,
    eventId: `run:${run.id}:${index}:${event.type}:${event.at}`,
    eventType: event.type as ObservableRunEventType,
    kind: "run",
    occurredAt: event.at,
    runId: run.id,
    runStatus: run.status,
    sourceRepositoryPath: run.sourceRepositoryPath ?? null,
    title: run.spec.title,
    trackerIssueId: run.spec.tracker?.linear?.issueId ?? null,
    workspace: run.spec.workspace,
  };
}

export function createObservableCalibrationEvent(input: {
  at: string;
  runId: string;
  score: number;
  status: "passed" | "failed";
  suiteId: string;
  workerId: string;
  workerName: string;
  xpAwarded: number;
}): ObservableCalibrationEvent {
  return {
    eventId: `worker-calibration:${input.runId}:${input.workerId}:${input.suiteId}:${input.at}`,
    eventType: "worker_calibration_recorded",
    kind: "worker_calibration",
    occurredAt: input.at,
    runId: input.runId,
    score: input.score,
    status: input.status,
    suiteId: input.suiteId,
    workerId: input.workerId,
    workerName: input.workerName,
    xpAwarded: input.xpAwarded,
  };
}

export function createObservableDaemonEvent(input: {
  at: string;
  error?: string | undefined;
  eventType: ObservableDaemonEventType;
  partyName: string;
  reason?: string | undefined;
  runId?: string | undefined;
  specFile?: string | null | undefined;
  trackerIssueId?: string | null | undefined;
}): ObservableDaemonEvent {
  const specFile = input.specFile && input.specFile.length > 0 ? input.specFile : null;
  const trackerIssueId =
    input.trackerIssueId && input.trackerIssueId.length > 0 ? input.trackerIssueId : null;
  return {
    error: input.error ?? null,
    eventId: `daemon:${input.eventType}:${input.partyName}:${specFile ?? "-"}:${input.at}`,
    eventType: input.eventType,
    kind: "daemon",
    occurredAt: input.at,
    partyName: input.partyName,
    reason: input.reason ?? null,
    runId: input.runId ?? null,
    specFile,
    trackerIssueId,
  };
}
