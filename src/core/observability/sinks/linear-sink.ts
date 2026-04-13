import { z } from "zod";

import type { DeliveryRecord } from "../delivery-schema";
import { observableEventTypeSchema } from "../event-types";
import type { ObservableEvent } from "../observable-events";
import type { EventSinkDeliveryContext, EventSinkHandler } from "./handler";
import { formatSinkTextMessage } from "./message-format";
import { nonEmptyString, secretRefSchema, urlSchema } from "./schema-helpers";

export const linearSinkSchema = z
  .object({
    apiBaseUrl: urlSchema.default("https://api.linear.app/graphql"),
    apiKeyEnv: nonEmptyString(120).optional(),
    apiKeySecretRef: secretRefSchema.optional(),
    enabled: z.boolean().default(true),
    eventTypes: z.array(observableEventTypeSchema).max(64).default([]),
    id: nonEmptyString(80),
    issueId: nonEmptyString(120),
    titlePrefix: nonEmptyString(120).optional(),
    type: z.literal("linear"),
  })
  .strict()
  .check(
    z.superRefine((value, ctx) => {
      if (!value.apiKeyEnv && !value.apiKeySecretRef) {
        ctx.addIssue({
          code: "custom",
          message: "linear sink requires apiKeyEnv or apiKeySecretRef",
          path: ["apiKeyEnv"],
        });
      }
    }),
  );
export type LinearSink = z.infer<typeof linearSinkSchema>;

const linearResponseSchema = z
  .object({
    data: z
      .object({
        commentCreate: z
          .object({
            success: z.boolean(),
          })
          .passthrough(),
      })
      .passthrough()
      .optional(),
    errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
  })
  .passthrough();

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

async function resolveLinearApiKey(
  sink: LinearSink,
  context: EventSinkDeliveryContext,
): Promise<string | null> {
  if (sink.apiKeySecretRef) {
    return await context.secretStore.getSecret(sink.apiKeySecretRef);
  }

  if (sink.apiKeyEnv) {
    return Bun.env[sink.apiKeyEnv] ?? null;
  }

  return null;
}

export class LinearSinkHandler implements EventSinkHandler<LinearSink> {
  readonly type = "linear" as const;

  async deliver(sink: LinearSink, context: EventSinkDeliveryContext): Promise<DeliveryRecord> {
    try {
      const apiKey = await resolveLinearApiKey(sink, context);
      if (!apiKey) {
        return createFailureDelivery(
          sink.id,
          context.event,
          context.attempts,
          "Linear API key is not configured",
        );
      }

      const body = sink.titlePrefix
        ? `${sink.titlePrefix}\n\n${formatSinkTextMessage(context.event)}`
        : formatSinkTextMessage(context.event);
      const response = await fetch(sink.apiBaseUrl, {
        body: JSON.stringify({
          query:
            "mutation QuestRunnerCreateComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
          variables: {
            body,
            issueId: sink.issueId,
          },
        }),
        headers: {
          "content-type": "application/json",
          authorization: apiKey,
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

      const responseBody = linearResponseSchema.safeParse(await response.json());
      if (!responseBody.success) {
        return createFailureDelivery(
          sink.id,
          context.event,
          context.attempts,
          "Linear returned an invalid response payload",
        );
      }

      const linearError = responseBody.data.errors?.[0]?.message;
      if (linearError || responseBody.data.data?.commentCreate.success !== true) {
        return createFailureDelivery(
          sink.id,
          context.event,
          context.attempts,
          linearError ?? "Linear comment creation failed",
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
