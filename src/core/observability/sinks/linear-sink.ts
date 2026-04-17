import { z } from "zod";

import type { DeliveryRecord } from "../delivery-schema";
import { observableEventTypeSchema } from "../event-types";
import type { ObservableEvent } from "../observable-events";
import type { EventSinkDeliveryContext, EventSinkHandler } from "./handler";
import { formatLinearCard } from "./linear-card-builder";
import { formatSinkTextMessage } from "./message-format";
import { nonEmptyString, secretRefSchema, urlSchema } from "./schema-helpers";

// Per-event-type state name overrides. Each key corresponds to a lifecycle event that moves the
// Linear card; the value is the workflow state name (e.g. "In Progress"). Null entries skip
// transitions for that event. Unspecified keys fall back to DEFAULT_STATE_MAP below.
//
// Daemon-level keys: dispatched, landed, failed. These fire from the daemon tick.
// Run-level keys: testing, in_review, blocked. These fire during run execution / integration.
//   - `testing`     → `run_integration_checks_started`
//   - `in_review`   → `run_integration_checks_completed` (tests passed, awaiting land)
//   - `blocked`     → `run_integration_checks_failed` OR `run_blocked`
export const linearStateMapSchema = z
  .object({
    blocked: nonEmptyString(80).nullable().optional(),
    dispatched: nonEmptyString(80).nullable().optional(),
    failed: nonEmptyString(80).nullable().optional(),
    in_review: nonEmptyString(80).nullable().optional(),
    landed: nonEmptyString(80).nullable().optional(),
    testing: nonEmptyString(80).nullable().optional(),
  })
  .strict();
export type LinearStateMap = z.infer<typeof linearStateMapSchema>;

export const linearSinkSchema = z
  .object({
    apiBaseUrl: urlSchema.default("https://api.linear.app/graphql"),
    apiKeyEnv: nonEmptyString(120).optional(),
    apiKeySecretRef: secretRefSchema.optional(),
    enabled: z.boolean().default(true),
    eventTypes: z.array(observableEventTypeSchema).max(64).default([]),
    id: nonEmptyString(80),
    issueId: nonEmptyString(120),
    // Per-event-type state transitions. See linearStateMapSchema above.
    stateMap: linearStateMapSchema.optional(),
    titlePrefix: nonEmptyString(120).optional(),
    type: z.literal("linear"),
    // When true, render Linear comments as RPG-flavor markdown cards (headings,
    // bulleted facts, fenced error blocks). When omitted or false, fall back to
    // the shared plain-text formatter so existing sinks keep their current voice.
    useRpgCards: z.boolean().optional(),
  })
  .strict()
  .check(
    z.superRefine((value, ctx) => {
      if (!value.apiKeyEnv && !value.apiKeySecretRef) {
        ctx.addIssue({
          code: "custom",
          message: "linear sink requires apiKeyEnv or apiKeySecretRef",
          path: ["apiKeyEnv"],
        });
      }
    }),
  );
export type LinearSink = z.infer<typeof linearSinkSchema>;

type LifecycleStateKey = "blocked" | "dispatched" | "failed" | "in_review" | "landed" | "testing";

// Default state mapping when the sink doesn't override it. Matches Symphony's convention and
// Linear's shipped workflow states for most teams: dispatch flips a card to in-progress, tests
// move it to Testing, test pass goes to In Review, a successful land moves it to Done, a
// failure sends it to Blocked (for human triage) or Todo (for recoverable daemon failures).
const DEFAULT_STATE_MAP: Record<LifecycleStateKey, string> = {
  blocked: "Blocked",
  dispatched: "In Progress",
  failed: "Todo",
  in_review: "In Review",
  landed: "Done",
  testing: "Testing",
};

// Map each observable event type to the lifecycle state key it triggers. Events not listed here
// never move the Linear card (party-admin, budget, and any run events without a lifecycle
// transition meaning).
const EVENT_TYPE_TO_STATE_KEY: Record<string, LifecycleStateKey> = {
  daemon_dispatched: "dispatched",
  daemon_failed: "failed",
  daemon_landed: "landed",
  run_blocked: "blocked",
  run_integration_checks_completed: "in_review",
  run_integration_checks_failed: "blocked",
  run_integration_checks_started: "testing",
};

