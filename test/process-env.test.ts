import { afterEach, expect, test } from "bun:test";

import { buildProcessEnv } from "../src/core/runs/process-env";

const originalEnv = {
  PATH: Bun.env.PATH,
  QUEST_SECRET_TEST: Bun.env.QUEST_SECRET_TEST,
  TERM: Bun.env.TERM,
};

afterEach(() => {
  if (originalEnv.PATH === undefined) {
    delete Bun.env.PATH;
  } else {
    Bun.env.PATH = originalEnv.PATH;
  }

  if (originalEnv.QUEST_SECRET_TEST === undefined) {
    delete Bun.env.QUEST_SECRET_TEST;
  } else {
    Bun.env.QUEST_SECRET_TEST = originalEnv.QUEST_SECRET_TEST;
  }

  if (originalEnv.TERM === undefined) {
    delete Bun.env.TERM;
  } else {
    Bun.env.TERM = originalEnv.TERM;
  }
});

test("buildProcessEnv filters ambient secrets while preserving allowlisted vars", () => {
  Bun.env.PATH = "/usr/bin:/bin";
  Bun.env.TERM = "xterm-256color";
  Bun.env.QUEST_SECRET_TEST = "top-secret";

  const env = buildProcessEnv();

  expect(env.PATH).toBe("/usr/bin:/bin");
  expect(env.TERM).toBe("xterm-256color");
  expect(env.QUEST_SECRET_TEST).toBeUndefined();
});

test("buildProcessEnv allows explicit overrides for subprocess contracts", () => {
  Bun.env.PATH = "/usr/bin:/bin";

  const env = buildProcessEnv({
    CUSTOM_FLAG: "enabled",
    PATH: "/custom/bin",
  });

  expect(env.CUSTOM_FLAG).toBe("enabled");
  expect(env.PATH).toBe("/custom/bin");
});

test("buildProcessEnv falls back to a homebrew-safe PATH when PATH is missing", () => {
  delete Bun.env.PATH;

  const env = buildProcessEnv();

  expect(env.PATH).toContain("/opt/homebrew/bin");
  expect(env.PATH).toContain("/usr/bin");
});
