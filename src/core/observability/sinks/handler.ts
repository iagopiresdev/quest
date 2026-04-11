import type { SecretStore } from "../../secret-store";
import type { DeliveryRecord } from "../delivery-schema";
import type { ObservableEvent } from "../observable-events";

export type EventSinkDeliveryContext = {
  attempts: number;
  event: ObservableEvent;
  secretStore: SecretStore;
};

export interface EventSinkHandler<TSink extends { type: string } = { type: string }> {
  readonly type: TSink["type"];
  deliver(sink: TSink, context: EventSinkDeliveryContext): Promise<DeliveryRecord>;
}
