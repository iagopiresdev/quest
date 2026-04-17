import { expect, test } from "bun:test";
import type {
  ObservableCalibrationEvent,
  ObservableDaemonEvent,
  ObservableRunEvent,
} from "../src/core/observability/observable-events";
import { formatLinearCard } from "../src/core/observability/sinks/linear-card-builder";

function buildDaemonEvent(overrides: Partial<ObservableDaemonEvent> = {}): ObservableDaemonEvent {
  return {
    error: null,
    eventId: "daemon:daemon_dispatched:alpha:hello.json:2026-04-16T23:00:00.000Z",
    eventType: "daemon_dispatched",
    kind: "daemon",
    occurredAt: "2026-04-16T23:00:00.000Z",
    partyName: "alpha",
    reason: null,
    runId: null,
    specFile: "hello.json",
    ...overrides,
  } as ObservableDaemonEvent;
}

function buildRunEvent(overrides: Partial<ObservableRunEvent> = {}): ObservableRunEvent {
  return {
    details: {},
    eventId: "run:run_completed:quest-abc:2026-04-16T23:00:00.000Z",
    eventType: "run_completed",
    kind: "run",
    occurredAt: "2026-04-16T23:00:00.000Z",
    runId: "quest-abc-123",
    runStatus: "completed",
    sourceRepositoryPath: "/tmp/source-repo",
    title: "Daemon Canary Quest",
    workspace: "canary-workspace",
    ...overrides,
  } as ObservableRunEvent;
}

function buildCalibrationEvent(
  overrides: Partial<ObservableCalibrationEvent> = {},
): ObservableCalibrationEvent {
  return {
    eventId: "worker_calibration:passed:ember:suite-01:2026-04-16T23:00:00.000Z",
    eventType: "worker_calibration_recorded",
    kind: "worker_calibration",
    occurredAt: "2026-04-16T23:00:00.000Z",
    runId: "quest-abc-123",
    score: 92,
    status: "passed",
    suiteId: "suite-01",
    workerId: "ember",
    workerName: "Ember",
    xpAwarded: 120,
    ...overrides,
  } as ObservableCalibrationEvent;
}

test("formatLinearCard: daemon dispatch renders heading, flavor, and bulleted facts", () => {
  const card = formatLinearCard(buildDaemonEvent());
  expect(card).toContain("## ⚔️ Quest Accepted");
  expect(card).toContain("_The party sets forth._");
  expect(card).toContain("---");
  expect(card).toContain("- **Party:** alpha");
  expect(card).toContain("- **Spec:** `hello.json`");
  // no runId in this fixture
  expect(card).not.toContain("- **Run:**");
});

test("formatLinearCard: daemon landed includes run id bullet", () => {
  const card = formatLinearCard(
    buildDaemonEvent({
      eventType: "daemon_landed",
      runId: "quest-abc-123",
    }),
  );
  expect(card).toContain("## 🏆 Quest Cleared");
  expect(card).toContain("- **Run:** `quest-abc-123`");
});

test("formatLinearCard: daemon failure renders error in fenced code block", () => {
  const card = formatLinearCard(
    buildDaemonEvent({
      error: "Worker command failed for alpha with exit code 1",
      eventType: "daemon_failed",
      runId: "quest-xyz",
    }),
  );
  expect(card).toContain("## 💀 Party Wiped");
  expect(card).toContain("**Error:**");
  expect(card).toContain("```");
  expect(card).toContain("Worker command failed for alpha with exit code 1");
});

test("formatLinearCard: daemon global bonfire uses all-parties label", () => {
  const card = formatLinearCard(
    buildDaemonEvent({
      eventType: "daemon_party_resting",
      partyName: "*",
      reason: "end-of-day freeze",
      specFile: null,
    }),
  );
  expect(card).toContain("## 🔥 Resting at Bonfire");
  expect(card).toContain("- **Party:** all parties");
  expect(card).toContain("- **Reason:** end-of-day freeze");
  expect(card).not.toContain("- **Spec:**");
});

test("formatLinearCard: run card exposes title, run id, status, workspace", () => {
  const card = formatLinearCard(buildRunEvent());
  expect(card).toContain("## 🏆 Quest Cleared");
  expect(card).toContain("- **Title:** Daemon Canary Quest");
  expect(card).toContain("- **Run:** `quest-abc-123`");
  expect(card).toContain("- **Status:** completed");
  expect(card).toContain("- **Workspace:** canary-workspace");
});

test("formatLinearCard: calibration passed renders masterful-training header", () => {
  const card = formatLinearCard(buildCalibrationEvent());
  expect(card).toContain("## 🌟 Training Mastered");
  expect(card).toContain("- **Worker:** Ember (`ember`)");
  expect(card).toContain("- **Score:** 92");
  expect(card).toContain("- **XP Awarded:** +120");
});

test("formatLinearCard: calibration failed renders training-failed header", () => {
  const card = formatLinearCard(
    buildCalibrationEvent({
      score: 42,
      status: "failed",
      xpAwarded: 0,
    }),
  );
  expect(card).toContain("## 🛡️ Training Failed");
  expect(card).toContain("- **Score:** 42");
  expect(card).toContain("- **XP Awarded:** +0");
});

test("formatLinearCard: inline code strips stray backticks from spec/run values", () => {
  // Synthetic defensive case: if an upstream spec file name somehow contained a backtick,
  // the card builder must strip it rather than break Linear's markdown rendering.
  const card = formatLinearCard(
    buildDaemonEvent({
      specFile: "weird`name.json",
    }),
  );
  expect(card).toContain("- **Spec:** `weirdname.json`");
  expect(card).not.toContain("weird`name.json");
});

test("formatLinearCard: error text is truncated at 2000 characters", () => {
  const longError = "x".repeat(3000);
  const card = formatLinearCard(
    buildDaemonEvent({
      error: longError,
      eventType: "daemon_failed",
    }),
  );
  // The truncated error should appear inside a fenced block; the full 3000-char version
  // should not.
  expect(card).toContain("x".repeat(2000));
  expect(card).not.toContain("x".repeat(2001));
});
