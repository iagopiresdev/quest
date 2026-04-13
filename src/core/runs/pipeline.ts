import { QuestDomainError } from "../errors";
import type { QuestRunExecutor } from "./executor";
import type { QuestRunIntegrator } from "./integrator";
import type { QuestRunDocument } from "./schema";

export type ExecuteRunPipelineOptions = {
  autoIntegrate?: boolean | undefined;
  dryRun?: boolean | undefined;
  sourceRepositoryPath?: string | undefined;
  targetRef?: string | undefined;
};

export class QuestRunPipeline {
  constructor(
    private readonly runExecutor: QuestRunExecutor,
    private readonly runIntegrator: QuestRunIntegrator,
  ) {}

  async executeRun(
    runId: string,
    options: ExecuteRunPipelineOptions = {},
  ): Promise<QuestRunDocument> {
    if (options.autoIntegrate && options.dryRun) {
      throw new QuestDomainError({
        code: "quest_run_invalid_execute_options",
        details: { autoIntegrate: true, dryRun: true, runId },
        message: "Dry-run execution cannot auto-integrate",
        statusCode: 1,
      });
    }

    const executedRun = await this.runExecutor.executeRun(runId, {
      dryRun: options.dryRun,
      sourceRepositoryPath: options.sourceRepositoryPath,
    });

    // Auto-integration should only advance runs that actually cleared execution and trials.
    if (!options.autoIntegrate || executedRun.status !== "completed") {
      return executedRun;
    }

    return await this.runIntegrator.integrateRun(runId, {
      sourceRepositoryPath: options.sourceRepositoryPath,
      targetRef: options.targetRef,
    });
  }
}
