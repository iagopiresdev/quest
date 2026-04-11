import { QuestDomainError } from "./errors";
import {
  createObservableRunEvent,
  type DeliveryRecord,
  type DeliveryStatus,
  deliveryRecordSchema,
  type ObservabilityConfigDocument,
  type ObservabilityDeliveriesDocument,
  type ObservabilitySink,
  type ObservableCalibrationEvent,
  type ObservableEvent,
  type ObservableEventType,
  observabilityConfigSchema,
  observabilityDeliveriesSchema,
  observabilitySinkSchema,
  observableCalibrationEventSchema,
  type WebhookSink,
  webhookSinkSchema,
} from "./observability-schema";
import type { QuestRunDocument } from "./run-schema";
import {
  readJsonFileOrDefault,
  resolveQuestObservabilityConfigPath,
  resolveQuestObservabilityDeliveriesPath,
  writeJsonFileAtomically,
} from "./storage";

const EMPTY_CONFIG: ObservabilityConfigDocument = {
  sinks: [],
  version: 1,
};

const EMPTY_DELIVERIES: ObservabilityDeliveriesDocument = {
  records: [],
  version: 1,
};

export class ObservabilityStore {
  constructor(
    private readonly configPath: string = resolveQuestObservabilityConfigPath(),
    private readonly deliveriesPath: string = resolveQuestObservabilityDeliveriesPath(),
  ) {}

  async readConfig(): Promise<ObservabilityConfigDocument> {
    const raw = await readJsonFileOrDefault<ObservabilityConfigDocument>(
      this.configPath,
      EMPTY_CONFIG,
      {
        invalidJsonCode: "invalid_observability_config",
        invalidJsonMessage: `Invalid observability config: ${this.configPath}`,
      },
    );
    const parsed = observabilityConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new QuestDomainError({
        code: "invalid_observability_config",
        details: parsed.error.flatten(),
        message: `Observability config at ${this.configPath} is invalid`,
        statusCode: 1,
      });
    }

    return parsed.data;
  }

  async listSinks(): Promise<ObservabilitySink[]> {
    const config = await this.readConfig();
    return config.sinks;
  }

  async upsertSink(candidate: ObservabilitySink): Promise<ObservabilitySink> {
    const parsed = observabilitySinkSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new QuestDomainError({
        code: "invalid_observability_config",
        details: parsed.error.flatten(),
        message: "Observability sink definition is invalid",
        statusCode: 1,
      });
    }

    const config = await this.readConfig();
    const nextSinks = [...config.sinks];
    const existingIndex = nextSinks.findIndex((sink) => sink.id === parsed.data.id);
    if (existingIndex >= 0) {
      nextSinks[existingIndex] = parsed.data;
    } else {
      nextSinks.push(parsed.data);
    }

    const nextConfig: ObservabilityConfigDocument = {
      sinks: nextSinks.sort((left, right) => left.id.localeCompare(right.id)),
      version: 1,
    };
    await writeJsonFileAtomically(this.configPath, nextConfig);
    return parsed.data;
  }

  async upsertWebhookSink(candidate: WebhookSink): Promise<WebhookSink> {
    const parsed = webhookSinkSchema.parse(candidate);
    return (await this.upsertSink(parsed)) as WebhookSink;
  }

  async deleteSink(sinkId: string): Promise<void> {
    const config = await this.readConfig();
    const nextSinks = config.sinks.filter((sink) => sink.id !== sinkId);
    if (nextSinks.length === config.sinks.length) {
      throw new QuestDomainError({
        code: "quest_observability_sink_not_found",
        details: { sinkId },
        message: `Observability sink ${sinkId} was not found`,
        statusCode: 1,
      });
    }

    await writeJsonFileAtomically(this.configPath, {
      sinks: nextSinks,
      version: 1,
    } satisfies ObservabilityConfigDocument);
  }

  async readDeliveries(): Promise<ObservabilityDeliveriesDocument> {
    const raw = await readJsonFileOrDefault<ObservabilityDeliveriesDocument>(
      this.deliveriesPath,
      EMPTY_DELIVERIES,
      {
        invalidJsonCode: "invalid_observability_config",
        invalidJsonMessage: `Invalid observability deliveries log: ${this.deliveriesPath}`,
      },
    );
    const parsed = observabilityDeliveriesSchema.safeParse(raw);
    if (!parsed.success) {
      throw new QuestDomainError({
        code: "invalid_observability_config",
        details: parsed.error.flatten(),
        message: `Observability deliveries log at ${this.deliveriesPath} is invalid`,
        statusCode: 1,
      });
    }

    return parsed.data;
  }

  async upsertDeliveryRecord(candidate: DeliveryRecord): Promise<void> {
    const parsed = deliveryRecordSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new QuestDomainError({
        code: "invalid_observability_config",
        details: parsed.error.flatten(),
        message: "Delivery record is invalid",
        statusCode: 1,
      });
    }

    const deliveries = await this.readDeliveries();
    const nextRecords = [...deliveries.records];
    const existingIndex = nextRecords.findIndex(
      (record) => record.eventId === parsed.data.eventId && record.sinkId === parsed.data.sinkId,
    );
    if (existingIndex >= 0) {
      nextRecords[existingIndex] = parsed.data;
    } else {
      nextRecords.push(parsed.data);
    }

    await writeJsonFileAtomically(this.deliveriesPath, {
      records: nextRecords,
      version: 1,
    } satisfies ObservabilityDeliveriesDocument);
  }

  async listDeliveries(
    filters: {
      eventType?: ObservableEventType;
      runId?: string;
      sinkId?: string;
      status?: DeliveryStatus;
    } = {},
  ): Promise<DeliveryRecord[]> {
    const deliveries = await this.readDeliveries();
    return deliveries.records
      .filter((record) => {
        if (filters.sinkId && record.sinkId !== filters.sinkId) {
          return false;
        }

        if (filters.status && record.status !== filters.status) {
          return false;
        }

        if (filters.eventType && record.eventType !== filters.eventType) {
          return false;
        }

        if (filters.runId && record.payload.runId !== filters.runId) {
          return false;
        }

        return true;
      })
      .sort((left, right) => right.lastAttemptAt.localeCompare(left.lastAttemptAt));
  }

  async listObservableRunEvents(run: QuestRunDocument): Promise<ObservableEvent[]> {
    return run.events.map((event, index) => createObservableRunEvent(run, event, index));
  }

  parseCalibrationEvent(candidate: unknown): ObservableCalibrationEvent {
    const parsed = observableCalibrationEventSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new QuestDomainError({
        code: "invalid_observability_config",
        details: parsed.error.flatten(),
        message: "Calibration event is invalid",
        statusCode: 1,
      });
    }

    return parsed.data;
  }
}
