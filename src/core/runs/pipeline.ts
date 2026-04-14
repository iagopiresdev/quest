import { QuestDomainError } from "../errors";
import type { QuestPartyStateStore } from "../party-state";
import type { QuestRunExecutor } from "./executor";
import type { QuestRunIntegrator } from "./integrator";
import type { QuestRunLander } from "./lander";
import type { QuestRunDocument } from "./schema";

export type ExecuteRunPipelineOptions = {
  autoIntegrate?: boolean | undefined;
  dryRun?: boolean | undefined;
  land?: boolean | undefined;
  sourceRepositoryPath?: string | undefined;
  targetRef?: string | undefined;
};

export class QuestRunPipeline {
  constructor(
    private readonly runExecutor: QuestRunExecutor,
    private readonly runIntegrator: QuestRunIntegrator,
    private readonly runLander: QuestRunLander,
    private readonly partyStateStore: QuestPartyStateStore,
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

    if (options.land && !options.autoIntegrate) {
      throw new QuestDomainError({
        code: "quest_run_invalid_execute_options",
        details: { autoIntegrate: false, land: true, runId },
        message: "Landing requires auto-integration during execute",
        statusCode: 1,
      });
    }

    await this.partyStateStore.requireDispatchAllowed();

    const executedRun = await this.runExecutor.executeRun(runId, {
      dryRun: options.dryRun,
      sourceRepositoryPath: options.sourceRepositoryPath,
    });

    // Auto-integration should only advance runs that actually cleared execution and trials.
    if (!options.autoIntegrate || executedRun.status !== "completed") {
      return executedRun;
    }

    const integratedRun = await this.runIntegrator.integrateRun(runId, {
      sourceRepositoryPath: options.sourceRepositoryPath,
      targetRef: options.targetRef,
    });
    if (!options.land) {
      return integratedRun;
    }

    return await this.runLander.landRun(runId, {
      sourceRepositoryPath: options.sourceRepositoryPath,
      targetRef: options.targetRef,
    });
  }
}
