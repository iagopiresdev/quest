import { z } from "zod";
import type { DeliveryRecord } from "../delivery-schema";
import { observableEventTypeSchema } from "../event-types";
import type { ObservableEvent } from "../observable-events";
import type { EventSinkDeliveryContext, EventSinkHandler } from "./handler";
import { formatSinkTextMessage } from "./message-format";
import { nonEmptyString, secretRefSchema, urlSchema } from "./schema-helpers";
import { formatTelegramCard } from "./telegram-card-builder";

export const telegramSinkSchema = z
  .object({
    apiBaseUrl: urlSchema.optional(),
    botTokenEnv: nonEmptyString(120).optional(),
    botTokenSecretRef: secretRefSchema.optional(),
    chatId: nonEmptyString(120),
    disableNotification: z.boolean().default(false),
    enabled: z.boolean().default(true),
    eventTypes: z.array(observableEventTypeSchema).max(64).default([]),
    id: nonEmptyString(80),
    messageThreadId: z.number().int().min(1).optional(),
    parseMode: z.enum(["Markdown", "MarkdownV2", "HTML"]).optional(),
    type: z.literal("telegram"),
  })
  .strict()
  .check(
    z.superRefine((value, ctx) => {
      if (!value.botTokenEnv && !value.botTokenSecretRef) {
        ctx.addIssue({
          code: "custom",
          message: "telegram sink requires botTokenEnv or botTokenSecretRef",
          path: ["botTokenEnv"],
        });
      }
    }),
  );
export type TelegramSink = z.infer<typeof telegramSinkSchema>;

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

export class TelegramSinkHandler implements EventSinkHandler<TelegramSink> {
  readonly type = "telegram" as const;

  async deliver(sink: TelegramSink, context: EventSinkDeliveryContext): Promise<DeliveryRecord> {
    try {
      let botToken: string | undefined;
      if (sink.botTokenSecretRef) {
        botToken = await context.secretStore.getSecret(sink.botTokenSecretRef);
      } else if (sink.botTokenEnv) {
        botToken = Bun.env[sink.botTokenEnv];
      }
      if (!botToken) {
        return createFailureDelivery(
          sink.id,
          context.event,
          context.attempts,
          "Telegram bot token is not configured",
        );
      }

      const baseUrl = sink.apiBaseUrl ?? "https://api.telegram.org";
      // Render an HTML card when the sink opts into HTML parse mode; otherwise fall back to the
      // shared plain-text formatter so Markdown / no-parse-mode sinks keep working unchanged.
      const text =
        sink.parseMode === "HTML"
          ? formatTelegramCard(context.event)
          : formatSinkTextMessage(context.event);
      const response = await fetch(`${baseUrl}/bot${botToken}/sendMessage`, {
        body: JSON.stringify({
          chat_id: sink.chatId,
          disable_notification: sink.disableNotification,
          message_thread_id: sink.messageThreadId,
          parse_mode: sink.parseMode,
          text,
        }),
        headers: {
          "content-type": "application/json",
        },
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
