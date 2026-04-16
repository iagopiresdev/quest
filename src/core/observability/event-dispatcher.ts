import type { QuestRunDocument } from "../runs/schema";
import type { SecretStore } from "../secret-store";
import {
  createObservableCalibrationEvent,
  createObservableDaemonEvent,
  type DeliveryRecord,
  type DeliveryStatus,
  type ObservabilitySink,
  type ObservableDaemonEvent,
  type ObservableDaemonEventType,
  type ObservableEvent,
  type ObservableEventType,
  shouldDeliverEvent,
} from "./schema";
import { defaultEventSinkHandlers } from "./sinks";
import type { EventSinkHandler } from "./sinks/handler";
import type { ObservabilityStore } from "./store";

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
  private readonly sinkHandlers: Map<string, EventSinkHandler<ObservabilitySink>>;

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

  async dispatchDaemon(input: {
    at: string;
    error?: string | undefined;
    eventType: ObservableDaemonEventType;
    partyName: string;
    reason?: string | undefined;
    runId?: string | undefined;
    specFile?: string | null | undefined;
  }): Promise<DeliveryAttempt[]> {
    return await this.dispatchEvents([createObservableDaemonEvent(input)]);
  }

  async dispatchDaemonEvents(events: ObservableDaemonEvent[]): Promise<DeliveryAttempt[]> {
    return await this.dispatchEvents(events);
  }

  async dispatchProbe(
    event: ObservableEvent,
    options: { sinkId?: string | undefined } = {},
  ): Promise<DeliveryAttempt[]> {
    return await this.dispatchEvents([event], options);
  }

  async retryDeliveries(filters: {
    eventType?: ObservableEventType | undefined;
    runId?: string | undefined;
    sinkId?: string | undefined;
    status?: DeliveryStatus | undefined;
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

  private async dispatchEvents(
    events: ObservableEvent[],
    filters: { sinkId?: string | undefined } = {},
  ): Promise<DeliveryAttempt[]> {
    const [config, deliveries] = await Promise.all([
      this.observabilityStore.readConfig(),
      this.observabilityStore.readDeliveries(),
    ]);
    const attempts: DeliveryAttempt[] = [];

    for (const sink of config.sinks) {
      if (filters.sinkId && sink.id !== filters.sinkId) {
        continue;
      }

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
