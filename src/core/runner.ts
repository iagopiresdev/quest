import { QuestDomainError } from "./errors";
import { type QuestRunDocument, type QuestRunSliceState } from "./run-schema";
import { type QuestSliceSpec } from "./spec-schema";
import { type RegisteredWorker } from "./worker-schema";

export type RunnerExecutionResult = {
  summary: string;
};

export type RunnerExecutionContext = {
  run: QuestRunDocument;
  slice: QuestSliceSpec;
  sliceState: QuestRunSliceState;
  worker: RegisteredWorker;
};

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
      summary: `Dry run completed slice ${context.slice.id} with worker ${context.worker.id}`,
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
