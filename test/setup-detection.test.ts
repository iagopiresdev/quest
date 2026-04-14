import { expect, test } from "bun:test";

import { detectSinkSetup } from "../src/core/setup/detection";

test("setup detection imports sink defaults from environment", () => {
  const originalTelegram = Bun.env.TELEGRAM_BOT_TOKEN;
  const originalSlack = Bun.env.SLACK_WEBHOOK_URL;
  const originalLinear = Bun.env.LINEAR_API_KEY;

  Bun.env.TELEGRAM_BOT_TOKEN = "telegram-test-token";
  Bun.env.SLACK_WEBHOOK_URL = "https://hooks.slack.example/test";
  Bun.env.LINEAR_API_KEY = "linear-test-key";

  try {
    expect(detectSinkSetup()).toEqual({
      linearApiKeyEnv: "LINEAR_API_KEY",
      slackWebhookEnv: "SLACK_WEBHOOK_URL",
      telegramBotTokenEnv: "TELEGRAM_BOT_TOKEN",
    });
  } finally {
    if (originalTelegram === undefined) {
      delete Bun.env.TELEGRAM_BOT_TOKEN;
    } else {
      Bun.env.TELEGRAM_BOT_TOKEN = originalTelegram;
    }

    if (originalSlack === undefined) {
      delete Bun.env.SLACK_WEBHOOK_URL;
    } else {
      Bun.env.SLACK_WEBHOOK_URL = originalSlack;
    }

    if (originalLinear === undefined) {
      delete Bun.env.LINEAR_API_KEY;
    } else {
      Bun.env.LINEAR_API_KEY = originalLinear;
    }
  }
});
