import { QuestDomainError } from "../../errors";

function parseSingleOpenClawOutput(output: string): unknown | null {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {}

  const lines = trimmed.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines.slice(index).join("\n").trim();
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
      continue;
    }

    try {
      return JSON.parse(candidate) as unknown;
    } catch {}
  }

  return null;
}

export function parseOpenClawJsonOutput(...outputs: string[]): unknown {
  for (const output of outputs) {
    const parsed = parseSingleOpenClawOutput(output);
    if (parsed !== null) {
      return parsed;
    }
  }

  throw new QuestDomainError({
    code: "quest_runner_command_failed",
    details: {
      outputs: outputs
        .map((output) => output.trim())
        .filter((output) => output.length > 0)
        .map((output) => output.slice(0, 1000)),
    },
    message: "OpenClaw did not return parseable JSON output",
    statusCode: 1,
  });
}
