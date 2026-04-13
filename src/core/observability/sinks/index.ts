import { LinearSinkHandler, linearSinkSchema } from "./linear-sink";
import { SlackSinkHandler, slackSinkSchema } from "./slack-sink";
import { TelegramSinkHandler, telegramSinkSchema } from "./telegram-sink";
import { WebhookSinkHandler, webhookSinkSchema } from "./webhook-sink";

export const sinkSchemas = [
  webhookSinkSchema,
  telegramSinkSchema,
  slackSinkSchema,
  linearSinkSchema,
] as const;

export const defaultEventSinkHandlers = [
  new WebhookSinkHandler(),
  new TelegramSinkHandler(),
  new SlackSinkHandler(),
  new LinearSinkHandler(),
] as const;

export { linearSinkSchema, slackSinkSchema, telegramSinkSchema, webhookSinkSchema };
