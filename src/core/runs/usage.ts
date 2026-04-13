import type { QuestRunDocument, QuestRunSliceOutput } from "./schema";

export type TokenUsage = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  totalTokens?: number | undefined;
};

export type SlicePhaseUsage = {
  phase: "builder" | "tester";
  sliceId: string;
  summary: string | null;
  tokens: TokenUsage;
  workerId: string | null;
};

export type RunUsageSummary = {
  phases: SlicePhaseUsage[];
  runId: string;
  totals: TokenUsage & {
    knownPhaseCount: number;
    unknownPhaseCount: number;
  };
};

function parseIntegerToken(value: string): number | undefined {
  const normalized = value.replaceAll(",", "").trim();
  if (!/^\d+$/.test(normalized)) {
    return undefined;
  }

  return Number.parseInt(normalized, 10);
}

function parseJsonUsageBlock(text: string): TokenUsage {
  const usage: TokenUsage = {};
  const matchers: Array<[keyof TokenUsage, RegExp[]]> = [
    ["inputTokens", [/"prompt_tokens"\s*:\s*(\d+)/i, /"input_tokens"\s*:\s*(\d+)/i]],
    ["outputTokens", [/"completion_tokens"\s*:\s*(\d+)/i, /"output_tokens"\s*:\s*(\d+)/i]],
    ["reasoningTokens", [/"reasoning_tokens"\s*:\s*(\d+)/i]],
    ["totalTokens", [/"total_tokens"\s*:\s*(\d+)/i]],
  ];

  for (const [key, patterns] of matchers) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      const value = match?.[1] ? parseIntegerToken(match[1]) : undefined;
      if (value !== undefined) {
        usage[key] = value;
        break;
      }
    }
  }

  return usage;
}

function parseHumanUsageText(text: string): TokenUsage {
  const usage: TokenUsage = {};
  const totalMatch =
    text.match(/tokens used[\s:]+([\d,]+)/i) ??
    text.match(/total tokens[\s:]+([\d,]+)/i) ??
    text.match(/used[\s:]+([\d,]+)\s+tokens/i);
  const totalTokens = totalMatch?.[1] ? parseIntegerToken(totalMatch[1]) : undefined;
  if (totalTokens !== undefined) {
    usage.totalTokens = totalTokens;
  }

  return usage;
}

function mergeUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens ?? right.inputTokens,
    outputTokens: left.outputTokens ?? right.outputTokens,
    reasoningTokens: left.reasoningTokens ?? right.reasoningTokens,
    totalTokens: left.totalTokens ?? right.totalTokens,
  };
}

export function parseOutputTokenUsage(output: QuestRunSliceOutput | undefined): TokenUsage {
  if (!output) {
    return {};
  }

  return mergeUsage(
    mergeUsage(parseJsonUsageBlock(output.stdout), parseJsonUsageBlock(output.stderr)),
    mergeUsage(parseHumanUsageText(output.stdout), parseHumanUsageText(output.stderr)),
  );
}

function sumOptional(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  if (present.length === 0) {
    return undefined;
  }

  return present.reduce((total, value) => total + value, 0);
}

function buildPhaseUsage(
  phase: "builder" | "tester",
  output: QuestRunSliceOutput | undefined,
  sliceId: string,
  workerId: string | null,
): SlicePhaseUsage {
  return {
    phase,
    sliceId,
    summary: output?.summary ?? null,
    tokens: parseOutputTokenUsage(output),
    workerId,
  };
}

export function summarizeRunUsage(run: QuestRunDocument): RunUsageSummary {
  const phases = run.slices.flatMap((slice) => [
    buildPhaseUsage("builder", slice.lastOutput, slice.sliceId, slice.assignedWorkerId),
    ...(slice.lastTesterOutput
      ? [
          buildPhaseUsage(
            "tester",
            slice.lastTesterOutput,
            slice.sliceId,
            slice.assignedTesterWorkerId,
          ),
        ]
      : []),
  ]);

  const knownPhases = phases.filter((phase) => phase.tokens.totalTokens !== undefined);
  const totals = {
    inputTokens: sumOptional(phases.map((phase) => phase.tokens.inputTokens)),
    knownPhaseCount: knownPhases.length,
    outputTokens: sumOptional(phases.map((phase) => phase.tokens.outputTokens)),
    reasoningTokens: sumOptional(phases.map((phase) => phase.tokens.reasoningTokens)),
    totalTokens: sumOptional(phases.map((phase) => phase.tokens.totalTokens)),
    unknownPhaseCount: phases.length - knownPhases.length,
  };

  return {
    phases,
    runId: run.id,
    totals,
  };
}
