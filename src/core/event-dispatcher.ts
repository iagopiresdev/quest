import {
  createObservableCalibrationEvent,
  type DeliveryRecord,
  type ObservableEvent,
  shouldDeliverEvent,
  type WebhookSink,
} from "./observability-schema";
import type { ObservabilityStore } from "./observability-store";
import type { QuestRunDocument } from "./run-schema";
import type { SecretStore } from "./secret-store";

type DeliveryAttempt = {
  eventId: string;
  eventType: string;
  ok: boolean;
  sinkId: string;
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
        if (existingRecord?.status === "delivered") {
          attempts.push({
            eventId: event.eventId,
            eventType: event.eventType,
            ok: true,
            sinkId: sink.id,
          });
          continue;
        }

        const nextAttemptCount = (existingRecord?.attempts ?? 0) + 1;
        const delivery = await this.deliverWebhookSink(sink, event, nextAttemptCount);
        await this.observabilityStore.upsertDeliveryRecord(delivery);
        attempts.push({
          eventId: event.eventId,
          eventType: event.eventType,
          ok: delivery.status === "delivered",
          sinkId: sink.id,
        });
      }
    }

    return attempts;
  }

  private async deliverWebhookSink(
    sink: WebhookSink,
    event: ObservableEvent,
    attempts: number,
  ): Promise<DeliveryRecord> {
    const lastAttemptAt = new Date().toISOString();

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
        sinkId: sink.id,
        status: "failed",
      };
    }
  }
}
