import { z } from "zod";

import { QuestDomainError } from "../../errors";
import type { SecretStore } from "../../secret-store";
import { runSubprocess } from "../process";
import { buildProcessEnv } from "../process-env";
import { parseOpenClawJsonOutput } from "./openclaw-shared";
import { buildRunnerPrompt, resolveAuthEnv } from "./shared";
import type { RunnerAdapter, RunnerExecutionContext, RunnerExecutionResult } from "./types";

const openClawAgentResponseSchema = z
  .object({
    result: z
      .object({
        payloads: z
          .array(
            z.object({
              text: z.string().optional(),
            }),
          )
          .optional(),
        summary: z.string().optional(),
      })
      .optional(),
    summary: z.string().optional(),
  })
  .passthrough();

function resolveOpenClawSummary(responseBody: unknown): string | null {
  const parsed = openClawAgentResponseSchema.safeParse(responseBody);
  if (!parsed.success) {
    return null;
  }

  const payloadText = parsed.data.result?.payloads
    ?.map((payload) => payload.text?.trim() ?? "")
    .find((text) => text.length > 0);
  if (payloadText) {
    return payloadText;
  }

  const nestedSummary = parsed.data.result?.summary?.trim();
  if (nestedSummary) {
    return nestedSummary;
  }

  const topLevelSummary = parsed.data.summary?.trim();
  return topLevelSummary && topLevelSummary.length > 0 ? topLevelSummary : null;
}

function readProviderOption(
  options: Record<string, string> | undefined,
  ...keys: string[]
): string | undefined {
  if (!options) {
    return undefined;
  }

  for (const key of keys) {
    const value = options[key];
    if (value) {
      return value;
    }
  }

  return undefined;
}

export class OpenClawCliRunnerAdapter implements RunnerAdapter {
  readonly name = "openclaw-cli";

  constructor(private readonly secretStore: SecretStore) {}

  supports(worker: RunnerExecutionContext["worker"]): boolean {
    return worker.backend.adapter === this.name;
  }

  async execute(context: RunnerExecutionContext): Promise<RunnerExecutionResult> {
    const executable = context.worker.backend.executable ?? "openclaw";
    const prompt = buildRunnerPrompt(context);
    const authEnv = await resolveAuthEnv(context.worker, this.secretStore);
    const providerOptions = context.worker.backend.runtime?.providerOptions;
    const command = [executable, "agent"];
    if (context.worker.backend.sessionId) {
      command.push("--session-id", context.worker.backend.sessionId);
    } else {
      command.push("--agent", context.worker.backend.agentId ?? "main");
    }
    command.push("--message", prompt, "--json");

    if (context.worker.backend.runtime?.reasoningEffort) {
      command.push("--thinking", context.worker.backend.runtime.reasoningEffort);
    }

    const verbose = readProviderOption(providerOptions, "verbose");
    if (verbose && ["off", "on", "full"].includes(verbose)) {
      command.push("--verbose", verbose);
    }

    const timeoutSeconds = readProviderOption(providerOptions, "timeout_seconds", "timeoutSeconds");
    if (timeoutSeconds) {
      command.push("--timeout", timeoutSeconds);
    }

    if (context.worker.backend.local) {
      command.push("--local");
    }

    const { aborted, exitCode, stderr, stderrTruncated, stdout, stdoutTruncated, timedOut } =
      await runSubprocess({
        cmd: command,
        cwd: context.cwd,
        env: buildProcessEnv({
          ...context.worker.backend.env,
          ...authEnv,
          ...(context.worker.backend.gatewayUrl
            ? { OPENCLAW_GATEWAY_URL: context.worker.backend.gatewayUrl }
            : {}),
          QUEST_RUN_ID: context.run.id,
          QUEST_SLICE_ID: context.slice.id,
          QUEST_SLICE_PHASE: context.phase,
          QUEST_SLICE_WORKSPACE: context.sliceState.workspacePath ?? context.cwd,
          QUEST_WORKER_ID: context.worker.id,
          QUEST_WORKSPACE: context.run.spec.workspace,
          QUEST_WORKSPACE_ROOT: context.run.workspaceRoot ?? "",
        }),
        signal: context.signal,
        timeoutMs: 20 * 60 * 1000,
      });

    if (timedOut) {
      throw new QuestDomainError({
        code: "quest_subprocess_timed_out",
        details: {
          executable,
          workerId: context.worker.id,
        },
        message: `OpenClaw execution timed out for ${context.worker.id}`,
        statusCode: 1,
      });
    }

    if (aborted || context.signal?.aborted) {
      throw new QuestDomainError({
        code: "quest_subprocess_aborted",
        details: {
          executable,
          workerId: context.worker.id,
        },
        message: `OpenClaw execution was aborted for ${context.worker.id}`,
        statusCode: 1,
      });
    }

    if (exitCode !== 0) {
      throw new QuestDomainError({
        code: "quest_runner_command_failed",
        details: {
          command,
          exitCode,
          stderr,
          stderrTruncated,
          stdout,
          stdoutTruncated,
          workerId: context.worker.id,
        },
        message: `OpenClaw command failed for ${context.worker.id} with exit code ${exitCode}`,
        statusCode: 1,
      });
    }

    let summary = stdout.trim();
    try {
      const responseBody = parseOpenClawJsonOutput(stdout, stderr);
      summary =
        resolveOpenClawSummary(responseBody) ?? `OpenClaw completed slice ${context.slice.id}`;
    } catch {
      if (summary.length === 0) {
        summary = stderr.trim();
      }
      if (summary.length === 0) {
        summary = `OpenClaw completed slice ${context.slice.id}`;
      }
    }

    return {
      exitCode,
      stderr,
      stdout,
      summary,
    };
  }
}
