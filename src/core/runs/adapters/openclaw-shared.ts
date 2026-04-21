import { QuestDomainError } from "../../errors";
import { isRecord } from "../../shared/type-guards";

type OpenClawResponseContext = {
  command: string[];
  workerId: string;
};

function readPayloadTexts(responseBody: unknown): string[] {
  if (!isRecord(responseBody)) {
    return [];
  }

  const result = responseBody.result;
  if (!isRecord(result) || !Array.isArray(result.payloads)) {
    return [];
  }

  return result.payloads
    .map((payload) =>
      isRecord(payload) && typeof payload.text === "string" ? payload.text.trim() : "",
    )
    .filter((text) => text.length > 0);
}

export function isOpenClawApiErrorText(text: string): boolean {
  return (
    /\bHTTP\s+\d{3}\b.*\bapi_error\b/i.test(text) ||
    /\bapi_error:/i.test(text) ||
    /\bnot support model\b/i.test(text)
  );
}

export function findOpenClawApiErrorText(responseBody: unknown): string | null {
  return readPayloadTexts(responseBody).find(isOpenClawApiErrorText) ?? null;
}

export function assertOpenClawResponseSucceeded(
  responseBody: unknown,
  context: OpenClawResponseContext,
): void {
  const errorText = findOpenClawApiErrorText(responseBody);
  if (!errorText) {
    return;
  }

  throw new QuestDomainError({
    code: "quest_command_failed",
    details: {
      command: context.command,
      summary: errorText,
      workerId: context.workerId,
    },
    message: `OpenClaw reported an API error for ${context.workerId}: ${errorText}`,
    statusCode: 1,
  });
}

function tryParseJson(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

function findJsonTerminator(output: string, startIndex: number): number | null {
  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let index = startIndex; index < output.length; index += 1) {
    const current = output[index];
    if (current === undefined) {
      continue;
    }

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (current === "\\") {
        isEscaped = true;
        continue;
      }

      if (current === '"') {
        inString = false;
      }
      continue;
    }

    if (current === '"') {
      inString = true;
      continue;
    }

    if (current === "{" || current === "[") {
      depth += 1;
      continue;
    }

    if (current === "}" || current === "]") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return null;
}

function extractJsonFragment(output: string): unknown | null {
  const startIndexes = [...output.matchAll(/[[{]/g)].map((match) => match.index ?? -1);
  for (const startIndex of startIndexes) {
    if (startIndex < 0) {
      continue;
    }

    const endIndex = findJsonTerminator(output, startIndex);
    if (endIndex === null) {
      continue;
    }

    const parsed = tryParseJson(output.slice(startIndex, endIndex + 1));
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function parseSingleOpenClawOutput(output: string): unknown | null {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const direct = tryParseJson(trimmed);
  if (direct !== null) {
    return direct;
  }

  const lines = trimmed.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines.slice(index).join("\n").trim();
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
      continue;
    }

    const parsed = tryParseJson(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  return extractJsonFragment(trimmed);
}

export function parseOpenClawJsonOutput(...outputs: string[]): unknown {
  for (const output of outputs) {
    const parsed = parseSingleOpenClawOutput(output);
    if (parsed !== null) {
      return parsed;
    }
  }

  throw new QuestDomainError({
    code: "quest_command_failed",
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
