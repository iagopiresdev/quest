import { QuestDomainError } from "./errors";
import { runSubprocess } from "./process";
import { buildProcessEnv } from "./process-env";
import type { QuestRunDocument, QuestRunSliceState } from "./run-schema";
import type { SecretStore } from "./secret-store";
import type { QuestSliceSpec } from "./spec-schema";
import type { RegisteredWorker } from "./worker-schema";

export type RunnerExecutionResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
  summary: string;
};

export type RunnerExecutionContext = {
  cwd: string;
  run: QuestRunDocument;
  signal?: AbortSignal;
  slice: QuestSliceSpec;
  sliceState: QuestRunSliceState;
  worker: RegisteredWorker;
};

function buildLocalCommandPayload(context: RunnerExecutionContext): string {
  return JSON.stringify(
    {
      run: {
        id: context.run.id,
        status: context.run.status,
        workspace: context.run.spec.workspace,
        workspaceRoot: context.run.workspaceRoot ?? null,
      },
      slice: context.slice,
      sliceState: {
        assignedRunner: context.sliceState.assignedRunner,
        assignedWorkerId: context.sliceState.assignedWorkerId,
        sliceId: context.sliceState.sliceId,
        status: context.sliceState.status,
        wave: context.sliceState.wave,
        workspacePath: context.sliceState.workspacePath ?? null,
      },
      worker: {
        backend: context.worker.backend,
        id: context.worker.id,
        name: context.worker.name,
      },
      cwd: context.cwd,
    },
    null,
    2,
  );
}

export interface RunnerAdapter {
  readonly name: string;
  supports(worker: RegisteredWorker): boolean;
  execute(context: RunnerExecutionContext): Promise<RunnerExecutionResult>;
}

function describeCommandForPrompt(command: QuestSliceSpec["acceptanceChecks"][number]): string {
  const envOverrideCount = Object.keys(command.env).length;
  const argCount = Math.max(0, command.argv.length - 1);
  const envSuffix = envOverrideCount > 0 ? `, ${envOverrideCount} env override(s)` : "";
  return `${command.argv[0]} (${argCount} arg(s) redacted${envSuffix})`;
}

function buildQuestPrompt(context: RunnerExecutionContext): string {
  const ownedPaths = context.slice.owns.map((path) => `- ${path}`).join("\n");
  const dependencyList =
    context.slice.dependsOn.length === 0
      ? "- none"
      : context.slice.dependsOn.map((dependency) => `- ${dependency}`).join("\n");
  const sliceAcceptanceChecks =
    context.slice.acceptanceChecks.length === 0
      ? "- none"
      : context.slice.acceptanceChecks
          .map((check) => `- ${describeCommandForPrompt(check)}`)
          .join("\n");
  const globalAcceptanceChecks =
    context.run.spec.acceptanceChecks.length === 0
      ? "- none"
      : context.run.spec.acceptanceChecks
          .map((check) => `- ${describeCommandForPrompt(check)}`)
          .join("\n");

  return [
    `Quest: ${context.run.spec.title}`,
    `Slice: ${context.slice.title} (${context.slice.id})`,
    "",
    "Goal:",
    context.slice.goal,
    "",
    "Constraints:",
    "- Work only within the owned paths for this slice unless a generated file is strictly required.",
    "- Leave code changes in the current workspace; do not describe hypothetical diffs only.",
    "- Keep the final response short and focused on completed work and residual risks.",
    "",
    "Owned paths:",
    ownedPaths,
    "",
    "Dependencies:",
    dependencyList,
    "",
    "Later slice acceptance checks:",
    sliceAcceptanceChecks,
    "",
    "Global acceptance checks before integration:",
    globalAcceptanceChecks,
  ].join("\n");
}

async function resolveAuthEnv(
  worker: RegisteredWorker,
  secretStore: SecretStore,
): Promise<Record<string, string>> {
  const auth = worker.backend.auth;
  if (!auth || auth.mode === "native-login") {
    return {};
  }

  if (auth.mode === "env-var") {
    const value = auth.envVar ? Bun.env[auth.envVar] : undefined;
    if (!value) {
      throw new QuestDomainError({
        code: "quest_runner_unavailable",
        details: { envVar: auth.envVar, workerId: worker.id },
        message: `Environment variable ${auth.envVar} is not set for worker ${worker.id}`,
        statusCode: 1,
      });
    }

    return { [auth.targetEnvVar]: value };
  }

  if (!auth.secretRef) {
    throw new QuestDomainError({
      code: "quest_runner_unavailable",
      details: { workerId: worker.id },
      message: `Worker ${worker.id} is missing a secret-store reference`,
      statusCode: 1,
    });
  }

  return { [auth.targetEnvVar]: await secretStore.getSecret(auth.secretRef) };
}

