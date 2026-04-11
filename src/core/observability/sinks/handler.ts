import type {
  DeliveryRecord,
  ObservabilitySink,
  ObservableEvent,
} from "../../observability-schema";
import type { SecretStore } from "../../secret-store";

export type EventSinkDeliveryContext = {
  attempts: number;
  event: ObservableEvent;
  secretStore: SecretStore;
};

export interface EventSinkHandler<TSink extends ObservabilitySink = ObservabilitySink> {
  readonly type: TSink["type"];
  deliver(sink: TSink, context: EventSinkDeliveryContext): Promise<DeliveryRecord>;
}
