import { z } from "zod";
import type {
  DeliveryRecord,
  ObservableCalibrationEvent,
  ObservableEvent,
  ObservableRunEvent,
} from "../../observability-schema";
import { observableEventTypeSchema } from "../event-types";
import type { EventSinkDeliveryContext, EventSinkHandler } from "./handler";
import { nonEmptyString, secretRefSchema, urlSchema } from "./schema-helpers";

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
  .superRefine((value, ctx) => {
    if (!value.botTokenEnv && !value.botTokenSecretRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "telegram sink requires botTokenEnv or botTokenSecretRef",
        path: ["botTokenEnv"],
      });
    }
  });
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

function formatTelegramRunMessage(event: ObservableRunEvent): string {
  return [
    "quest-runner event",
    `event: ${event.eventType}`,
    `run: ${event.runId}`,
    `title: ${event.title}`,
    `status: ${event.runStatus}`,
    `workspace: ${event.workspace}`,
  ].join("\n");
}

function formatTelegramCalibrationMessage(event: ObservableCalibrationEvent): string {
  return [
    "quest-runner calibration",
    `event: ${event.eventType}`,
    `worker: ${event.workerName} (${event.workerId})`,
    `suite: ${event.suiteId}`,
    `status: ${event.status}`,
    `score: ${event.score}`,
    `xp: ${event.xpAwarded}`,
    `run: ${event.runId}`,
  ].join("\n");
}

function formatTelegramMessage(event: ObservableEvent): string {
  return event.kind === "run"
    ? formatTelegramRunMessage(event)
    : formatTelegramCalibrationMessage(event);
}

export class TelegramSinkHandler implements EventSinkHandler<TelegramSink> {
  readonly type = "telegram" as const;

  async deliver(sink: TelegramSink, context: EventSinkDeliveryContext): Promise<DeliveryRecord> {
    try {
      const botToken = sink.botTokenSecretRef
        ? await context.secretStore.getSecret(sink.botTokenSecretRef)
        : sink.botTokenEnv
          ? Bun.env[sink.botTokenEnv]
          : undefined;
      if (!botToken) {
        return createFailureDelivery(
          sink.id,
          context.event,
          context.attempts,
          "Telegram bot token is not configured",
        );
      }

      const baseUrl = sink.apiBaseUrl ?? "https://api.telegram.org";
      const response = await fetch(`${baseUrl}/bot${botToken}/sendMessage`, {
        body: JSON.stringify({
          chat_id: sink.chatId,
          disable_notification: sink.disableNotification,
          message_thread_id: sink.messageThreadId,
          parse_mode: sink.parseMode,
          text: formatTelegramMessage(context.event),
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
