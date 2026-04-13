import { QuestDomainError } from "../errors";
import { SecretStore } from "../secret-store";
import type { WorkerRegistry } from "../workers/registry";
import { cleanupRunOpenClawAgents } from "./adapters/openclaw-maintenance";
import { appendEvent } from "./lifecycle";
import type { QuestRunDocument } from "./schema";
import type { QuestRunStore } from "./store";
import { cleanupExecutionWorkspaces } from "./workspace-materializer";

function requireCleanupableRun(run: QuestRunDocument): void {
  if (run.status === "running") {
    throw new QuestDomainError({
      code: "quest_run_not_cleanupable",
      details: { runId: run.id, status: run.status },
      message: `Quest run ${run.id} cannot be cleaned up while running`,
      statusCode: 1,
    });
  }

  if (
    run.sourceRepositoryPath &&
    run.status !== "aborted" &&
    !run.events.some((event) => event.type === "run_integration_checks_failed") &&
    !run.events.some((event) => event.type === "run_integrated")
  ) {
    // Aborted runs and failed boss fights already gave up their replay path, so keeping their
    // worktrees only leaves stale editor/indexer roots behind. Completed runs still need a real
    // turn-in before cleanup removes the integration path.
    throw new QuestDomainError({
      code: "quest_run_not_cleanupable",
      details: { runId: run.id, status: run.status },
      message: `Quest run ${run.id} cannot be cleaned before integration finishes`,
      statusCode: 1,
    });
  }
}

export class QuestRunCleanup {
  constructor(
    private readonly runStore: QuestRunStore,
    private readonly workerRegistry?: WorkerRegistry,
    private readonly secretStore: SecretStore = new SecretStore(),
  ) {}

  async cleanupRun(runId: string): Promise<QuestRunDocument> {
    const run = await this.runStore.getRun(runId);
    requireCleanupableRun(run);
    await cleanupExecutionWorkspaces(run);
    const openClawCleanupWarnings =
      this.workerRegistry === undefined
        ? []
        : await cleanupRunOpenClawAgents(
            run,
            await this.workerRegistry.listWorkers(),
            this.secretStore,
          );
    appendEvent(run, "run_workspace_cleaned", {
      openClawCleanupWarnings,
      runId,
    });
    return await this.runStore.saveRun(run);
  }
}