async function verifyCodexNativeLogin(executable: string, worker: RegisteredWorker): Promise<void> {
  const result = await runSubprocess({
    cmd: [executable, "login", "status"],
    cwd: Bun.env.PWD ?? ".",
    env: buildProcessEnv(worker.backend.env),
    timeoutMs: 30 * 1000,
  });

  if (result.exitCode !== 0) {
    throw new QuestDomainError({
      code: "quest_runner_unavailable",
      details: {
        command: [executable, "login", "status"],
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        workerId: worker.id,
      },
      message: `Codex native login is not available for ${worker.id}`,
      statusCode: 1,
    });
  }
}

export class DryRunRunnerAdapter implements RunnerAdapter {
  readonly name = "dry-run";

  supports(): boolean {
    return true;
  }

  async execute(context: RunnerExecutionContext): Promise<RunnerExecutionResult> {
    return {
      exitCode: 0,
      stderr: "",
      stdout: "",
      summary: `Dry run completed slice ${context.slice.id} with worker ${context.worker.id}`,
    };
  }
}

export class LocalCommandRunnerAdapter implements RunnerAdapter {
  readonly name = "local-command";

  supports(worker: RegisteredWorker): boolean {
    return (
      worker.backend.adapter === this.name &&
      Array.isArray(worker.backend.command) &&
      worker.backend.command.length > 0
    );
  }

  async execute(context: RunnerExecutionContext): Promise<RunnerExecutionResult> {
    const command = context.worker.backend.command;
    if (!command || command.length === 0) {
      throw new QuestDomainError({
        code: "quest_runner_unavailable",
        details: { workerId: context.worker.id },
        message: `Worker ${context.worker.id} has no command configured`,
        statusCode: 1,
      });
    }

    const payload = buildLocalCommandPayload(context);
    const { aborted, exitCode, stderr, stderrTruncated, stdout, stdoutTruncated, timedOut } =
      await runSubprocess({
        cmd: command,
        cwd: context.cwd,
        env: buildProcessEnv({
          ...context.worker.backend.env,
          QUEST_RUN_ID: context.run.id,
          QUEST_SLICE_ID: context.slice.id,
          QUEST_WORKER_ID: context.worker.id,
          QUEST_WORKSPACE: context.run.spec.workspace,
          QUEST_WORKSPACE_ROOT: context.run.workspaceRoot ?? "",
          QUEST_SLICE_WORKSPACE: context.sliceState.workspacePath ?? context.cwd,
        }),
        signal: context.signal,
        stdin: payload,
        timeoutMs: 5 * 60 * 1000,
      });

    if (timedOut) {
      throw new QuestDomainError({
        code: "quest_subprocess_timed_out",
        details: {
          command,
          cwd: context.cwd,
          workerId: context.worker.id,
        },
        message: `Worker command timed out for ${context.worker.id}`,
        statusCode: 1,
      });
    }

    if (aborted || context.signal?.aborted) {
      throw new QuestDomainError({
        code: "quest_subprocess_aborted",
        details: {
          command,
          workerId: context.worker.id,
        },
        message: `Worker command was aborted for ${context.worker.id}`,
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
        message: `Worker command failed for ${context.worker.id} with exit code ${exitCode}`,
        statusCode: 1,
      });
    }

    return {
      exitCode,
      stderr,
      stdout,
      summary:
        stdout.trim().length > 0
          ? stdout.trim()
          : `Local command completed slice ${context.slice.id}`,
    };
  }
}

export class CodexCliRunnerAdapter implements RunnerAdapter {
  readonly name = "codex-cli";

  constructor(private readonly secretStore: SecretStore) {}

  supports(worker: RegisteredWorker): boolean {
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
    const { aborted, exitCode, stderr, stderrTruncated, stdout, stdoutTruncated, timedOut } =
      await runSubprocess({
        cmd: [
          executable,
          "exec",
          "-C",
          context.cwd,
          "-m",
          context.worker.backend.profile,
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
          QUEST_WORKER_ID: context.worker.id,
          QUEST_WORKSPACE: context.run.spec.workspace,
          QUEST_WORKSPACE_ROOT: context.run.workspaceRoot ?? "",
          QUEST_SLICE_WORKSPACE: context.sliceState.workspacePath ?? context.cwd,
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

export class RunnerRegistry {
  constructor(private readonly adapters: RunnerAdapter[]) {}

  resolve(worker: RegisteredWorker, options: { forceDryRun?: boolean } = {}): RunnerAdapter {
    if (options.forceDryRun) {
      const dryRun = this.adapters.find((adapter) => adapter.name === "dry-run");
      if (!dryRun) {
        throw new QuestDomainError({
          code: "quest_runner_unavailable",
          details: { adapter: "dry-run" },
          message: "Dry-run adapter is not configured",
          statusCode: 1,
        });
      }

      return dryRun;
    }

    const adapter = this.adapters.find(
      (candidate) => candidate.name === worker.backend.adapter && candidate.supports(worker),
    );
    if (!adapter) {
      throw new QuestDomainError({
        code: "quest_runner_unavailable",
        details: { adapter: worker.backend.adapter, workerId: worker.id },
        message: `No runner adapter is available for worker ${worker.id}`,
        statusCode: 1,
      });
    }

    return adapter;
  }
}