function lifecycleStateKeyForEvent(eventType: string): LifecycleStateKey | null {
  return EVENT_TYPE_TO_STATE_KEY[eventType] ?? null;
}

function mappedStateName(sink: LinearSink, key: LifecycleStateKey): string | null {
  const map = sink.stateMap;
  if (!map) {
    return DEFAULT_STATE_MAP[key];
  }
  // Differentiate between "key absent" (use default) and "key present but null" (opt out).
  if (!(key in map)) {
    return DEFAULT_STATE_MAP[key];
  }
  const override = map[key];
  if (override === null) {
    return null;
  }
  if (typeof override === "string") {
    return override;
  }
  return DEFAULT_STATE_MAP[key];
}

const linearCommentResponseSchema = z
  .object({
    data: z
      .object({
        commentCreate: z
          .object({
            success: z.boolean(),
          })
          .passthrough(),
      })
      .passthrough()
      .optional(),
    errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
  })
  .passthrough();

const linearStateLookupResponseSchema = z
  .object({
    data: z
      .object({
        issue: z
          .object({
            team: z
              .object({
                states: z
                  .object({
                    nodes: z.array(z.object({ id: z.string() }).passthrough()),
                  })
                  .passthrough(),
              })
              .passthrough(),
          })
          .passthrough()
          .nullable(),
      })
      .passthrough()
      .optional(),
    errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
  })
  .passthrough();

const linearIssueUpdateResponseSchema = z
  .object({
    data: z
      .object({
        issueUpdate: z
          .object({
            success: z.boolean(),
          })
          .passthrough(),
      })
      .passthrough()
      .optional(),
    errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
  })
  .passthrough();

function createFailureDelivery(
  sinkId: string,
  event: ObservableEvent,
  attempts: number,
  lastError: string,
): DeliveryRecord {
  return {
    attempts,
    eventId: event.eventId,
    eventType: event.eventType,
    lastAttemptAt: new Date().toISOString(),
    lastError,
    payload: event,
    sinkId,
    status: "failed",
  };
}

async function resolveLinearApiKey(
  sink: LinearSink,
  context: EventSinkDeliveryContext,
): Promise<string | null> {
  if (sink.apiKeySecretRef) {
    return await context.secretStore.getSecret(sink.apiKeySecretRef);
  }

  if (sink.apiKeyEnv) {
    return Bun.env[sink.apiKeyEnv] ?? null;
  }

  return null;
}

async function graphqlRequest(
  sink: LinearSink,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ body: unknown; status: number } | { error: string }> {
  const response = await fetch(sink.apiBaseUrl, {
    body: JSON.stringify({ query, variables }),
    headers: { "content-type": "application/json", authorization: apiKey },
    method: "POST",
  });
  if (!response.ok) {
    return { error: `HTTP ${response.status}` };
  }
  return { body: await response.json(), status: response.status };
}

async function postComment(
  sink: LinearSink,
  apiKey: string,
  body: string,
): Promise<{ error?: string }> {
  const result = await graphqlRequest(
    sink,
    apiKey,
    "mutation QuestRunnerCreateComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
    { body, issueId: sink.issueId },
  );
  if ("error" in result) {
    return { error: result.error };
  }
  const parsed = linearCommentResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { error: "Linear returned an invalid response payload" };
  }
  const linearError = parsed.data.errors?.[0]?.message;
  if (linearError || parsed.data.data?.commentCreate.success !== true) {
    return { error: linearError ?? "Linear comment creation failed" };
  }
  return {};
}

async function resolveStateId(
  sink: LinearSink,
  apiKey: string,
  issueId: string,
  stateName: string,
): Promise<{ stateId?: string; error?: string }> {
  const result = await graphqlRequest(
    sink,
    apiKey,
    "query QuestRunnerResolveStateId($issueId: String!, $stateName: String!) { issue(id: $issueId) { team { states(filter: { name: { eq: $stateName } }, first: 1) { nodes { id } } } } }",
    { issueId, stateName },
  );
  if ("error" in result) {
    return { error: result.error };
  }
  const parsed = linearStateLookupResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { error: "Linear returned an invalid state lookup payload" };
  }
  const linearError = parsed.data.errors?.[0]?.message;
  if (linearError) {
    return { error: linearError };
  }
  const stateId = parsed.data.data?.issue?.team?.states?.nodes?.[0]?.id;
  if (!stateId) {
    return { error: `state_not_found:${stateName}` };
  }
  return { stateId };
}

