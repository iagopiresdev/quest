import {
  createObservableCalibrationEvent,
  type DeliveryRecord,
  type DeliveryStatus,
  type ObservabilitySink,
  type ObservableEvent,
  type ObservableEventType,
  shouldDeliverEvent,
  type TelegramSink,
  type WebhookSink,
} from "./observability-schema";
import type { ObservabilityStore } from "./observability-store";
import type { QuestRunDocument } from "./run-schema";
import type { SecretStore } from "./secret-store";

// Persisted delivery records should only describe actual delivery states. Dispatcher results also
// need to represent "we intentionally did not try", so that runtime-only outcome stays separate.
type DeliveryAttemptStatus = DeliveryStatus | "skipped";

type DeliveryAttempt = {
  eventId: string;
  eventType: string;
  ok: boolean;
  sinkId: string;
  status: DeliveryAttemptStatus;
  reason?: string;
};

export class EventDispatcher {
  constructor(
    private readonly observabilityStore: ObservabilityStore,
    private readonly secretStore: SecretStore,
  ) {}

  async dispatchRun(run: QuestRunDocument): Promise<DeliveryAttempt[]> {
    const events = await this.observabilityStore.listObservableRunEvents(run);
    return await this.dispatchEvents(events);
  }

  async dispatchCalibration(input: {
    at: string;
    runId: string;
    score: number;
    status: "passed" | "failed";
    suiteId: string;
    workerId: string;
    workerName: string;
    xpAwarded: number;
  }): Promise<DeliveryAttempt[]> {
    return await this.dispatchEvents([createObservableCalibrationEvent(input)]);
  }

  async retryDeliveries(filters: {
    eventType?: ObservableEventType;
    runId?: string;
    sinkId?: string;
    status?: DeliveryStatus;
  }): Promise<DeliveryAttempt[]> {
    const [config, deliveries] = await Promise.all([
      this.observabilityStore.readConfig(),
      this.observabilityStore.listDeliveries(filters),
    ]);
    const attempts: DeliveryAttempt[] = [];

    for (const record of deliveries) {
      const sink = config.sinks.find((candidate) => candidate.id === record.sinkId) ?? null;
      if (!sink) {
        attempts.push({
          eventId: record.eventId,
          eventType: record.eventType,
          ok: false,
          reason: "sink_not_found",
          sinkId: record.sinkId,
          status: "skipped",
        });
        continue;
      }

      if (!sink.enabled) {
        attempts.push({
          eventId: record.eventId,
          eventType: record.eventType,
          ok: false,
          reason: "sink_disabled",
          sinkId: record.sinkId,
          status: "skipped",
        });
        continue;
      }

      const delivery = await this.deliverSinkEvent(sink, record.payload, record.attempts + 1);
      await this.observabilityStore.upsertDeliveryRecord(delivery);
      attempts.push({
        eventId: record.eventId,
        eventType: record.eventType,
        ok: delivery.status === "delivered",
        sinkId: record.sinkId,
        status: delivery.status,
      });
    }

    return attempts;
  }

  private async dispatchEvents(events: ObservableEvent[]): Promise<DeliveryAttempt[]> {
    const [config, deliveries] = await Promise.all([
      this.observabilityStore.readConfig(),
      this.observabilityStore.readDeliveries(),
    ]);
    const attempts: DeliveryAttempt[] = [];

    for (const sink of config.sinks) {
      for (const event of events) {
        if (!shouldDeliverEvent(sink, event.eventType)) {
          continue;
        }

        const existingRecord = deliveries.records.find(
          (record) => record.eventId === event.eventId && record.sinkId === sink.id,
        );
        if (existingRecord) {
          attempts.push({
            eventId: event.eventId,
            eventType: event.eventType,
            ok: existingRecord.status === "delivered",
            reason: "already_recorded",
            sinkId: sink.id,
            status: existingRecord.status,
          });
          continue;
        }

        const delivery = await this.deliverSinkEvent(sink, event, 1);
        await this.observabilityStore.upsertDeliveryRecord(delivery);
        attempts.push({
          eventId: event.eventId,
          eventType: event.eventType,
          ok: delivery.status === "delivered",
          sinkId: sink.id,
          status: delivery.status,
        });
      }
    }

    return attempts;
  }

