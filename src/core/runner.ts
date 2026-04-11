import { QuestDomainError } from "./errors";
import { type QuestRunDocument, type QuestRunSliceState } from "./run-schema";
import { type QuestSliceSpec } from "./spec-schema";
import { type RegisteredWorker } from "./worker-schema";

export type RunnerExecutionResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
  summary: string;
};

export type RunnerExecutionContext = {
  run: QuestRunDocument;
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
      },
      slice: context.slice,
      sliceState: {
        assignedRunner: context.sliceState.assignedRunner,
        assignedWorkerId: context.sliceState.assignedWorkerId,
        sliceId: context.sliceState.sliceId,
        status: context.sliceState.status,
        wave: context.sliceState.wave,
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
    return worker.backend.adapter === this.name && Array.isArray(worker.backend.command) && worker.backend.command.length > 0;
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
    const result = Bun.spawnSync({
      cmd: command,
      cwd: context.worker.backend.workingDirectory ?? Bun.env.PWD ?? ".",
      env: {
        ...Bun.env,
        ...context.worker.backend.env,
        QUEST_RUN_ID: context.run.id,
        QUEST_SLICE_ID: context.slice.id,
        QUEST_WORKER_ID: context.worker.id,
        QUEST_WORKSPACE: context.run.spec.workspace,
      },
      stdin: new TextEncoder().encode(payload),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    const exitCode = result.exitCode;

    if (exitCode !== 0) {
      throw new QuestDomainError({
        code: "quest_runner_unavailable",
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
      summary: stdout.trim().length > 0 ? stdout.trim() : `Local command completed slice ${context.slice.id}`,
    };
  }
}

export class RunnerRegistry {
  constructor(
    private readonly adapters: RunnerAdapter[],
  ) {}

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

    const adapter = this.adapters.find((candidate) => candidate.name === worker.backend.adapter && candidate.supports(worker));
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
