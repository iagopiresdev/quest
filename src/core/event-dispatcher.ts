import { defaultEventSinkHandlers } from "./observability/sinks";
import type { EventSinkHandler } from "./observability/sinks/handler";
import {
  createObservableCalibrationEvent,
  type DeliveryRecord,
  type DeliveryStatus,
  type ObservabilitySink,
  type ObservableEvent,
  type ObservableEventType,
  shouldDeliverEvent,
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
  private readonly sinkHandlers: Map<
    ObservabilitySink["type"],
    EventSinkHandler<ObservabilitySink>
  >;

  constructor(
    private readonly observabilityStore: ObservabilityStore,
    private readonly secretStore: SecretStore,
    sinkHandlers: EventSinkHandler[] = [...defaultEventSinkHandlers],
  ) {
    // Sink delivery should be an extension seam, not a dispatcher switch statement, so new
    // integrations can register a handler without rewriting the orchestration path.
    this.sinkHandlers = new Map(
      sinkHandlers.map((handler) => [handler.type, handler as EventSinkHandler<ObservabilitySink>]),
    );
  }

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
    const handler = this.sinkHandlers.get(sink.type);
    if (!handler) {
      return {
        attempts,
        eventId: event.eventId,
        eventType: event.eventType,
        lastAttemptAt: new Date().toISOString(),
        lastError: `No sink handler is registered for ${sink.type}`,
        payload: event,
        sinkId: sink.id,
        status: "failed",
      };
    }

    return await handler.deliver(sink, {
      attempts,
      event,
      secretStore: this.secretStore,
    });
  }
}
