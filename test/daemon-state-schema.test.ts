import { expect, test } from "bun:test";

import { questDaemonStateSchema } from "../src/core/daemon/schema";

test("daemon state schema tolerates legacy `process: null` and loads the rest of the state", () => {
  const parsed = questDaemonStateSchema.parse({
    activeRunIds: {},
    completedSpecTimestamps: {},
    cooldownUntil: {},
    lastErrorByParty: {},
    parties: [],
    partyRestReasons: {},
    process: null,
    version: 1,
  });
  expect(parsed.process).toBeUndefined();
});

test("daemon state schema still accepts a valid process record", () => {
  const parsed = questDaemonStateSchema.parse({
    activeRunIds: {},
    completedSpecTimestamps: {},
    cooldownUntil: {},
    lastErrorByParty: {},
    parties: [],
    partyRestReasons: {},
    process: {
      pid: 1234,
      startedAt: "2026-04-16T23:45:00.000Z",
      stopRequested: false,
    },
    version: 1,
  });
  expect(parsed.process?.pid).toBe(1234);
});

test("daemon state schema still accepts an absent process field", () => {
  const parsed = questDaemonStateSchema.parse({
    activeRunIds: {},
    completedSpecTimestamps: {},
    cooldownUntil: {},
    lastErrorByParty: {},
    parties: [],
    partyRestReasons: {},
    version: 1,
  });
  expect(parsed.process).toBeUndefined();
});
