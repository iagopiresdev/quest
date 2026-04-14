import { QuestDomainError } from "../errors";
import { appendEvent, nowIsoString } from "./lifecycle";
import { runSubprocess } from "./process";
import { buildProcessEnv } from "./process-env";
import type { QuestRunActiveProcess, QuestRunDocument } from "./schema";
import type { QuestRunStore } from "./store";
import { ensureGitRepositoryIsClean, resolveGitRepositoryRoot } from "./workspace-materializer";

function buildTrackedProcess(command: string[], pid: number): QuestRunActiveProcess {
  return {
    command: command
      .slice(0, 32)
      .map((part) => (part.length <= 240 ? part : `${part.slice(0, 237)}...`)),
    kind: "landing",
    pid,
    startedAt: nowIsoString(),
  };
}

function clearExecutionStateOnRun(run: QuestRunDocument): void {
  run.activeProcesses = [];
  delete run.executionHeartbeatAt;
  delete run.executionHostPid;
  delete run.executionStage;
}

async function readRevision(cwd: string, ref: string): Promise<string> {
  const result = await runSubprocess({
    cmd: ["git", "rev-parse", ref],
    cwd,
    env: buildProcessEnv(),
  });
  if (result.exitCode !== 0) {
    throw new QuestDomainError({
      code: "quest_run_not_landable",
      details: { cwd, ref, stderr: result.stderr, stdout: result.stdout },
      message: `Failed to resolve git ref ${ref} in ${cwd}`,
      statusCode: 1,
    });
  }

  return result.stdout.trim();
}

async function readCurrentBranch(cwd: string): Promise<string | null> {
  const result = await runSubprocess({
    cmd: ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
    cwd,
    env: buildProcessEnv(),
  });
  if (result.exitCode !== 0) {
    return null;
  }

  const branch = result.stdout.trim();
  return branch.length > 0 ? branch : null;
}

function requireLandableRun(run: QuestRunDocument): void {
  if (!run.sourceRepositoryPath || !run.integrationWorkspacePath || !run.integrationBaseRevision) {
    throw new QuestDomainError({
      code: "quest_run_not_landable",
      details: { runId: run.id },
      message: `Quest run ${run.id} is missing integration state and cannot be landed`,
      statusCode: 1,
    });
  }

  if (!run.events.some((event) => event.type === "run_integrated")) {
    throw new QuestDomainError({
      code: "quest_run_not_landable",
      details: { runId: run.id, status: run.status },
      message: `Quest run ${run.id} has not cleared boss fight and cannot be landed`,
      statusCode: 1,
    });
  }
}

export class QuestRunLander {
  constructor(private readonly runStore: QuestRunStore) {}

  async landRun(
    runId: string,
    options: { sourceRepositoryPath?: string | undefined; targetRef?: string | undefined } = {},
  ): Promise<QuestRunDocument> {
    const run = await this.runStore.getRun(runId);
    if (options.sourceRepositoryPath) {
      run.sourceRepositoryPath = options.sourceRepositoryPath;
    }

    requireLandableRun(run);
    if (run.landedAt && run.landedRevision) {
      return run;
    }

    const sourceRepositoryPath = run.sourceRepositoryPath;
    const integrationWorkspacePath = run.integrationWorkspacePath;
    const integrationBaseRevision = run.integrationBaseRevision;
    if (!sourceRepositoryPath || !integrationWorkspacePath || !integrationBaseRevision) {
      throw new QuestDomainError({
        code: "quest_run_not_landable",
        details: { runId: run.id },
        message: `Quest run ${run.id} is missing landing inputs`,
        statusCode: 1,
      });
    }

    const repositoryRoot = await resolveGitRepositoryRoot(sourceRepositoryPath);
    await ensureGitRepositoryIsClean(repositoryRoot);
    await this.runStore.markRunExecutionHost(run.id, "land");

    try {
      const targetRef = options.targetRef ?? run.targetRef ?? "HEAD";
      const currentBranch = await readCurrentBranch(repositoryRoot);
      if (targetRef !== "HEAD" && currentBranch !== targetRef) {
        throw new QuestDomainError({
          code: "quest_run_not_landable",
          details: {
            currentBranch,
            runId: run.id,
            targetRef,
          },
          message:
            `Quest run ${run.id} can only land onto the currently checked out branch; ` +
            `expected ${targetRef}, found ${currentBranch ?? "detached HEAD"}`,
          statusCode: 1,
        });
      }

      const sourceRevision = await readRevision(
        repositoryRoot,
        targetRef === "HEAD" ? "HEAD" : targetRef,
      );
      if (sourceRevision !== integrationBaseRevision) {
        run.integrationRescueStatus = "pending";
        appendEvent(run, "run_integration_failed", {
          currentRevision: sourceRevision,
          expectedRevision: integrationBaseRevision,
          phase: "land",
          runId: run.id,
          targetRef,
        });
        await this.runStore.saveRun(run);
        throw new QuestDomainError({
          code: "quest_run_not_landable",
          details: {
            currentRevision: sourceRevision,
            expectedRevision: integrationBaseRevision,
            runId: run.id,
            targetRef,
          },
          message: `Quest run ${run.id} cannot land because the source target drifted`,
          statusCode: 1,
        });
      }

      const integrationHead = await readRevision(integrationWorkspacePath, "HEAD");
      const command = ["git", "merge", "--ff-only", integrationHead];
      appendEvent(run, "run_landing_started", {
        integrationWorkspacePath,
        runId: run.id,
        sourceRepositoryPath: repositoryRoot,
        targetRef,
      });
      await this.runStore.saveRun(run);

      const mergeResult = await runSubprocess({
        cmd: command,
        cwd: repositoryRoot,
        env: buildProcessEnv(),
        onExit: async (pid) => {
          await this.runStore.clearActiveProcess(run.id, pid);
        },
        onSpawn: async (pid) => {
          await this.runStore.registerActiveProcess(run.id, buildTrackedProcess(command, pid));
        },
      });
      if (mergeResult.exitCode !== 0) {
        run.integrationRescueStatus = "pending";
        appendEvent(run, "run_integration_failed", {
          phase: "land",
          runId: run.id,
          stderr: mergeResult.stderr,
          stdout: mergeResult.stdout,
          targetRef,
        });
        await this.runStore.saveRun(run);
        throw new QuestDomainError({
          code: "quest_integration_failed",
          details: {
            runId: run.id,
            stderr: mergeResult.stderr,
            stdout: mergeResult.stdout,
            targetRef,
          },
          message: `Quest run ${run.id} failed to land into ${targetRef}`,
          statusCode: 1,
        });
      }

      run.integrationRescueStatus = "unset";
      run.landedAt = nowIsoString();
      run.landedRevision = await readRevision(repositoryRoot, "HEAD");
      run.landedTargetRef = targetRef;
      appendEvent(run, "run_landed", {
        landedRevision: run.landedRevision,
        runId: run.id,
        targetRef,
      });
      return await this.runStore.saveRun(run);
    } finally {
      clearExecutionStateOnRun(run);
      await this.runStore.clearRunExecutionState(run.id);
    }
  }
}
