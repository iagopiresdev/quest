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
  type ObservableEventType,
  type ObservableRunEventType,
  observableCalibrationEventTypeSchema,
  observableEventTypeSchema,
  observableRunEventTypeSchema,
} from "./event-types";
import {
  createObservableCalibrationEvent,
  createObservableRunEvent,
  type ObservableCalibrationEvent,
  type ObservableEvent,
  type ObservableRunEvent,
  observableCalibrationEventSchema,
  observableEventSchema,
  observableRunEventSchema,
} from "./observable-events";
import { sinkSchemas, telegramSinkSchema, webhookSinkSchema } from "./sinks";
import type { TelegramSink } from "./sinks/telegram-sink";
import type { WebhookSink } from "./sinks/webhook-sink";

export type {
  DeliveryRecord,
  DeliveryStatus,
  ObservabilityDeliveriesDocument,
  ObservableCalibrationEvent,
  ObservableCalibrationEventType,
  ObservableEvent,
  ObservableEventType,
  ObservableRunEvent,
  ObservableRunEventType,
  TelegramSink,
  WebhookSink,
};
export {
  createObservableCalibrationEvent,
  createObservableRunEvent,
  deliveryRecordSchema,
  deliveryStatusSchema,
  observabilityDeliveriesSchema,
  observableCalibrationEventSchema,
  observableCalibrationEventTypeSchema,
  observableEventSchema,
  observableEventTypeSchema,
  observableRunEventSchema,
  observableRunEventTypeSchema,
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
