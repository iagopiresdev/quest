import { rm } from "node:fs/promises";
import { QuestDomainError } from "../errors";
import type { QuestRunIntegrator } from "./integrator";
import { appendEvent } from "./lifecycle";
import { runSubprocess } from "./process";
import { buildProcessEnv } from "./process-env";
import type { QuestRunDocument } from "./schema";
import type { QuestRunStore } from "./store";
import {
  assertWorkspacePathWithinRoot,
  resolveIntegrationWorkspacePathForRunRoot,
} from "./workspace-layout";
import { ensureGitRepositoryIsClean, resolveGitRepositoryRoot } from "./workspace-materializer";

async function removeIntegrationWorkspace(run: QuestRunDocument): Promise<void> {
  if (!run.sourceRepositoryPath || !run.workspaceRoot) {
    return;
  }

  const repositoryRoot = await resolveGitRepositoryRoot(run.sourceRepositoryPath);
  const integrationWorkspacePath =
    run.integrationWorkspacePath ?? resolveIntegrationWorkspacePathForRunRoot(run.workspaceRoot);
  await assertWorkspacePathWithinRoot(
    run.workspaceRoot,
    integrationWorkspacePath,
    "Integration workspace",
  );

  const removeResult = await runSubprocess({
    cmd: ["git", "worktree", "remove", "--force", integrationWorkspacePath],
    cwd: repositoryRoot,
    env: buildProcessEnv(),
  });

  if (removeResult.exitCode === 0) {
    return;
  }

  // Refresh-base is a recovery path. Falling back to direct rm keeps a half-removed worktree from
  // pinning the operator into manual cleanup when git already forgot the path.
  try {
    await rm(integrationWorkspacePath, { force: true, recursive: true });
  } catch (error: unknown) {
    throw new QuestDomainError({
      code: "quest_integration_failed",
      details: {
        path: integrationWorkspacePath,
        reason: error instanceof Error ? error.message : String(error),
        stderr: removeResult.stderr,
        stdout: removeResult.stdout,
      },
      message: `Failed to remove integration workspace for quest run ${run.id}`,
      statusCode: 1,
    });
  }
}

function resetIntegrationState(run: QuestRunDocument, targetRef: string): void {
  delete run.integrationBaseRevision;
  delete run.integrationWorkspacePath;
  delete run.lastIntegrationChecks;
  delete run.landedAt;
  delete run.landedRevision;
  delete run.landedTargetRef;
  run.targetRef = targetRef;
  run.integrationRescueStatus = "unset";
  delete run.integrationRescueNote;
  run.slices.forEach((slice) => {
    slice.integrationStatus = "pending";
    delete slice.integratedCommit;
    delete slice.driftedFromBase;
  });
}

export class QuestRunRefresher {
  constructor(
    private readonly runStore: QuestRunStore,
    private readonly runIntegrator: QuestRunIntegrator,
  ) {}

  async refreshBase(
    runId: string,
    options: { sourceRepositoryPath?: string | undefined; targetRef?: string | undefined } = {},
  ): Promise<QuestRunDocument> {
    const run = await this.runStore.getRun(runId);
    if (options.sourceRepositoryPath) {
      run.sourceRepositoryPath = options.sourceRepositoryPath;
    }

    if (!run.sourceRepositoryPath) {
      throw new QuestDomainError({
        code: "quest_run_not_integratable",
        details: { runId: run.id },
        message: `Quest run ${run.id} has no source repository configured`,
        statusCode: 1,
      });
    }

    if (run.status !== "completed") {
      throw new QuestDomainError({
        code: "quest_run_not_integratable",
        details: { runId: run.id, status: run.status },
        message: `Quest run ${run.id} cannot refresh base from status ${run.status}`,
        statusCode: 1,
      });
    }

    const repositoryRoot = await resolveGitRepositoryRoot(run.sourceRepositoryPath);
    await ensureGitRepositoryIsClean(repositoryRoot);
    const targetRef = options.targetRef ?? run.targetRef ?? "HEAD";

    await removeIntegrationWorkspace(run);
    resetIntegrationState(run, targetRef);
    appendEvent(run, "run_base_refreshed", {
      runId: run.id,
      sourceRepositoryPath: repositoryRoot,
      targetRef,
    });
    await this.runStore.saveRun(run);

    return await this.runIntegrator.integrateRun(runId, {
      sourceRepositoryPath: run.sourceRepositoryPath,
      targetRef,
    });
  }
}
