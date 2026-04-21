// Integration-style tests for each sink handler. These don't mock `fetch` — they stand up a real
// HTTP server with `startTestServer` and assert on captured requests. That covers both the happy
// path (delivered → status 2xx → delivery record "delivered") and failure modes (non-2xx HTTP,
// transport errors) without needing to patch Bun's global fetch.
//
// Telegram has its own card-builder tests; here we only prove the sink handler delivers and picks
// the right formatter based on `parseMode`. Webhook, Slack, and Linear were previously at 0-24%
// line coverage on the dispatch path; these tests lift that to "every branch touched".

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createObservableDaemonEvent } from "../src/core/observability/observable-events";
import { LinearSinkHandler } from "../src/core/observability/sinks/linear-sink";
import { OpenClawSinkHandler } from "../src/core/observability/sinks/openclaw-sink";
import { SlackSinkHandler } from "../src/core/observability/sinks/slack-sink";
import { TelegramSinkHandler } from "../src/core/observability/sinks/telegram-sink";
import { WebhookSinkHandler } from "../src/core/observability/sinks/webhook-sink";
import { SecretStore } from "../src/core/secret-store";
import { createOpenClawMockExecutable, startTestServer } from "./helpers";

type TestServer = NonNullable<Awaited<ReturnType<typeof startTestServer>>>;

const activeServers: TestServer[] = [];
const activeRoots: string[] = [];

