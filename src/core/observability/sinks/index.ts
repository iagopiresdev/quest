import { TelegramSinkHandler, telegramSinkSchema } from "./telegram-sink";
import { WebhookSinkHandler, webhookSinkSchema } from "./webhook-sink";

export const sinkSchemas = [webhookSinkSchema, telegramSinkSchema] as const;

export const defaultEventSinkHandlers = [
  new WebhookSinkHandler(),
  new TelegramSinkHandler(),
] as const;

export { telegramSinkSchema, webhookSinkSchema };