async function updateIssueState(
  sink: LinearSink,
  apiKey: string,
  issueId: string,
  stateId: string,
): Promise<{ error?: string }> {
  const result = await graphqlRequest(
    sink,
    apiKey,
    "mutation QuestRunnerUpdateIssueState($issueId: String!, $stateId: String!) { issueUpdate(id: $issueId, input: { stateId: $stateId }) { success } }",
    { issueId, stateId },
  );
  if ("error" in result) {
    return { error: result.error };
  }
  const parsed = linearIssueUpdateResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { error: "Linear returned an invalid issue update payload" };
  }
  const linearError = parsed.data.errors?.[0]?.message;
  if (linearError || parsed.data.data?.issueUpdate.success !== true) {
    return { error: linearError ?? "Linear issue state update failed" };
  }
  return {};
}

// Both daemon and run events can carry a trackerIssueId. Extract it uniformly so the state
// transition logic doesn't branch on kind.
function trackerIssueIdFromEvent(event: ObservableEvent): string | null {
  if (event.kind === "daemon" || event.kind === "run") {
    return event.trackerIssueId ?? null;
  }
  return null;
}

// When the event carries a `trackerIssueId` and maps to a lifecycle state, move that specific
// issue to the mapped Linear state. Returns null on success, or a short error on failure.
// The caller decides whether to fail the whole delivery or merely log the tracker miss (we pick
// the former — if the operator opted into state tracking, a silent failure would be worse than a
// retryable delivery record).
async function applyStateTransition(
  sink: LinearSink,
  apiKey: string,
  event: ObservableEvent,
): Promise<string | null> {
  const trackerIssueId = trackerIssueIdFromEvent(event);
  if (!trackerIssueId) {
    return null;
  }
  const stateKey = lifecycleStateKeyForEvent(event.eventType);
  if (!stateKey) {
    return null;
  }
  const stateName = mappedStateName(sink, stateKey);
  if (!stateName) {
    return null;
  }
  const lookup = await resolveStateId(sink, apiKey, trackerIssueId, stateName);
  if (lookup.error || !lookup.stateId) {
    return lookup.error ?? "state lookup returned no id";
  }
  const update = await updateIssueState(sink, apiKey, trackerIssueId, lookup.stateId);
  if (update.error) {
    return update.error;
  }
  return null;
}

function renderBody(sink: LinearSink, event: ObservableEvent): string {
  const formatted =
    sink.useRpgCards === true ? formatLinearCard(event) : formatSinkTextMessage(event);
  return sink.titlePrefix ? `${sink.titlePrefix}\n\n${formatted}` : formatted;
}

export class LinearSinkHandler implements EventSinkHandler<LinearSink> {
  readonly type = "linear" as const;

  async deliver(sink: LinearSink, context: EventSinkDeliveryContext): Promise<DeliveryRecord> {
    try {
      const apiKey = await resolveLinearApiKey(sink, context);
      if (!apiKey) {
        return createFailureDelivery(
          sink.id,
          context.event,
          context.attempts,
          "Linear API key is not configured",
        );
      }

      // Comment first so operator visibility lands even if the state transition subsequently
      // fails (Linear workflow state changes are the "optional" layer on top of the observability
      // comment stream).
      const commentResult = await postComment(sink, apiKey, renderBody(sink, context.event));
      if (commentResult.error) {
        return createFailureDelivery(sink.id, context.event, context.attempts, commentResult.error);
      }

      const transitionError = await applyStateTransition(sink, apiKey, context.event);
      if (transitionError) {
        return createFailureDelivery(
          sink.id,
          context.event,
          context.attempts,
          `tracker state transition: ${transitionError}`,
        );
      }

      const deliveredAt = new Date().toISOString();
      return {
        attempts: context.attempts,
        deliveredAt,
        eventId: context.event.eventId,
        eventType: context.event.eventType,
        lastAttemptAt: deliveredAt,
        payload: context.event,
        sinkId: sink.id,
        status: "delivered",
      };
    } catch (error: unknown) {
      return createFailureDelivery(
        sink.id,
        context.event,
        context.attempts,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
