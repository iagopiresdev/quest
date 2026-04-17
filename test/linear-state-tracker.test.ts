import { expect, test } from "bun:test";

import { createObservableDaemonEvent } from "../src/core/observability/observable-events";
import { LinearSinkHandler, linearSinkSchema } from "../src/core/observability/sinks/linear-sink";
import { questSpecSchema } from "../src/core/planning/spec-schema";
import { SecretStore } from "../src/core/secret-store";
import { startTestServer } from "./helpers";

type TestServer = NonNullable<Awaited<ReturnType<typeof startTestServer>>>;

function fakeSecretStore(): SecretStore {
  return new SecretStore({
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
    serviceName: "quest-runner-test-linear-tracker",
  });
}

// ── Spec schema ───────────────────────────────────────────────────────────

test("questSpecSchema: tracker.linear.issueId is optional and parses when present", () => {
  const base = {
    slices: [
      {
        discipline: "coding",
        goal: "write the file",
        id: "hello",
        owns: ["hello.txt"],
        title: "Hello",
      },
    ],
    title: "Tracker Spec",
    version: 1 as const,
    workspace: "tracker-workspace",
  };

  const withoutTracker = questSpecSchema.parse(base);
  expect(withoutTracker.tracker).toBeUndefined();

  const withTracker = questSpecSchema.parse({
    ...base,
    tracker: { linear: { issueId: "TEAM-1" } },
  });
  expect(withTracker.tracker?.linear?.issueId).toBe("TEAM-1");
});

test("questSpecSchema: tracker block rejects unknown tracker types (strict)", () => {
  const result = questSpecSchema.safeParse({
    slices: [
      {
        discipline: "coding",
        goal: "write the file",
        id: "hello",
        owns: ["hello.txt"],
        title: "Hello",
      },
    ],
    title: "Tracker Spec",
    tracker: { jira: { issueId: "J-1" } },
    version: 1,
    workspace: "tracker-workspace",
  });
  expect(result.success).toBe(false);
});

// ── Observable event plumbing ─────────────────────────────────────────────

test("createObservableDaemonEvent threads trackerIssueId onto the event payload", () => {
  const event = createObservableDaemonEvent({
    at: "2026-04-17T00:00:00.000Z",
    eventType: "daemon_dispatched",
    partyName: "alpha",
    specFile: "ship.json",
    trackerIssueId: "TEAM-42",
  });
  expect(event.trackerIssueId).toBe("TEAM-42");
});

test("createObservableDaemonEvent defaults trackerIssueId to null when omitted", () => {
  const event = createObservableDaemonEvent({
    at: "2026-04-17T00:00:00.000Z",
    eventType: "daemon_dispatched",
    partyName: "alpha",
    specFile: "ship.json",
  });
  expect(event.trackerIssueId).toBeNull();
});

test("createObservableDaemonEvent coerces empty-string trackerIssueId to null", () => {
  const event = createObservableDaemonEvent({
    at: "2026-04-17T00:00:00.000Z",
    eventType: "daemon_dispatched",
    partyName: "alpha",
    specFile: "ship.json",
    trackerIssueId: "",
  });
  expect(event.trackerIssueId).toBeNull();
});

// ── Linear sink: state transitions via tracker issue id ───────────────────

type MockRequest = { query: string; variables: Record<string, unknown> };

