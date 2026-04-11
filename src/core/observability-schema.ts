import { z } from "zod";

import type { QuestRunDocument, QuestRunEvent } from "./run-schema";

const nonEmptyString = (max: number) => z.string().trim().min(1).max(max);
const urlSchema = z.url().max(400);

export const observableRunEventTypeSchema = z.enum([
  "run_created",
  "run_blocked",
  "run_started",
  "run_completed",
  "run_failed",
  "run_aborted",
  "run_integration_started",
  "run_integration_checks_started",
  "run_integration_checks_completed",
  "run_integration_checks_failed",
  "run_integrated",
  "run_workspace_cleaned",
  "slice_started",
  "slice_integrated",
  "slice_testing_started",
  "slice_testing_completed",
  "slice_testing_failed",
  "slice_completed",
  "slice_failed",
  "slice_aborted",
]);
export type ObservableRunEventType = z.infer<typeof observableRunEventTypeSchema>;

export const observableCalibrationEventTypeSchema = z.enum(["worker_calibration_recorded"]);
export type ObservableCalibrationEventType = z.infer<typeof observableCalibrationEventTypeSchema>;

export const observableEventTypeSchema = z.union([
  observableRunEventTypeSchema,
  observableCalibrationEventTypeSchema,
]);
export type ObservableEventType = z.infer<typeof observableEventTypeSchema>;

export const webhookSinkSchema = z
  .object({
    enabled: z.boolean().default(true),
    eventTypes: z.array(observableEventTypeSchema).max(64).default([]),
    headers: z.record(z.string(), nonEmptyString(400)).default({}),
    id: nonEmptyString(80),
    secretHeader: nonEmptyString(120).optional(),
    secretRef: nonEmptyString(80).optional(),
    type: z.literal("webhook"),
    url: urlSchema,
  })
  .strict();
export type WebhookSink = z.infer<typeof webhookSinkSchema>;

export const observabilityConfigSchema = z
  .object({
    sinks: z.array(webhookSinkSchema).max(64).default([]),
    version: z.literal(1),
  })
  .strict();
export type ObservabilityConfigDocument = z.infer<typeof observabilityConfigSchema>;

export const deliveryRecordSchema = z
  .object({
    attempts: z.number().int().min(1).max(1024),
    deliveredAt: nonEmptyString(80).optional(),
    eventId: nonEmptyString(240),
    eventType: observableEventTypeSchema,
    lastAttemptAt: nonEmptyString(80),
    lastError: nonEmptyString(1000).optional(),
    sinkId: nonEmptyString(80),
    status: z.enum(["pending", "delivered", "failed"]),
  })
  .strict();
export type DeliveryRecord = z.infer<typeof deliveryRecordSchema>;

export const observabilityDeliveriesSchema = z
  .object({
    records: z.array(deliveryRecordSchema).default([]),
    version: z.literal(1),
  })
  .strict();
export type ObservabilityDeliveriesDocument = z.infer<typeof observabilityDeliveriesSchema>;

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

export type ObservableEvent = ObservableRunEvent | ObservableCalibrationEvent;

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

export function shouldDeliverEvent(sink: WebhookSink, eventType: ObservableEventType): boolean {
  return sink.enabled && (sink.eventTypes.length === 0 || sink.eventTypes.includes(eventType));
}
