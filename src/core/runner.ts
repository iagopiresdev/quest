import { QuestDomainError } from "./errors";
import type { QuestRunDocument, QuestRunSliceState } from "./run-schema";
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
  slice: QuestSliceSpec;
  sliceState: QuestRunSliceState;
  worker: RegisteredWorker;
};

async function readPipe(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return "";
  }

  return await new Response(stream).text();
}

async function runCommand(options: {
  cmd: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: string;
}): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const process = Bun.spawn({
    cmd: options.cmd,
    cwd: options.cwd,
    env: options.env,
    stdin: new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    readPipe(process.stdout),
    readPipe(process.stderr),
  ]);

  return {
    exitCode,
    stderr,
    stdout,
  };
}

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
    const { exitCode, stderr, stdout } = await runCommand({
      cmd: command,
      cwd: context.cwd,
      env: {
        ...Bun.env,
        ...context.worker.backend.env,
        QUEST_RUN_ID: context.run.id,
        QUEST_SLICE_ID: context.slice.id,
        QUEST_WORKER_ID: context.worker.id,
        QUEST_WORKSPACE: context.run.spec.workspace,
        QUEST_WORKSPACE_ROOT: context.run.workspaceRoot ?? "",
        QUEST_SLICE_WORKSPACE: context.sliceState.workspacePath ?? context.cwd,
      },
      stdin: payload,
    });

    if (exitCode !== 0) {
      throw new QuestDomainError({
        code: "quest_runner_command_failed",
        details: {
          command,
          exitCode,
          stderr,
          stdout,
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
