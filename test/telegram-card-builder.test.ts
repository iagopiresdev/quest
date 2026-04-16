import { expect, test } from "bun:test";

import { createObservableDaemonEvent } from "../src/core/observability/observable-events";
import {
  escapeHtml,
  formatTelegramCard,
} from "../src/core/observability/sinks/telegram-card-builder";

test("escapeHtml escapes the three Telegram-dangerous characters", () => {
  expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  expect(escapeHtml("plain")).toBe("plain");
});

test("daemon card renders emoji title, separator, party, and clock", () => {
  const card = formatTelegramCard(
    createObservableDaemonEvent({
      at: "2026-04-16T20:30:00.000Z",
      eventType: "daemon_party_created",
      partyName: "alpha",
      reason: "target_ref:main",
    }),
  );
  expect(card).toContain("🎉 <b>Party Created</b>");
  expect(card).toContain("━━━━━━━━━━━━━━━━");
  expect(card).toContain("🎭 alpha");
  expect(card).toContain("💬 target_ref:main");
  expect(card).not.toContain("📋"); // no specFile for party-admin events
});

test("daemon card renders (all parties) label for global bonfire/resume", () => {
  const card = formatTelegramCard(
    createObservableDaemonEvent({
      at: "2026-04-16T20:30:00.000Z",
      eventType: "daemon_party_resting",
      partyName: "*",
      reason: "maintenance",
    }),
  );
  expect(card).toContain("🔥 <b>Party Resting</b>");
  expect(card).toContain("🎭 (all parties)");
});

test("daemon card surfaces specFile, runId, and error when present", () => {
  const card = formatTelegramCard(
    createObservableDaemonEvent({
      at: "2026-04-16T20:30:00.000Z",
      error: "worker crashed: exit 137",
      eventType: "daemon_failed",
      partyName: "alpha",
      runId: "quest-abc-123",
      specFile: "hello.json",
    }),
  );
  expect(card).toContain("❌ <b>Quest Failed</b>");
  expect(card).toContain("📋 <code>hello.json</code>");
  expect(card).toContain("🧵 <code>quest-abc-123</code>");
  expect(card).toContain("<blockquote>worker crashed: exit 137</blockquote>");
});

test("daemon card escapes HTML in user-supplied fields", () => {
  const card = formatTelegramCard(
    createObservableDaemonEvent({
      at: "2026-04-16T20:30:00.000Z",
      eventType: "daemon_failed",
      partyName: "<img src=x>",
      reason: "rate_limit & <script>",
      specFile: "<spec>.json",
    }),
  );
  expect(card).toContain("🎭 &lt;img src=x&gt;");
  expect(card).toContain("💬 rate_limit &amp; &lt;script&gt;");
  expect(card).toContain("📋 <code>&lt;spec&gt;.json</code>");
  expect(card).not.toContain("<script>");
});

test("daemon card covers every daemon event type with a distinct header", () => {
  const eventTypes = [
    "daemon_dispatched",
    "daemon_landed",
    "daemon_failed",
    "daemon_budget_exhausted",
    "daemon_recovered",
    "daemon_party_created",
    "daemon_party_resting",
    "daemon_party_resumed",
  ] as const;
  const headers = new Set<string>();
  for (const eventType of eventTypes) {
    const card = formatTelegramCard(
      createObservableDaemonEvent({
        at: "2026-04-16T20:30:00.000Z",
        eventType,
        partyName: "alpha",
      }),
    );
    const header = card.split("\n", 1)[0] ?? "";
    expect(header.startsWith("<b>") || /^\p{Emoji}/u.test(header)).toBe(true);
    expect(header).toContain("<b>");
    headers.add(header);
  }
  expect(headers.size).toBe(eventTypes.length);
});
