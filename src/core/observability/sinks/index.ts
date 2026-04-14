import { LinearSinkHandler, linearSinkSchema } from "./linear-sink";
import { OpenClawSinkHandler, openClawSinkSchema } from "./openclaw-sink";
import { SlackSinkHandler, slackSinkSchema } from "./slack-sink";
import { TelegramSinkHandler, telegramSinkSchema } from "./telegram-sink";
import { WebhookSinkHandler, webhookSinkSchema } from "./webhook-sink";

export const sinkSchemas = [
  webhookSinkSchema,
  telegramSinkSchema,
  slackSinkSchema,
  linearSinkSchema,
  openClawSinkSchema,
] as const;

export const defaultEventSinkHandlers = [
  new WebhookSinkHandler(),
  new TelegramSinkHandler(),
  new SlackSinkHandler(),
  new LinearSinkHandler(),
  new OpenClawSinkHandler(),
] as const;

export {
  linearSinkSchema,
  openClawSinkSchema,
  slackSinkSchema,
  telegramSinkSchema,
  webhookSinkSchema,
};
