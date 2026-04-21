import { z } from "zod";
import {
  assertOpenClawResponseSucceeded,
  parseOpenClawJsonOutput,
} from "../../runs/adapters/openclaw-shared";
import { runSubprocess } from "../../runs/process";
import { buildProcessEnv } from "../../runs/process-env";
import type { DeliveryRecord } from "../delivery-schema";
import { observableEventTypeSchema } from "../event-types";
import type { ObservableEvent } from "../observable-events";
import type { EventSinkDeliveryContext, EventSinkHandler } from "./handler";
import { formatSinkTextMessage } from "./message-format";
import { nonEmptyString, urlSchema } from "./schema-helpers";

export const openClawSinkSchema = z
  .object({
    agentId: nonEmptyString(80),
    enabled: z.boolean().default(true),
    eventTypes: z.array(observableEventTypeSchema).max(64).default([]),
    executable: nonEmptyString(240).optional(),
    gatewayUrl: urlSchema.optional(),
    id: nonEmptyString(80),
    promptPrefix: nonEmptyString(160).optional(),
    sessionId: nonEmptyString(160).optional(),
    type: z.literal("openclaw"),
  })
  .strict();
export type OpenClawSink = z.infer<typeof openClawSinkSchema>;

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

function defaultSessionIdFor(event: ObservableEvent): string {
  // Session id keeps event delivery grouped on the OpenClaw side, so daemon events without
  // a run id fall back to the party name to stay readable instead of collapsing to "unknown".
  if (event.kind === "daemon") {
    const key = event.runId ?? event.partyName;
    return `quest-observability-${key.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
  }
  return `quest-observability-${event.runId.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
}

export class OpenClawSinkHandler implements EventSinkHandler<OpenClawSink> {
  readonly type = "openclaw" as const;

  async deliver(sink: OpenClawSink, context: EventSinkDeliveryContext): Promise<DeliveryRecord> {
    try {
      const executable = sink.executable ?? "openclaw";
      const sessionId = sink.sessionId ?? defaultSessionIdFor(context.event);
      const message = sink.promptPrefix
        ? `${sink.promptPrefix}\n\n${formatSinkTextMessage(context.event)}`
        : formatSinkTextMessage(context.event);
      const command = [
        executable,
        "agent",
        "--agent",
        sink.agentId,
        "--session-id",
        sessionId,
        "--message",
        message,
        "--json",
      ];
      const result = await runSubprocess({
        cmd: command,
        cwd: Bun.env.PWD ?? ".",
        env: buildProcessEnv(
          sink.gatewayUrl ? { OPENCLAW_GATEWAY_URL: sink.gatewayUrl } : undefined,
        ),
        timeoutMs: 60_000,
      });

      if (result.exitCode !== 0) {
        return createFailureDelivery(
          sink.id,
          context.event,
          context.attempts,
          result.stderr.trim() || result.stdout.trim() || `OpenClaw exited ${result.exitCode}`,
        );
      }

      const responseBody = parseOpenClawJsonOutput(result.stdout, result.stderr);
      assertOpenClawResponseSucceeded(responseBody, {
        command,
        workerId: sink.agentId,
      });

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
