import { expect, test } from "bun:test";

import {
  assertOpenClawResponseSucceeded,
  findOpenClawApiErrorText,
  parseOpenClawJsonOutput,
} from "../src/core/runs/adapters/openclaw-shared";

test("OpenClaw shared parser extracts JSON from noisy output", () => {
  expect(parseOpenClawJsonOutput('plugins booted\n{"ok":true}\n')).toEqual({ ok: true });
});

test("OpenClaw shared error detection catches API errors in payload text", () => {
  const response = {
    result: {
      payloads: [
        {
          text: "HTTP 400 api_error: Provider returned error: not support model glm-test",
        },
      ],
    },
  };

  expect(findOpenClawApiErrorText(response)).toContain("api_error");
  expect(() =>
    assertOpenClawResponseSucceeded(response, {
      command: ["openclaw", "agent"],
      workerId: "worker-openclaw",
    }),
  ).toThrow("OpenClaw reported an API error");
});

test("OpenClaw shared error detection ignores non-object payload entries", () => {
  const errorText = findOpenClawApiErrorText({
    result: {
      payloads: [null, "noise", { text: "HTTP 400 api_error: not support model test/model" }],
    },
  });

  expect(errorText).toBe("HTTP 400 api_error: not support model test/model");
});
