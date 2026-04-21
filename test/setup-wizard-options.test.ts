import { expect, test } from "bun:test";
import {
  harnessHint,
  harnessLabel,
  listModelsForHarness,
  openClawAgentForModel,
} from "../src/core/setup/wizard-options";

test("setup wizard exposes the codex model catalog in requested order", () => {
  expect(listModelsForHarness("codex")).toEqual([
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
  ]);
});

test("setup wizard derives hermes and openclaw models from detected defaults", () => {
  expect(listModelsForHarness("hermes", { models: ["qwen", "llama"], profile: "qwen" })).toEqual([
    "qwen",
    "llama",
  ]);
  expect(
    listModelsForHarness("openclaw", {
      openClawAgents: [
        { id: "codex", model: "openai-codex/gpt-5.4" },
        { id: "mini", model: "minimax/MiniMax-M2.7" },
      ],
    }),
  ).toEqual(["openai-codex/gpt-5.4", "minimax/MiniMax-M2.7"]);
});

test("setup wizard maps harness labels and disabled hints", () => {
  expect(harnessLabel("claude-code")).toBe("claude-code");
  expect(harnessHint("claude-code")).toBe("Adapter coming soon");
  expect(harnessHint("opencode")).toBe("Adapter coming soon");
});

test("setup wizard resolves openclaw agent ids by selected model", () => {
  expect(
    openClawAgentForModel(
      {
        agentId: "fallback",
        openClawAgents: [{ id: "codex", model: "openai-codex/gpt-5.4" }],
      },
      "openai-codex/gpt-5.4",
    ),
  ).toBe("codex");
});
