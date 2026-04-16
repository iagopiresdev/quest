import { expect, test } from "bun:test";

import { parseExecutableCommand } from "../src/core/runs/adapters/acp";

test("ACP executable parsing preserves quoted paths and arguments", () => {
  expect(
    parseExecutableCommand(
      'node "/tmp/agent fixtures/fake acp agent.mjs" --label "arg with spaces"',
    ),
  ).toEqual(["node", "/tmp/agent fixtures/fake acp agent.mjs", "--label", "arg with spaces"]);
});

test("ACP executable parsing rejects unmatched quotes", () => {
  expect(() => parseExecutableCommand('node "/tmp/fake-agent.mjs')).toThrow(
    "ACP executable command has invalid quoting",
  );
});
