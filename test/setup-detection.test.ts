import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectSinkSetup } from "../src/core/setup/detection";

type EnvSnapshot = Record<string, string | undefined>;

function snapshotEnv(keys: readonly string[]): EnvSnapshot {
  const snapshot: EnvSnapshot = {};
  for (const key of keys) {
    snapshot[key] = Bun.env[key];
  }
  return snapshot;
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete Bun.env[key];
    } else {
      Bun.env[key] = value;
    }
  }
}

const ENV_KEYS = ["TELEGRAM_BOT_TOKEN", "SLACK_WEBHOOK_URL", "LINEAR_API_KEY", "HOME"] as const;

test("setup detection imports sink defaults from environment without OpenClaw config", async () => {
  const snapshot = snapshotEnv(ENV_KEYS);
  const fakeHome = mkdtempSync(join(tmpdir(), "quest-setup-detection-"));

  Bun.env.TELEGRAM_BOT_TOKEN = "telegram-test-token";
  Bun.env.SLACK_WEBHOOK_URL = "https://hooks.slack.example/test";
  Bun.env.LINEAR_API_KEY = "linear-test-key";
  Bun.env.HOME = fakeHome;

  try {
    expect(await detectSinkSetup()).toEqual({
      linearApiKeyEnv: "LINEAR_API_KEY",
      openClawTelegramBotToken: null,
      openClawTelegramChatId: null,
      slackWebhookEnv: "SLACK_WEBHOOK_URL",
      telegramBotTokenEnv: "TELEGRAM_BOT_TOKEN",
    });
  } finally {
    restoreEnv(snapshot);
    rmSync(fakeHome, { force: true, recursive: true });
  }
});

test("setup detection surfaces OpenClaw Telegram bot token + chat id when configured", async () => {
  const snapshot = snapshotEnv(ENV_KEYS);
  const fakeHome = mkdtempSync(join(tmpdir(), "quest-setup-detection-"));
  mkdirSync(join(fakeHome, ".openclaw"), { recursive: true });
  writeFileSync(
    join(fakeHome, ".openclaw", "openclaw.json"),
    JSON.stringify({
      channels: {
        telegram: {
          allowFrom: [1234567890, 42],
          botToken: "999:ABCDEF-imported",
        },
      },
    }),
    "utf8",
  );

  delete Bun.env.TELEGRAM_BOT_TOKEN;
  delete Bun.env.SLACK_WEBHOOK_URL;
  delete Bun.env.LINEAR_API_KEY;
  Bun.env.HOME = fakeHome;

  try {
    expect(await detectSinkSetup()).toEqual({
      linearApiKeyEnv: null,
      openClawTelegramBotToken: "999:ABCDEF-imported",
      openClawTelegramChatId: "1234567890",
      slackWebhookEnv: null,
      telegramBotTokenEnv: null,
    });
  } finally {
    restoreEnv(snapshot);
    rmSync(fakeHome, { force: true, recursive: true });
  }
});

test("setup detection tolerates malformed OpenClaw config without throwing", async () => {
  const snapshot = snapshotEnv(ENV_KEYS);
  const fakeHome = mkdtempSync(join(tmpdir(), "quest-setup-detection-"));
  mkdirSync(join(fakeHome, ".openclaw"), { recursive: true });
  writeFileSync(join(fakeHome, ".openclaw", "openclaw.json"), "{ not valid json", "utf8");

  Bun.env.HOME = fakeHome;

  try {
    const detected = await detectSinkSetup();
    expect(detected.openClawTelegramBotToken).toBeNull();
    expect(detected.openClawTelegramChatId).toBeNull();
  } finally {
    restoreEnv(snapshot);
    rmSync(fakeHome, { force: true, recursive: true });
  }
});
