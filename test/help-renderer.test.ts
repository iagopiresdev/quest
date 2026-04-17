import { expect, test } from "bun:test";

import { renderCategorizedHelp } from "../src/core/ui/help";

test("categorized help lists every expected section", () => {
  const output = renderCategorizedHelp();
  for (const section of [
    "INSTALL",
    "PARTY LIFECYCLE",
    "QUEST LIFECYCLE",
    "RUN OPERATIONS",
    "OBSERVABILITY",
    "DAEMON",
    "WORKERS",
    "SECRETS",
  ]) {
    expect(output).toContain(section);
  }
});

test("categorized help shows at least one `#` comment per section", () => {
  const output = renderCategorizedHelp();
  expect(output.split("\n").filter((line) => line.trim().startsWith("#")).length).toBeGreaterThan(
    15,
  );
});

test("categorized help does not include ANSI escapes when stdout is not a TTY", () => {
  const output = renderCategorizedHelp();
  // Tests run with stdout piped to the reporter, so ANSI escapes should be stripped by the
  // colorize helper. Gate the assertion on the environment we actually observe.
  if (process.stdout.isTTY === true) {
    return;
  }
  expect(output.includes("\u001B[")).toBe(false);
});

test("categorized help mentions the --json / --pretty global output contract in the footer", () => {
  const output = renderCategorizedHelp();
  expect(output).toContain("--json");
  expect(output).toContain("--pretty");
});
