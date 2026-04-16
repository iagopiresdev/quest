import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventDispatcher } from "../src/core/observability/event-dispatcher";
import type { DeliveryRecord, WebhookSink } from "../src/core/observability/schema";
import type { EventSinkHandler } from "../src/core/observability/sinks/handler";
import { ObservabilityStore } from "../src/core/observability/store";
import { SecretStore } from "../src/core/secret-store";

function createObservabilityHarness() {
  const root = mkdtempSync(join(tmpdir(), "quest-observability-"));
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
  const cleanup = () => rmSync(root, { force: true, recursive: true });

  return { cleanup, secretStore, store };
}

function createWebhookSink(id: string): WebhookSink {
  return {
    enabled: true,
    eventTypes: ["worker_calibration_recorded"],
    headers: {},
    id,
    type: "webhook",
    url: "https://example.com/quest-events",
  };
}

test("event dispatcher uses injected sink handlers instead of hardcoded delivery logic", async () => {
  const harness = createObservabilityHarness();
  const seen: Array<{ eventType: string; sinkId: string }> = [];
  const handler: EventSinkHandler<WebhookSink> = {
    async deliver(sink, context): Promise<DeliveryRecord> {
      seen.push({ eventType: context.event.eventType, sinkId: sink.id });
      return {
        attempts: context.attempts,
        deliveredAt: "2026-04-11T00:00:00.000Z",
        eventId: context.event.eventId,
        eventType: context.event.eventType,
        lastAttemptAt: "2026-04-11T00:00:00.000Z",
        payload: context.event,
        sinkId: sink.id,
        status: "delivered",
      };
    },
    type: "webhook",
  };

  try {
    await harness.store.upsertWebhookSink(createWebhookSink("custom-webhook"));
    const dispatcher = new EventDispatcher(harness.store, harness.secretStore, [handler]);

    const attempts = await dispatcher.dispatchCalibration({
      at: "2026-04-11T00:00:00.000Z",
      runId: "run-1",
      score: 100,
      status: "passed",
      suiteId: "training-grounds-v1",
      workerId: "ember",
      workerName: "Ember",
      xpAwarded: 200,
    });

    expect(attempts).toEqual([
      expect.objectContaining({
        eventType: "worker_calibration_recorded",
        ok: true,
        sinkId: "custom-webhook",
        status: "delivered",
      }),
    ]);
    expect(seen).toEqual([{ eventType: "worker_calibration_recorded", sinkId: "custom-webhook" }]);
  } finally {
    harness.cleanup();
  }
});

test("event dispatcher delivers daemon events through the shared sink pipeline", async () => {
  const harness = createObservabilityHarness();
  const seen: Array<{ eventType: string; payload: unknown; sinkId: string }> = [];
  const handler: EventSinkHandler<WebhookSink> = {
    async deliver(sink, context): Promise<DeliveryRecord> {
      seen.push({ eventType: context.event.eventType, payload: context.event, sinkId: sink.id });
      return {
        attempts: context.attempts,
        deliveredAt: "2026-04-16T00:00:00.000Z",
        eventId: context.event.eventId,
        eventType: context.event.eventType,
        lastAttemptAt: "2026-04-16T00:00:00.000Z",
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
      eventTypes: ["daemon_dispatched", "daemon_failed"],
      headers: {},
      id: "daemon-webhook",
      type: "webhook",
      url: "https://example.com/daemon",
    });
    const dispatcher = new EventDispatcher(harness.store, harness.secretStore, [handler]);

    const attempts = await dispatcher.dispatchDaemon({
      at: "2026-04-16T00:00:00.000Z",
      eventType: "daemon_dispatched",
      partyName: "alpha",
      specFile: "fast.json",
    });

    expect(attempts).toEqual([
      expect.objectContaining({
        eventType: "daemon_dispatched",
        ok: true,
        sinkId: "daemon-webhook",
        status: "delivered",
      }),
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.eventType).toBe("daemon_dispatched");
  } finally {
    harness.cleanup();
  }
});

test("event dispatcher records failed deliveries when a sink has no registered handler", async () => {
  const harness = createObservabilityHarness();

  try {
    await harness.store.upsertWebhookSink(createWebhookSink("orphan-webhook"));
    const dispatcher = new EventDispatcher(harness.store, harness.secretStore, []);

    const attempts = await dispatcher.dispatchCalibration({
      at: "2026-04-11T00:00:00.000Z",
      runId: "run-2",
      score: 50,
      status: "failed",
      suiteId: "training-grounds-v1",
      workerId: "ember",
      workerName: "Ember",
      xpAwarded: 0,
    });

    expect(attempts).toEqual([
      expect.objectContaining({
        eventType: "worker_calibration_recorded",
        ok: false,
        sinkId: "orphan-webhook",
        status: "failed",
      }),
    ]);

    const deliveries = await harness.store.listDeliveries({ sinkId: "orphan-webhook" });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.lastError).toContain("No sink handler is registered");
  } finally {
    harness.cleanup();
  }
});