afterEach(async () => {
  while (activeServers.length > 0) {
    const server = activeServers.pop();
    if (server) {
      await server.stop();
    }
  }
  while (activeRoots.length > 0) {
    const root = activeRoots.pop();
    if (root) {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

function trackRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "quest-sink-dispatch-"));
  activeRoots.push(root);
  return root;
}

function createHarnessSecretStore(root: string): SecretStore {
  return new SecretStore({
    platform: "darwin",
    runCommand: async () => ({
      aborted: false,
      exitCode: 0,
      stderr: "",
      stderrTruncated: false,
      stdout: "stored-secret-value",
      stdoutTruncated: false,
      timedOut: false,
    }),
    serviceName: `quest-sink-tests-${root.slice(-8)}`,
  });
}

function sampleEvent() {
  return createObservableDaemonEvent({
    at: "2026-04-16T23:30:00.000Z",
    eventType: "daemon_party_created",
    partyName: "alpha",
    reason: "target_ref:main",
  });
}

// -- OpenClaw ---------------------------------------------------------------

test("openclaw sink records API errors embedded in JSON payloads", async () => {
  const root = trackRoot();
  const executable = createOpenClawMockExecutable(root, {
    payloadText: "HTTP 400 api_error: model is not supported",
  });
  const handler = new OpenClawSinkHandler();

  const delivery = await handler.deliver(
    {
      agentId: "codex",
      enabled: true,
      eventTypes: [],
      executable,
      id: "openclaw-errors",
      type: "openclaw",
    },
    {
      attempts: 1,
      event: sampleEvent(),
      secretStore: createHarnessSecretStore(root),
    },
  );

  expect(delivery.status).toBe("failed");
  expect(delivery.lastError).toContain("OpenClaw reported an API error");
});

// ── Webhook ────────────────────────────────────────────────────────────────

test("webhook sink delivers the observable event as JSON and records success", async () => {
  const captured: Array<{ body: string; headers: Record<string, string> }> = [];
  const server = await startTestServer({
    fetch: async (request) => {
      captured.push({
        body: await request.text(),
        headers: Object.fromEntries(request.headers.entries()),
      });
      return new Response("ok", { status: 200 });
    },
  });
  if (!server) return; // port unavailable on CI
  activeServers.push(server);

  const handler = new WebhookSinkHandler();
  const delivery = await handler.deliver(
    {
      enabled: true,
      eventTypes: [],
      headers: { "x-custom": "present" },
      id: "webhook-1",
      type: "webhook",
      url: `http://127.0.0.1:${server.port}/hook`,
    },
    {
      attempts: 1,
      event: sampleEvent(),
      secretStore: createHarnessSecretStore(trackRoot()),
    },
  );

  expect(delivery.status).toBe("delivered");
  expect(delivery.attempts).toBe(1);
  expect(captured).toHaveLength(1);
  expect(JSON.parse(captured[0]?.body ?? "{}")).toMatchObject({
    eventType: "daemon_party_created",
    partyName: "alpha",
  });
  expect(captured[0]?.headers["x-custom"]).toBe("present");
});

test("webhook sink records an HTTP failure without throwing", async () => {
  const server = await startTestServer({
    fetch: () => new Response("server error", { status: 500 }),
  });
  if (!server) return;
  activeServers.push(server);

  const handler = new WebhookSinkHandler();
  const delivery = await handler.deliver(
    {
      enabled: true,
      eventTypes: [],
      headers: {},
      id: "webhook-2",
      type: "webhook",
      url: `http://127.0.0.1:${server.port}/hook`,
    },
    {
      attempts: 1,
      event: sampleEvent(),
      secretStore: createHarnessSecretStore(trackRoot()),
    },
  );

  expect(delivery.status).toBe("failed");
  expect(delivery.lastError).toContain("500");
});

test("webhook sink captures transport errors when the URL is unreachable", async () => {
  const handler = new WebhookSinkHandler();
  const delivery = await handler.deliver(
    {
      enabled: true,
      eventTypes: [],
      headers: {},
      id: "webhook-dead",
      type: "webhook",
      url: "http://127.0.0.1:1/unreachable",
    },
    {
      attempts: 1,
      event: sampleEvent(),
      secretStore: createHarnessSecretStore(trackRoot()),
    },
  );

  expect(delivery.status).toBe("failed");
  expect(delivery.lastError).toBeString();
});

// ── Slack ──────────────────────────────────────────────────────────────────

test("slack sink delivers a JSON payload with the plain-text formatter", async () => {
  const captured: string[] = [];
  const server = await startTestServer({
    fetch: async (request) => {
      captured.push(await request.text());
      return new Response("ok", { status: 200 });
    },
  });
  if (!server) return;
  activeServers.push(server);

  const handler = new SlackSinkHandler();
  const delivery = await handler.deliver(
    {
      enabled: true,
      eventTypes: [],
      id: "slack-1",
      textPrefix: "🚨 ops",
      type: "slack",
      url: `http://127.0.0.1:${server.port}/slack`,
    },
    {
      attempts: 1,
      event: sampleEvent(),
      secretStore: createHarnessSecretStore(trackRoot()),
    },
  );

  expect(delivery.status).toBe("delivered");
  const payload = JSON.parse(captured[0] ?? "{}") as { text: string };
  expect(payload.text.startsWith("🚨 ops\n")).toBe(true);
  expect(payload.text).toContain("event: daemon_party_created");
});

test("slack sink fails when no URL is resolvable", async () => {
  const handler = new SlackSinkHandler();
  const delivery = await handler.deliver(
    {
      enabled: true,
      eventTypes: [],
      id: "slack-no-url",
      type: "slack",
      urlEnv: "QUEST_SLACK_URL_DEFINITELY_NOT_SET",
    },
    {
      attempts: 1,
      event: sampleEvent(),
      secretStore: createHarnessSecretStore(trackRoot()),
    },
  );

  expect(delivery.status).toBe("failed");
  expect(delivery.lastError).toContain("not configured");
});

// ── Linear ─────────────────────────────────────────────────────────────────

test("linear sink posts a GraphQL commentCreate mutation and records success", async () => {
  const captured: Array<{ body: string; headers: Record<string, string> }> = [];
  const server = await startTestServer({
    fetch: async (request) => {
      captured.push({
        body: await request.text(),
        headers: Object.fromEntries(request.headers.entries()),
      });
      return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    },
  });
  if (!server) return;
  activeServers.push(server);

  const originalKey = Bun.env.QUEST_LINEAR_TEST_KEY;
  Bun.env.QUEST_LINEAR_TEST_KEY = "linear-test-key";

  try {
    const handler = new LinearSinkHandler();
    const delivery = await handler.deliver(
      {
        apiBaseUrl: `http://127.0.0.1:${server.port}/graphql`,
        apiKeyEnv: "QUEST_LINEAR_TEST_KEY",
        enabled: true,
        eventTypes: [],
        id: "linear-1",
        issueId: "ISSUE-1",
        titlePrefix: "quest",
        type: "linear",
      },
      {
        attempts: 1,
        event: sampleEvent(),
        secretStore: createHarnessSecretStore(trackRoot()),
      },
    );

    expect(delivery.status).toBe("delivered");
    expect(captured[0]?.headers.authorization).toBe("linear-test-key");
    const payload = JSON.parse(captured[0]?.body ?? "{}") as {
      query: string;
      variables: { issueId: string; body: string };
    };
    expect(payload.query).toContain("commentCreate");
    expect(payload.variables.issueId).toBe("ISSUE-1");
    expect(payload.variables.body.startsWith("quest")).toBe(true);
  } finally {
    if (originalKey === undefined) {
      delete Bun.env.QUEST_LINEAR_TEST_KEY;
    } else {
      Bun.env.QUEST_LINEAR_TEST_KEY = originalKey;
    }
  }
});

test("linear sink renders RPG markdown cards when useRpgCards is enabled", async () => {
  const captured: Array<{ body: string }> = [];
  const server = await startTestServer({
    fetch: async (request) => {
      captured.push({ body: await request.text() });
      return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    },
  });
  if (!server) return;
  activeServers.push(server);

  Bun.env.QUEST_LINEAR_TEST_KEY = "linear-test-key";

  try {
    const handler = new LinearSinkHandler();
    const delivery = await handler.deliver(
      {
        apiBaseUrl: `http://127.0.0.1:${server.port}/graphql`,
        apiKeyEnv: "QUEST_LINEAR_TEST_KEY",
        enabled: true,
        eventTypes: [],
        id: "linear-cards",
        issueId: "ISSUE-4",
        type: "linear",
        useRpgCards: true,
      },
      {
        attempts: 1,
        event: sampleEvent(),
        secretStore: createHarnessSecretStore(trackRoot()),
      },
    );

    expect(delivery.status).toBe("delivered");
    const payload = JSON.parse(captured[0]?.body ?? "{}") as {
      variables: { body: string };
    };
    // RPG card fingerprints: H2 heading, italic flavor, bulleted party field.
    expect(payload.variables.body).toContain("## \ud83d\udee1\ufe0f Party Assembled");
    expect(payload.variables.body).toContain("_A new fellowship forms._");
    expect(payload.variables.body).toContain("- **Party:** alpha");
    // Plain-text formatter fingerprints must NOT appear when cards are on.
    expect(payload.variables.body).not.toContain("quest daemon");
  } finally {
    delete Bun.env.QUEST_LINEAR_TEST_KEY;
  }
});

test("linear sink records failure when the API returns GraphQL errors", async () => {
  const server = await startTestServer({
    fetch: async () =>
      new Response(JSON.stringify({ errors: [{ message: "invalid issue id" }] }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
  });
  if (!server) return;
  activeServers.push(server);

  Bun.env.QUEST_LINEAR_TEST_KEY = "linear-test-key";

  try {
    const handler = new LinearSinkHandler();
    const delivery = await handler.deliver(
      {
        apiBaseUrl: `http://127.0.0.1:${server.port}/graphql`,
        apiKeyEnv: "QUEST_LINEAR_TEST_KEY",
        enabled: true,
        eventTypes: [],
        id: "linear-errors",
        issueId: "ISSUE-2",
        type: "linear",
      },
      {
        attempts: 1,
        event: sampleEvent(),
        secretStore: createHarnessSecretStore(trackRoot()),
      },
    );

    expect(delivery.status).toBe("failed");
    expect(delivery.lastError).toContain("invalid issue id");
  } finally {
    delete Bun.env.QUEST_LINEAR_TEST_KEY;
  }
});

test("linear sink fails when no API key is resolvable", async () => {
  const handler = new LinearSinkHandler();
  const delivery = await handler.deliver(
    {
      apiBaseUrl: "http://127.0.0.1:1/graphql",
      apiKeyEnv: "QUEST_LINEAR_KEY_NOT_SET",
      enabled: true,
      eventTypes: [],
      id: "linear-no-key",
      issueId: "ISSUE-3",
      type: "linear",
    },
    {
      attempts: 1,
      event: sampleEvent(),
      secretStore: createHarnessSecretStore(trackRoot()),
    },
  );

  expect(delivery.status).toBe("failed");
  expect(delivery.lastError).toContain("not configured");
});

// ── Telegram ───────────────────────────────────────────────────────────────

test("telegram sink delivers an HTML card when parseMode is HTML", async () => {
  const captured: string[] = [];
  const server = await startTestServer({
    fetch: async (request) => {
      captured.push(await request.text());
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    },
  });
  if (!server) return;
  activeServers.push(server);

  const originalToken = Bun.env.QUEST_TG_TEST_TOKEN;
  Bun.env.QUEST_TG_TEST_TOKEN = "tg-test-token";

  try {
    const handler = new TelegramSinkHandler();
    const delivery = await handler.deliver(
      {
        apiBaseUrl: `http://127.0.0.1:${server.port}`,
        botTokenEnv: "QUEST_TG_TEST_TOKEN",
        chatId: "123456789",
        disableNotification: false,
        enabled: true,
        eventTypes: [],
        id: "telegram-1",
        parseMode: "HTML",
        type: "telegram",
      },
      {
        attempts: 1,
        event: sampleEvent(),
        secretStore: createHarnessSecretStore(trackRoot()),
      },
    );

    expect(delivery.status).toBe("delivered");
    const payload = JSON.parse(captured[0] ?? "{}") as {
      chat_id: string;
      parse_mode: string;
      text: string;
    };
    expect(payload.parse_mode).toBe("HTML");
    expect(payload.chat_id).toBe("123456789");
    expect(payload.text).toContain("<b>Party Assembled</b>");
    expect(payload.text).toContain("<i>A new fellowship forms.</i>");
  } finally {
    if (originalToken === undefined) {
      delete Bun.env.QUEST_TG_TEST_TOKEN;
    } else {
      Bun.env.QUEST_TG_TEST_TOKEN = originalToken;
    }
  }
});

test("telegram sink falls back to plain-text formatter when parseMode is unset", async () => {
  const captured: string[] = [];
  const server = await startTestServer({
    fetch: async (request) => {
      captured.push(await request.text());
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    },
  });
  if (!server) return;
  activeServers.push(server);

  Bun.env.QUEST_TG_TEST_TOKEN = "tg-test-token";

  try {
    const handler = new TelegramSinkHandler();
    const delivery = await handler.deliver(
      {
        apiBaseUrl: `http://127.0.0.1:${server.port}`,
        botTokenEnv: "QUEST_TG_TEST_TOKEN",
        chatId: "123456789",
        disableNotification: false,
        enabled: true,
        eventTypes: [],
        id: "telegram-plain",
        type: "telegram",
      },
      {
        attempts: 1,
        event: sampleEvent(),
        secretStore: createHarnessSecretStore(trackRoot()),
      },
    );

    expect(delivery.status).toBe("delivered");
    const payload = JSON.parse(captured[0] ?? "{}") as { text: string };
    expect(payload.text).toContain("event: daemon_party_created");
    expect(payload.text).not.toContain("<b>");
  } finally {
    delete Bun.env.QUEST_TG_TEST_TOKEN;
  }
});

test("telegram sink records failure when the bot token cannot be resolved", async () => {
  const handler = new TelegramSinkHandler();
  const delivery = await handler.deliver(
    {
      apiBaseUrl: "http://127.0.0.1:1",
      botTokenEnv: "QUEST_TG_MISSING_TOKEN",
      chatId: "123456789",
      disableNotification: false,
      enabled: true,
      eventTypes: [],
      id: "telegram-missing",
      type: "telegram",
    },
    {
      attempts: 1,
      event: sampleEvent(),
      secretStore: createHarnessSecretStore(trackRoot()),
    },
  );

  expect(delivery.status).toBe("failed");
  expect(delivery.lastError).toContain("not configured");
});
