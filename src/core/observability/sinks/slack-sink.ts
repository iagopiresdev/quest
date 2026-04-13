import { z } from "zod";

import type { DeliveryRecord } from "../delivery-schema";
import { observableEventTypeSchema } from "../event-types";
import type { ObservableEvent } from "../observable-events";
import type { EventSinkDeliveryContext, EventSinkHandler } from "./handler";
import { formatSinkTextMessage } from "./message-format";
import { nonEmptyString, secretRefSchema, urlSchema } from "./schema-helpers";

export const slackSinkSchema = z
  .object({
    enabled: z.boolean().default(true),
    eventTypes: z.array(observableEventTypeSchema).max(64).default([]),
    id: nonEmptyString(80),
    secretRef: secretRefSchema.optional(),
    textPrefix: nonEmptyString(120).optional(),
    type: z.literal("slack"),
    url: urlSchema.optional(),
    urlEnv: nonEmptyString(120).optional(),
  })
  .strict()
  .check(
    z.superRefine((value, ctx) => {
      if (!value.url && !value.urlEnv && !value.secretRef) {
        ctx.addIssue({
          code: "custom",
          message: "slack sink requires url, urlEnv, or secretRef",
          path: ["url"],
        });
      }
    }),
  );
export type SlackSink = z.infer<typeof slackSinkSchema>;

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

async function resolveSlackUrl(
  sink: SlackSink,
  context: EventSinkDeliveryContext,
): Promise<string | null> {
  if (sink.url) {
    return sink.url;
  }

  if (sink.urlEnv) {
    return Bun.env[sink.urlEnv] ?? null;
  }

  if (sink.secretRef) {
    return await context.secretStore.getSecret(sink.secretRef);
  }

  return null;
}

export class SlackSinkHandler implements EventSinkHandler<SlackSink> {
  readonly type = "slack" as const;

  async deliver(sink: SlackSink, context: EventSinkDeliveryContext): Promise<DeliveryRecord> {
    try {
      const url = await resolveSlackUrl(sink, context);
      if (!url) {
        return createFailureDelivery(
          sink.id,
          context.event,
          context.attempts,
          "Slack webhook URL is not configured",
        );
      }

      const text = sink.textPrefix
        ? `${sink.textPrefix}\n${formatSinkTextMessage(context.event)}`
        : formatSinkTextMessage(context.event);
      const response = await fetch(url, {
        body: JSON.stringify({ text }),
        headers: { "content-type": "application/json" },
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