async function runDispatchScenario(options: {
  eventType: "daemon_dispatched" | "daemon_landed" | "daemon_failed" | "daemon_party_resting";
  trackerIssueId: string | null;
  stateMap?: { dispatched?: string | null; landed?: string | null; failed?: string | null };
  stateLookupReturnsEmpty?: boolean;
}): Promise<{ captured: MockRequest[]; status: string; lastError?: string | undefined }> {
  const captured: MockRequest[] = [];
  const server = await startTestServer({
    fetch: async (request) => {
      const body = (await request.json()) as MockRequest;
      captured.push(body);
      if (body.query.includes("commentCreate")) {
        return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (body.query.includes("QuestRunnerResolveStateId")) {
        const nodes = options.stateLookupReturnsEmpty
          ? []
          : [{ id: `state-id-for-${String(body.variables.stateName)}` }];
        return new Response(
          JSON.stringify({
            data: { issue: { team: { states: { nodes } } } },
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        );
      }
      if (body.query.includes("QuestRunnerUpdateIssueState")) {
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      return new Response("unknown", { status: 400 });
    },
  });
  if (!server) {
    return { captured, status: "skipped" };
  }
  const typedServer: TestServer = server;

  Bun.env.QUEST_RUNNER_LINEAR_TRACKER_KEY = "linear-test-key";
  try {
    const sink = linearSinkSchema.parse({
      apiBaseUrl: `http://127.0.0.1:${typedServer.port}/graphql`,
      apiKeyEnv: "QUEST_RUNNER_LINEAR_TRACKER_KEY",
      enabled: true,
      eventTypes: [],
      id: "linear-tracker",
      issueId: "fallback-issue",
      stateMap: options.stateMap,
      type: "linear",
    });

    const event = createObservableDaemonEvent({
      at: "2026-04-17T00:00:00.000Z",
      eventType: options.eventType,
      partyName: "alpha",
      specFile: options.eventType === "daemon_party_resting" ? null : "ship.json",
      trackerIssueId: options.trackerIssueId,
    });

    const handler = new LinearSinkHandler();
    const delivery = await handler.deliver(sink, {
      attempts: 1,
      event,
      secretStore: fakeSecretStore(),
    });
    return { captured, lastError: delivery.lastError, status: delivery.status };
  } finally {
    await typedServer.stop();
    delete Bun.env.QUEST_RUNNER_LINEAR_TRACKER_KEY;
  }
}

test("linear sink: dispatched event with trackerIssueId moves issue to default 'In Progress'", async () => {
  const result = await runDispatchScenario({
    eventType: "daemon_dispatched",
    trackerIssueId: "TEAM-77",
  });
  if (result.status === "skipped") return;
  expect(result.status).toBe("delivered");

  // Should have made 3 GraphQL calls: comment, state lookup, issue update.
  expect(result.captured).toHaveLength(3);
  const [comment, lookup, update] = result.captured;

  expect(comment?.query).toContain("commentCreate");
  expect(lookup?.query).toContain("QuestRunnerResolveStateId");
  expect(lookup?.variables.stateName).toBe("In Progress");
  expect(lookup?.variables.issueId).toBe("TEAM-77");
  expect(update?.query).toContain("QuestRunnerUpdateIssueState");
  expect(update?.variables.stateId).toBe("state-id-for-In Progress");
  expect(update?.variables.issueId).toBe("TEAM-77");
});

test("linear sink: landed event maps to default 'Done'", async () => {
  const result = await runDispatchScenario({
    eventType: "daemon_landed",
    trackerIssueId: "TEAM-77",
  });
  if (result.status === "skipped") return;
  expect(result.status).toBe("delivered");
  const lookup = result.captured.find((entry) => entry.query.includes("QuestRunnerResolveStateId"));
  expect(lookup?.variables.stateName).toBe("Done");
});

test("linear sink: failed event maps to default 'Todo'", async () => {
  const result = await runDispatchScenario({
    eventType: "daemon_failed",
    trackerIssueId: "TEAM-77",
  });
  if (result.status === "skipped") return;
  expect(result.status).toBe("delivered");
  const lookup = result.captured.find((entry) => entry.query.includes("QuestRunnerResolveStateId"));
  expect(lookup?.variables.stateName).toBe("Todo");
});

test("linear sink: stateMap override wins over default", async () => {
  const result = await runDispatchScenario({
    eventType: "daemon_landed",
    stateMap: { landed: "Ready for Review" },
    trackerIssueId: "TEAM-77",
  });
  if (result.status === "skipped") return;
  expect(result.status).toBe("delivered");
  const lookup = result.captured.find((entry) => entry.query.includes("QuestRunnerResolveStateId"));
  expect(lookup?.variables.stateName).toBe("Ready for Review");
});

test("linear sink: stateMap with null entry opts out of state transition for that event", async () => {
  const result = await runDispatchScenario({
    eventType: "daemon_failed",
    stateMap: { failed: null },
    trackerIssueId: "TEAM-77",
  });
  if (result.status === "skipped") return;
  expect(result.status).toBe("delivered");
  // Only the comment call should fire; no lookup / update.
  expect(result.captured).toHaveLength(1);
  expect(result.captured[0]?.query).toContain("commentCreate");
});

test("linear sink: events without a trackerIssueId skip state transitions entirely", async () => {
  const result = await runDispatchScenario({
    eventType: "daemon_dispatched",
    trackerIssueId: null,
  });
  if (result.status === "skipped") return;
  expect(result.status).toBe("delivered");
  expect(result.captured).toHaveLength(1);
  expect(result.captured[0]?.query).toContain("commentCreate");
});

test("linear sink: party-admin events do not trigger state transitions even with trackerIssueId", async () => {
  // Party-admin events are not lifecycle transitions for a specific issue — they apply to the
  // whole party. Even if a tracker id somehow leaked through, the sink must not move an issue.
  const result = await runDispatchScenario({
    eventType: "daemon_party_resting",
    trackerIssueId: "TEAM-77",
  });
  if (result.status === "skipped") return;
  expect(result.status).toBe("delivered");
  expect(result.captured).toHaveLength(1);
  expect(result.captured[0]?.query).toContain("commentCreate");
});

test("linear sink: state lookup returning no nodes fails the delivery with state_not_found", async () => {
  const result = await runDispatchScenario({
    eventType: "daemon_dispatched",
    stateLookupReturnsEmpty: true,
    trackerIssueId: "TEAM-77",
  });
  if (result.status === "skipped") return;
  expect(result.status).toBe("failed");
  expect(result.lastError).toContain("state_not_found:In Progress");
});
