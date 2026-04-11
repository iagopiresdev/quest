import { QuestDomainError } from "./errors";
import { appendEvent } from "./run-lifecycle";
import type { QuestRunDocument } from "./run-schema";
import type { QuestRunStore } from "./run-store";
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
}

export class QuestRunCleanup {
  constructor(private readonly runStore: QuestRunStore) {}

  async cleanupRun(runId: string): Promise<QuestRunDocument> {
    const run = await this.runStore.getRun(runId);
    requireCleanupableRun(run);
    await cleanupExecutionWorkspaces(run);
    appendEvent(run, "run_workspace_cleaned", { runId });
    return await this.runStore.saveRun(run);
  }
}
