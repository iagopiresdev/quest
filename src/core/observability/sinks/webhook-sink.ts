import { z } from "zod";
import type { DeliveryRecord, ObservableEvent } from "../../observability-schema";
import { observableEventTypeSchema } from "../event-types";
import type { EventSinkDeliveryContext, EventSinkHandler } from "./handler";
import { nonEmptyString, urlSchema } from "./schema-helpers";

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

function createFailureDelivery(
  sinkId: string,
  event: ObservableEvent,
  attempts: number,
  lastError: string,
): DeliveryRecord {
  return {
    attempts,
    eventId: event.eventId,
    eventType: event.eventType,
    lastAttemptAt: new Date().toISOString(),
    lastError,
    payload: event,
    sinkId,
    status: "failed",
  };
}

export class WebhookSinkHandler implements EventSinkHandler<WebhookSink> {
  readonly type = "webhook" as const;

  async deliver(sink: WebhookSink, context: EventSinkDeliveryContext): Promise<DeliveryRecord> {
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...sink.headers,
      };

      if (sink.secretRef && sink.secretHeader) {
        headers[sink.secretHeader] = await context.secretStore.getSecret(sink.secretRef);
      }

      const response = await fetch(sink.url, {
        body: JSON.stringify(context.event),
        headers,
        method: "POST",
      });

      if (!response.ok) {
        return createFailureDelivery(
          sink.id,
          context.event,
          context.attempts,
          `HTTP ${response.status}`,
        );
      }

      const deliveredAt = new Date().toISOString();
      return {
        attempts: context.attempts,
        deliveredAt,
        eventId: context.event.eventId,
        eventType: context.event.eventType,
        lastAttemptAt: deliveredAt,
        payload: context.event,
        sinkId: sink.id,
        status: "delivered",
      };
    } catch (error: unknown) {
      return createFailureDelivery(
        sink.id,
        context.event,
        context.attempts,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
