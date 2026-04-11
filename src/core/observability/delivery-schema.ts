import { z } from "zod";

import { type ObservableEventType, observableEventTypeSchema } from "./event-types";
import { type ObservableEvent, observableEventSchema } from "./observable-events";
import { nonEmptyString } from "./sinks/schema-helpers";

export const deliveryStatusSchema = z.enum(["pending", "delivered", "failed"]);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

export const deliveryRecordSchema = z
  .object({
    attempts: z.number().int().min(1).max(1024),
    deliveredAt: nonEmptyString(80).optional(),
    eventId: nonEmptyString(240),
    eventType: observableEventTypeSchema,
    lastAttemptAt: nonEmptyString(80),
    lastError: nonEmptyString(1000).optional(),
    payload: observableEventSchema,
    sinkId: nonEmptyString(80),
    status: deliveryStatusSchema,
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

export type { ObservableEvent, ObservableEventType };
