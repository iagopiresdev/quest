import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventDispatcher } from "../src/core/observability/event-dispatcher";
import {
  createObservableDaemonEvent,
  observableDaemonEventSchema,
} from "../src/core/observability/observable-events";
import type { DeliveryRecord, WebhookSink } from "../src/core/observability/schema";
import type { EventSinkHandler } from "../src/core/observability/sinks/handler";
import { formatSinkTextMessage } from "../src/core/observability/sinks/message-format";
import { ObservabilityStore } from "../src/core/observability/store";
import { SecretStore } from "../src/core/secret-store";

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), "quest-daemon-party-admin-"));
  const store = new ObservabilityStore(join(root, "config.json"), join(root, "deliveries.json"));
  const secretStore = new SecretStore({
    platform: "darwin",
    runCommand: async () => ({
      aborted: false,
      exitCode: 0,
      stderr: "",
      stderrTruncated: false,
      stdout: "",
      stdoutTruncated: false,
      timedOut: false,
    }),
    serviceName: `quest-runner-tests-${crypto.randomUUID()}`,
  });
  return { cleanup: () => rmSync(root, { force: true, recursive: true }), secretStore, store };
}

test("party-admin daemon events omit specFile and still validate", () => {
  const created = createObservableDaemonEvent({
    at: "2026-04-16T20:30:00.000Z",
    eventType: "daemon_party_created",
    partyName: "alpha",
    reason: "target_ref:main",
  });
  const resting = createObservableDaemonEvent({
    at: "2026-04-16T20:31:00.000Z",
    eventType: "daemon_party_resting",
    partyName: "alpha",
    reason: "maintenance",
  });
  const resumed = createObservableDaemonEvent({
    at: "2026-04-16T20:32:00.000Z",
    eventType: "daemon_party_resumed",
    partyName: "alpha",
  });

  for (const event of [created, resting, resumed]) {
    expect(event.specFile).toBeNull();
    expect(event.runId).toBeNull();
    // Round-trip against the schema so any future drift fails loudly.
    expect(observableDaemonEventSchema.parse(event)).toEqual(event);
  }

  expect(created.reason).toBe("target_ref:main");
  expect(resting.reason).toBe("maintenance");
  expect(resumed.reason).toBeNull();
});

test("party-admin event IDs are unique even without a spec file", () => {
  const a = createObservableDaemonEvent({
    at: "2026-04-16T20:30:00.000Z",
    eventType: "daemon_party_created",
    partyName: "alpha",
  });
  const b = createObservableDaemonEvent({
    at: "2026-04-16T20:30:00.001Z",
    eventType: "daemon_party_created",
    partyName: "alpha",
  });
  const c = createObservableDaemonEvent({
    at: "2026-04-16T20:30:00.000Z",
    eventType: "daemon_party_created",
    partyName: "bravo",
  });
  expect(new Set([a.eventId, b.eventId, c.eventId]).size).toBe(3);
});

test("daemon text formatter hides the spec line when no spec file is present", () => {
  const event = createObservableDaemonEvent({
    at: "2026-04-16T20:30:00.000Z",
    eventType: "daemon_party_resting",
    partyName: "alpha",
    reason: "maintenance",
  });
  const message = formatSinkTextMessage(event);
  expect(message).toContain("event: daemon_party_resting");
  expect(message).toContain("party: alpha");
  expect(message).toContain("reason: maintenance");
  expect(message).not.toContain("spec:");
});

test("daemon text formatter still renders spec when present", () => {
  const event = createObservableDaemonEvent({
    at: "2026-04-16T20:30:00.000Z",
    eventType: "daemon_dispatched",
    partyName: "alpha",
    specFile: "fast.json",
  });
  const message = formatSinkTextMessage(event);
  expect(message).toContain("spec: fast.json");
});

test("event dispatcher delivers each party-admin event through the shared sink pipeline", async () => {
  const harness = createHarness();
  const seen: string[] = [];
  const handler: EventSinkHandler<WebhookSink> = {
    async deliver(sink, context): Promise<DeliveryRecord> {
      seen.push(context.event.eventType);
      return {
        attempts: context.attempts,
        deliveredAt: "2026-04-16T20:30:00.000Z",
        eventId: context.event.eventId,
        eventType: context.event.eventType,
        lastAttemptAt: "2026-04-16T20:30:00.000Z",
        payload: context.event,
        sinkId: sink.id,
        status: "delivered",
      };
    },
    type: "webhook",
  };

  try {
    await harness.store.upsertWebhookSink({
      enabled: true,
      eventTypes: ["daemon_party_created", "daemon_party_resting", "daemon_party_resumed"],
      headers: {},
      id: "admin-webhook",
      type: "webhook",
      url: "https://example.com/admin",
    });
    const dispatcher = new EventDispatcher(harness.store, harness.secretStore, [handler]);

    const createdAt = "2026-04-16T20:30:00.000Z";
    const restedAt = "2026-04-16T20:31:00.000Z";
    const resumedAt = "2026-04-16T20:32:00.000Z";

    await dispatcher.dispatchDaemon({
      at: createdAt,
      eventType: "daemon_party_created",
      partyName: "alpha",
      reason: "target_ref:main",
    });
    await dispatcher.dispatchDaemon({
      at: restedAt,
      eventType: "daemon_party_resting",
      partyName: "alpha",
      reason: "maintenance",
    });
    await dispatcher.dispatchDaemon({
      at: resumedAt,
      eventType: "daemon_party_resumed",
      partyName: "alpha",
    });

    expect(seen).toEqual(["daemon_party_created", "daemon_party_resting", "daemon_party_resumed"]);
  } finally {
    harness.cleanup();
  }
});
