import { expect, test } from "bun:test";

import {
  defaultSetupArchetype,
  getSetupArchetype,
  listSetupArchetypesForRole,
} from "../src/core/setup/presets";

test("setup presets keep builder and tester archetypes role-aligned", () => {
  expect(
    listSetupArchetypesForRole("builder").every((archetype) => archetype.role === "builder"),
  ).toBe(true);
  expect(
    listSetupArchetypesForRole("tester").every((archetype) => archetype.role === "tester"),
  ).toBe(true);
  expect(
    listSetupArchetypesForRole("hybrid").every((archetype) => archetype.role === "hybrid"),
  ).toBe(true);
});

test("setup presets expose stable defaults per role", () => {
  expect(defaultSetupArchetype("builder").id).toBe("battle-engineer");
  expect(defaultSetupArchetype("tester").id).toBe("trial-judge");
  expect(defaultSetupArchetype("hybrid").id).toBe("adventurer");
  expect(getSetupArchetype("boss-hunter").update.role).toBe("tester");
});
