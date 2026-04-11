import { z } from "zod";

import type { QuestRunDocument, QuestRunEvent } from "../run-schema";
import {
  type ObservableRunEventType,
  observableCalibrationEventTypeSchema,
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

export const observableEventSchema = z.discriminatedUnion("kind", [
  observableRunEventSchema,
  observableCalibrationEventSchema,
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
