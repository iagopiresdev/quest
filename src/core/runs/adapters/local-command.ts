import { QuestDomainError } from "../../errors";
import { runSubprocess } from "../process";
import { buildProcessEnv } from "../process-env";
import type { RunnerAdapter, RunnerExecutionContext, RunnerExecutionResult } from "./types";

function buildLocalCommandPayload(context: RunnerExecutionContext): string {
  return JSON.stringify(
    {
      cwd: context.cwd,
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
    },
    null,
    2,
  );
}

export class LocalCommandRunnerAdapter implements RunnerAdapter {
  readonly name = "local-command";

  supports(worker: RunnerExecutionContext["worker"]): boolean {
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
          QUEST_SLICE_WORKSPACE: context.sliceState.workspacePath ?? context.cwd,
          QUEST_WORKER_ID: context.worker.id,
          QUEST_WORKSPACE: context.run.spec.workspace,
          QUEST_WORKSPACE_ROOT: context.run.workspaceRoot ?? "",
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
