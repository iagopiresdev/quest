import { expect, test } from "bun:test";

import { matchesQuestPathPattern, patternsConflict } from "../src/core/runs/path-patterns";

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

test("quest path patterns allow doublestar to match zero or more directories", () => {
  expect(matchesQuestPathPattern("src/app.ts", ["src/**/*.ts"])).toBe(true);
  expect(matchesQuestPathPattern("src/nested/app.ts", ["src/**/*.ts"])).toBe(true);
});

test("quest path pattern conflicts follow runtime ownership glob semantics", () => {
  expect(patternsConflict("src/*.ts", "src/app.ts")).toBe(true);
  expect(patternsConflict("src/**/*.ts", "src/app.ts")).toBe(true);
  expect(patternsConflict("src/*.ts", "src/nested/app.ts")).toBe(false);
  expect(patternsConflict("src/*.ts", "src/*.js")).toBe(false);
});
