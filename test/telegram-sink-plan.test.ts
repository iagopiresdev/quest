import { expect, test } from "bun:test";

import { parseTelegramSinkPlan } from "../src/core/setup/telegram-sink-plan";

test("telegram sink plan parses env-based auth with no RPG cards", () => {
  const plan = parseTelegramSinkPlan([
    "--chat-id",
    "123456789",
    "--bot-token-env",
    "TELEGRAM_BOT_TOKEN",
  ]);
  expect(plan).toEqual({
    botTokenEnv: "TELEGRAM_BOT_TOKEN",
    botTokenSecretRef: undefined,
    chatId: "123456789",
    importOpenClawBotToken: undefined,
    parseMode: undefined,
  });
});

test("telegram sink plan parses secret-ref auth with HTML (RPG cards)", () => {
  const plan = parseTelegramSinkPlan([
    "--chat-id",
    "123456789",
    "--bot-token-secret-ref",
    "telegram.bot-token",
    "--parse-mode",
    "HTML",
  ]);
  expect(plan.parseMode).toBe("HTML");
  expect(plan.botTokenSecretRef).toBe("telegram.bot-token");
  expect(plan.botTokenEnv).toBeUndefined();
  expect(plan.importOpenClawBotToken).toBeUndefined();
});

test("telegram sink plan parses OpenClaw import path with imported bot token", () => {
  const plan = parseTelegramSinkPlan([
    "--chat-id",
    "123456789",
    "--bot-token-secret-ref",
    "quest-telegram-bot-token",
    "--import-openclaw-bot-token",
    "999:IMPORTED-FROM-OPENCLAW",
    "--parse-mode",
    "HTML",
  ]);
  expect(plan.importOpenClawBotToken).toBe("999:IMPORTED-FROM-OPENCLAW");
  expect(plan.botTokenSecretRef).toBe("quest-telegram-bot-token");
  expect(plan.parseMode).toBe("HTML");
});

test("telegram sink plan rejects unsupported parse modes silently (falls back to undefined)", () => {
  const plan = parseTelegramSinkPlan([
    "--chat-id",
    "123456789",
    "--bot-token-env",
    "TELEGRAM_BOT_TOKEN",
    "--parse-mode",
    "HTMLX",
  ]);
  expect(plan.parseMode).toBeUndefined();
});

test("telegram sink plan throws when --chat-id is missing", () => {
  expect(() => parseTelegramSinkPlan(["--bot-token-env", "TELEGRAM_BOT_TOKEN"])).toThrowError(
    /--chat-id/,
  );
});
