import { z } from "zod";

import {
  type DeliveryRecord,
  type DeliveryStatus,
  deliveryRecordSchema,
  deliveryStatusSchema,
  type ObservabilityDeliveriesDocument,
  observabilityDeliveriesSchema,
} from "./delivery-schema";
import {
  type ObservableCalibrationEventType,
  type ObservableDaemonEventType,
  type ObservableEventType,
  type ObservableRunEventType,
  observableCalibrationEventTypeSchema,
  observableDaemonEventTypeSchema,
  observableEventTypeSchema,
  observableRunEventTypeSchema,
} from "./event-types";
import {
  createObservableCalibrationEvent,
  createObservableDaemonEvent,
  createObservableRunEvent,
  type ObservableCalibrationEvent,
  type ObservableDaemonEvent,
  type ObservableEvent,
  type ObservableRunEvent,
  observableCalibrationEventSchema,
  observableDaemonEventSchema,
  observableEventSchema,
  observableRunEventSchema,
} from "./observable-events";
import {
  linearSinkSchema,
  openClawSinkSchema,
  sinkSchemas,
  slackSinkSchema,
  telegramSinkSchema,
  webhookSinkSchema,
} from "./sinks";
import type { LinearSink } from "./sinks/linear-sink";
import type { OpenClawSink } from "./sinks/openclaw-sink";
import type { SlackSink } from "./sinks/slack-sink";
import type { TelegramSink } from "./sinks/telegram-sink";
import type { WebhookSink } from "./sinks/webhook-sink";

export type {
  DeliveryRecord,
  DeliveryStatus,
  LinearSink,
  ObservabilityDeliveriesDocument,
  ObservableCalibrationEvent,
  ObservableCalibrationEventType,
  ObservableDaemonEvent,
  ObservableDaemonEventType,
  ObservableEvent,
  ObservableEventType,
  ObservableRunEvent,
  ObservableRunEventType,
  OpenClawSink,
  SlackSink,
  TelegramSink,
  WebhookSink,
};
export {
  createObservableCalibrationEvent,
  createObservableDaemonEvent,
  createObservableRunEvent,
  deliveryRecordSchema,
  deliveryStatusSchema,
  linearSinkSchema,
  observabilityDeliveriesSchema,
  observableCalibrationEventSchema,
  observableCalibrationEventTypeSchema,
  observableDaemonEventSchema,
  observableDaemonEventTypeSchema,
  observableEventSchema,
  observableEventTypeSchema,
  observableRunEventSchema,
  observableRunEventTypeSchema,
  openClawSinkSchema,
  slackSinkSchema,
  telegramSinkSchema,
  webhookSinkSchema,
};

export const observabilitySinkSchema = z.discriminatedUnion("type", [...sinkSchemas]);
export type ObservabilitySink = z.infer<typeof observabilitySinkSchema>;

export const observabilityConfigSchema = z
  .object({
    sinks: z.array(observabilitySinkSchema).max(64).default([]),
    version: z.literal(1),
  })
  .strict();
export type ObservabilityConfigDocument = z.infer<typeof observabilityConfigSchema>;

export function shouldDeliverEvent(
  sink: ObservabilitySink,
  eventType: ObservableEventType,
): boolean {
  return sink.enabled && (sink.eventTypes.length === 0 || sink.eventTypes.includes(eventType));
}
