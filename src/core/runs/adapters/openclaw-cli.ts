import { join } from "node:path";
import { z } from "zod";

import { QuestDomainError } from "../../errors";
import type { SecretStore } from "../../secret-store";
import { runSubprocess } from "../process";
import { buildProcessEnv } from "../process-env";
import { buildQuestAgentId, buildQuestSessionId } from "./openclaw-maintenance";
import { assertOpenClawResponseSucceeded, parseOpenClawJsonOutput } from "./openclaw-shared";
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

const openClawAgentListSchema = z.array(
  z
    .object({
      id: z.string(),
      model: z.string().optional(),
    })
    .passthrough(),
);

type PreparedOpenClawTarget = {
  agentId: string | undefined;
  env: Record<string, string>;
  sessionId: string;
};

function resolveConfiguredModel(profile: string): string | null {
  const trimmed = profile.trim();
  if (trimmed.length === 0 || trimmed.startsWith("openclaw/")) {
    return null;
  }

  return trimmed;
}

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

async function resolveAgentModelFromRegistry(
  executable: string,
  agentId: string,
  env: Record<string, string>,
): Promise<string | null> {
  const result = await runSubprocess({
    cmd: [executable, "agents", "list", "--json"],
    cwd: Bun.env.PWD ?? ".",
    env,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    return null;
  }

  try {
    const payload = parseOpenClawJsonOutput(result.stdout, result.stderr);
    const parsed = openClawAgentListSchema.safeParse(payload);
    if (!parsed.success) {
      return null;
    }

    return parsed.data.find((agent) => agent.id === agentId)?.model?.trim() ?? null;
  } catch {
    return null;
  }
}

async function createTemporaryAgent(
  executable: string,
  context: RunnerExecutionContext,
  env: Record<string, string>,
): Promise<{ agentId: string }> {
  const configuredModel = resolveConfiguredModel(context.worker.backend.profile);
  const fallbackModel = context.worker.backend.agentId
    ? await resolveAgentModelFromRegistry(executable, context.worker.backend.agentId, env)
    : null;
  const model = configuredModel ?? fallbackModel;
  if (!model) {
    throw new QuestDomainError({
      code: "quest_runner_unavailable",
      details: {
        agentId: context.worker.backend.agentId ?? null,
        profile: context.worker.backend.profile,
        workerId: context.worker.id,
      },
      message: `OpenClaw worker ${context.worker.id} needs a concrete model profile for quest execution`,
      statusCode: 1,
    });
  }

  const agentId = buildQuestAgentId(context.run.id, context.slice.id, context.phase);
  const agentDir = join(
    context.run.workspaceRoot ?? context.cwd,
    ".quest-runner",
    "openclaw-agents",
    agentId,
    "agent",
  );
  const addResult = await runSubprocess({
    cmd: [
      executable,
      "agents",
      "add",
      agentId,
      "--workspace",
      context.cwd,
      "--model",
      model,
      "--agent-dir",
      agentDir,
      "--non-interactive",
      "--json",
    ],
    cwd: Bun.env.PWD ?? ".",
    env,
    timeoutMs: 60_000,
  });
  if (addResult.exitCode !== 0) {
    throw new QuestDomainError({
      code: "quest_runner_unavailable",
      details: {
        agentDir,
        agentId,
        model,
        stderr: addResult.stderr,
        stdout: addResult.stdout,
        workerId: context.worker.id,
      },
      message: `OpenClaw could not create a temporary quest agent for ${context.worker.id}`,
      statusCode: 1,
    });
  }

  return { agentId };
}

async function prepareOpenClawTarget(
  executable: string,
  context: RunnerExecutionContext,
  env: Record<string, string>,
): Promise<PreparedOpenClawTarget> {
  const sessionId =
    context.worker.backend.sessionId ??
    buildQuestSessionId(context.run.id, context.slice.id, context.phase);
  if (context.worker.backend.local) {
    throw new QuestDomainError({
      code: "quest_runner_unavailable",
      details: {
        workerId: context.worker.id,
      },
      message:
        `OpenClaw local mode is not supported for quest execution on ${context.worker.id}; ` +
        "use the gateway-backed adapter path instead",
      statusCode: 1,
    });
  }

  const temporaryAgent = await createTemporaryAgent(executable, context, env);
  return {
    agentId: temporaryAgent.agentId,
    env,
    sessionId,
  };
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
    const processEnv = buildProcessEnv({
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
    });
    const target = await prepareOpenClawTarget(executable, context, processEnv);
    const command = [executable, "agent", "--session-id", target.sessionId];

    // Grind taught the hard lesson here: shared agent state silently poisons repo-edit turns.
    // Quest-runner uses temporary workspace-bound OpenClaw agents for quest execution instead of
    // pointing repo work at a long-lived agent workspace.
    if (target.agentId) {
      command.push("--agent", target.agentId);
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

    // OpenClaw agent deletion prunes the agent workspace, so quest-runner leaves these temporary
    // agents in place until a later cleanup layer can remove them without deleting live slice data.
    const { aborted, exitCode, stderr, stderrTruncated, stdout, stdoutTruncated, timedOut } =
      await runSubprocess({
        cmd: command,
        cwd: context.cwd,
        env: target.env,
        idleTimeoutMs: context.idleTimeoutMs,
        onExit: (pid) => context.onSubprocessExit?.(pid),
        onSpawn: (pid) => context.onSubprocessSpawn?.(command, pid),
        signal: context.signal,
        timeoutMs: context.timeoutMs ?? 20 * 60 * 1000,
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
      assertOpenClawResponseSucceeded(responseBody, {
        command,
        workerId: context.worker.id,
      });
      summary =
        resolveOpenClawSummary(responseBody) ?? `OpenClaw completed slice ${context.slice.id}`;
    } catch (error) {
      if (error instanceof QuestDomainError) {
        throw error;
      }
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