  private async deliverSinkEvent(
    sink: ObservabilitySink,
    event: ObservableEvent,
    attempts: number,
  ): Promise<DeliveryRecord> {
    switch (sink.type) {
      case "telegram":
        return await this.deliverTelegramSink(sink, event, attempts);
      case "webhook":
        return await this.deliverWebhookSink(sink, event, attempts);
    }
  }

  private async deliverTelegramSink(
    sink: TelegramSink,
    event: ObservableEvent,
    attempts: number,
  ): Promise<DeliveryRecord> {
    const lastAttemptAt = new Date().toISOString();
    const payload = event;

    try {
      const botToken = sink.botTokenSecretRef
        ? await this.secretStore.getSecret(sink.botTokenSecretRef)
        : sink.botTokenEnv
          ? Bun.env[sink.botTokenEnv]
          : undefined;
      if (!botToken) {
        return {
          attempts,
          eventId: event.eventId,
          eventType: event.eventType,
          lastAttemptAt,
          lastError: "Telegram bot token is not configured",
          payload,
          sinkId: sink.id,
          status: "failed",
        };
      }

      const baseUrl = sink.apiBaseUrl ?? "https://api.telegram.org";
      const response = await fetch(`${baseUrl}/bot${botToken}/sendMessage`, {
        body: JSON.stringify({
          chat_id: sink.chatId,
          disable_notification: sink.disableNotification,
          message_thread_id: sink.messageThreadId,
          parse_mode: sink.parseMode,
          text: formatTelegramMessage(event),
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      });

      if (!response.ok) {
        return {
          attempts,
          eventId: event.eventId,
          eventType: event.eventType,
          lastAttemptAt,
          lastError: `HTTP ${response.status}`,
          payload,
          sinkId: sink.id,
          status: "failed",
        };
      }

      return {
        attempts,
        deliveredAt: lastAttemptAt,
        eventId: event.eventId,
        eventType: event.eventType,
        lastAttemptAt,
        payload,
        sinkId: sink.id,
        status: "delivered",
      };
    } catch (error: unknown) {
      return {
        attempts,
        eventId: event.eventId,
        eventType: event.eventType,
        lastAttemptAt,
        lastError: error instanceof Error ? error.message : String(error),
        payload,
        sinkId: sink.id,
        status: "failed",
      };
    }
  }

  private async deliverWebhookSink(
    sink: WebhookSink,
    event: ObservableEvent,
    attempts: number,
  ): Promise<DeliveryRecord> {
    const lastAttemptAt = new Date().toISOString();
    // Delivery retries should be able to replay the original event even if run state changes later.
    const payload = event;

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...sink.headers,
      };

      if (sink.secretRef && sink.secretHeader) {
        headers[sink.secretHeader] = await this.secretStore.getSecret(sink.secretRef);
      }

      const response = await fetch(sink.url, {
        body: JSON.stringify(event),
        headers,
        method: "POST",
      });

      if (!response.ok) {
        return {
          attempts,
          eventId: event.eventId,
          eventType: event.eventType,
          lastAttemptAt,
          lastError: `HTTP ${response.status}`,
          payload,
          sinkId: sink.id,
          status: "failed",
        };
      }

      return {
        attempts,
        deliveredAt: lastAttemptAt,
        eventId: event.eventId,
        eventType: event.eventType,
        lastAttemptAt,
        payload,
        sinkId: sink.id,
        status: "delivered",
      };
    } catch (error: unknown) {
      return {
        attempts,
        eventId: event.eventId,
        eventType: event.eventType,
        lastAttemptAt,
        lastError: error instanceof Error ? error.message : String(error),
        payload,
        sinkId: sink.id,
        status: "failed",
      };
    }
  }
}

function formatTelegramMessage(event: ObservableEvent): string {
  if (event.kind === "worker_calibration") {
    return [
      `quest-runner calibration`,
      `worker: ${event.workerName} (${event.workerId})`,
      `suite: ${event.suiteId}`,
      `status: ${event.status}`,
      `score: ${event.score}`,
      `xp: ${event.xpAwarded}`,
      `run: ${event.runId}`,
    ].join("\n");
  }

  return [
    `quest-runner event`,
    `event: ${event.eventType}`,
    `run: ${event.runId}`,
    `title: ${event.title}`,
    `status: ${event.runStatus}`,
    `workspace: ${event.workspace}`,
  ].join("\n");
}
