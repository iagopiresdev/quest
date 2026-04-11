import { QuestDomainError } from "../../errors";
import type { SecretStore } from "../../secret-store";
import type { WorkerRuntimeConfig } from "../../workers/runtime";
import { runSubprocess } from "../process";
import { buildProcessEnv } from "../process-env";
import { buildQuestPrompt, resolveAuthEnv, verifyCodexNativeLogin } from "./shared";
import type { RunnerAdapter, RunnerExecutionContext, RunnerExecutionResult } from "./types";

function tomlLiteral(value: string): string {
  return JSON.stringify(value);
}

function buildCodexRuntimeConfigArgs(runtime: WorkerRuntimeConfig | undefined): string[] {
  if (!runtime) {
    return [];
  }

  const overrides: string[] = [];
  const pushOverride = (key: string, value: string): void => {
    overrides.push("-c", `${key}=${value}`);
  };

  if (runtime.reasoningEffort) {
    pushOverride("model_reasoning_effort", tomlLiteral(runtime.reasoningEffort));
  }

  if (runtime.contextWindow !== undefined) {
    pushOverride("model_context_window", String(runtime.contextWindow));
  }

  if (runtime.maxOutputTokens !== undefined) {
    // Codex exposes config overrides via `-c`, so worker runtime tokens live in the same typed
    // model as the rest of the backend settings instead of as ad hoc CLI-only flags.
    pushOverride("model_max_output_tokens", String(runtime.maxOutputTokens));
  }

  if (runtime.temperature !== undefined) {
    pushOverride("model_temperature", String(runtime.temperature));
  }

  if (runtime.topP !== undefined) {
    pushOverride("model_top_p", String(runtime.topP));
  }

  for (const [key, value] of Object.entries(runtime.providerOptions)) {
    pushOverride(key, value);
  }

  return overrides;
}

export class CodexCliRunnerAdapter implements RunnerAdapter {
  readonly name = "codex-cli";

  constructor(private readonly secretStore: SecretStore) {}

  supports(worker: RunnerExecutionContext["worker"]): boolean {
    return worker.backend.adapter === this.name;
  }

  async execute(context: RunnerExecutionContext): Promise<RunnerExecutionResult> {
    const executable = context.worker.backend.executable ?? "codex";
    const outputPath = `${context.cwd}/.quest-runner/codex-last-message.txt`;
    const prompt = buildQuestPrompt(context);
    if (!context.worker.backend.auth || context.worker.backend.auth.mode === "native-login") {
      await verifyCodexNativeLogin(executable, context.worker);
    }

    const authEnv = await resolveAuthEnv(context.worker, this.secretStore);
    const runtimeConfigArgs = buildCodexRuntimeConfigArgs(context.worker.backend.runtime);
    const { aborted, exitCode, stderr, stderrTruncated, stdout, stdoutTruncated, timedOut } =
      await runSubprocess({
        cmd: [
          executable,
          "exec",
          "-C",
          context.cwd,
          "-m",
          context.worker.backend.profile,
          ...runtimeConfigArgs,
          "-s",
          "workspace-write",
          // `codex exec` already runs non-interactively, so we stay on the flags it actually
          // supports instead of carrying top-level approval options that make real runs fail.
          "--skip-git-repo-check",
          "--color",
          "never",
          "--ephemeral",
          "--output-last-message",
          outputPath,
          "-",
        ],
        cwd: context.cwd,
        env: buildProcessEnv({
          ...context.worker.backend.env,
          ...authEnv,
          QUEST_RUN_ID: context.run.id,
          QUEST_SLICE_ID: context.slice.id,
          QUEST_SLICE_WORKSPACE: context.sliceState.workspacePath ?? context.cwd,
          QUEST_WORKER_ID: context.worker.id,
          QUEST_WORKSPACE: context.run.spec.workspace,
          QUEST_WORKSPACE_ROOT: context.run.workspaceRoot ?? "",
        }),
        signal: context.signal,
        stdin: prompt,
        timeoutMs: 20 * 60 * 1000,
      });

    if (timedOut) {
      throw new QuestDomainError({
        code: "quest_subprocess_timed_out",
        details: {
          executable,
          workerId: context.worker.id,
        },
        message: `Codex execution timed out for ${context.worker.id}`,
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
        message: `Codex execution was aborted for ${context.worker.id}`,
        statusCode: 1,
      });
    }

    let summary = stdout.trim();
    const outputFile = Bun.file(outputPath);
    if (await outputFile.exists()) {
      const lastMessage = (await outputFile.text()).trim();
      if (lastMessage.length > 0) {
        summary = lastMessage;
      }
    }

    if (summary.length === 0) {
      summary = `Codex completed slice ${context.slice.id}`;
    }

    if (exitCode !== 0) {
      throw new QuestDomainError({
        code: "quest_runner_command_failed",
        details: {
          command: [executable, "exec"],
          exitCode,
          stderr,
          stderrTruncated,
          stdout,
          stdoutTruncated,
          workerId: context.worker.id,
        },
        message: `Codex command failed for ${context.worker.id} with exit code ${exitCode}`,
        statusCode: 1,
      });
    }

    return {
      exitCode,
      stderr,
      stdout,
      summary,
    };
  }
}
