import { expect, test } from "bun:test";

import { matchesQuestPathPattern } from "../src/core/runs/path-patterns";

test("quest path patterns support doublestar ownership globs", () => {
  expect(matchesQuestPathPattern("docs/features/chronicle-run.md", ["docs/features/**"])).toBe(
    true,
  );
  expect(matchesQuestPathPattern("src/security/url.ts", ["src/**"])).toBe(true);
  expect(matchesQuestPathPattern("src/security/url.ts", ["docs/**"])).toBe(false);
});

test("quest path patterns treat regex metacharacters literally", () => {
  expect(matchesQuestPathPattern("package.json", ["package.json"])).toBe(true);
  expect(matchesQuestPathPattern("src/app.ts", ["src/*.ts"])).toBe(true);
  expect(matchesQuestPathPattern("src/nested/app.ts", ["src/*.ts"])).toBe(false);
});
