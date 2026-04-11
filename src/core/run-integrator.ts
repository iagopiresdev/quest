import { readdir, realpath } from "node:fs/promises";
import { $ } from "bun";

import { QuestDomainError } from "./errors";
import { runSubprocess } from "./process";
import { appendEvent } from "./run-lifecycle";
import type { QuestRunCheckResult, QuestRunDocument, QuestRunSliceState } from "./run-schema";
import type { QuestRunStore } from "./run-store";
import { ensureDirectory } from "./storage";
import { ensureGitRepositoryIsClean, resolveGitRepositoryRoot } from "./workspace-materializer";

function requireIntegratableRun(run: QuestRunDocument): void {
  if (run.status !== "completed") {
    throw new QuestDomainError({
      code: "quest_run_not_integratable",
      details: { runId: run.id, status: run.status },
      message: `Quest run ${run.id} cannot be integrated from status ${run.status}`,
      statusCode: 1,
    });
  }

  if (!run.sourceRepositoryPath) {
    throw new QuestDomainError({
      code: "quest_run_not_integratable",
      details: { runId: run.id },
      message: `Quest run ${run.id} has no source repository configured`,
      statusCode: 1,
    });
  }
}

async function readHeadRevision(cwd: string): Promise<string> {
  const result = await runSubprocess({
    cmd: ["git", "rev-parse", "HEAD"],
    cwd,
    env: Bun.env,
  });

  if (result.exitCode !== 0) {
    throw new QuestDomainError({
      code: "quest_integration_failed",
      details: {
        cwd,
        stderr: result.stderr,
        stdout: result.stdout,
      },
      message: `Failed to resolve git HEAD for ${cwd}`,
      statusCode: 1,
    });
  }

  return result.stdout.trim();
}

async function readAheadCount(baseRevision: string, cwd: string): Promise<number> {
  const currentHead = await readHeadRevision(cwd);
  const result = await runSubprocess({
    cmd: ["git", "rev-list", "--count", `${baseRevision}..${currentHead}`],
    cwd,
    env: Bun.env,
  });

  if (result.exitCode !== 0) {
    throw new QuestDomainError({
      code: "quest_integration_failed",
      details: {
        baseRevision,
        cwd,
        stderr: result.stderr,
        stdout: result.stdout,
      },
      message: `Failed to compare revisions for ${cwd}`,
      statusCode: 1,
    });
  }

  return Number.parseInt(result.stdout.trim(), 10);
}

async function readGitStatus(cwd: string): Promise<string> {
  const result = await runSubprocess({
    cmd: ["git", "status", "--porcelain"],
    cwd,
    env: Bun.env,
  });

  if (result.exitCode !== 0) {
    throw new QuestDomainError({
      code: "quest_integration_failed",
      details: {
        cwd,
        stderr: result.stderr,
        stdout: result.stdout,
      },
      message: `Failed to inspect git status for ${cwd}`,
      statusCode: 1,
    });
  }

  return result.stdout;
}

async function directoryHasEntries(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.length > 0;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw new QuestDomainError({
      code: "quest_integration_failed",
      details: {
        path,
        reason: error instanceof Error ? error.message : String(error),
      },
      message: `Failed to inspect integration workspace ${path}`,
      statusCode: 1,
    });
  }
}

async function prepareIntegrationWorkspace(
  run: QuestRunDocument,
  repositoryRoot: string,
  targetRef: string,
): Promise<string> {
  const workspacePath = run.integrationWorkspacePath ?? `${run.workspaceRoot}/integration`;
  run.integrationWorkspacePath = workspacePath;
  run.targetRef = targetRef;

  if (await directoryHasEntries(workspacePath)) {
    const topLevelResult = await runSubprocess({
      cmd: ["git", "rev-parse", "--show-toplevel"],
      cwd: workspacePath,
      env: Bun.env,
    });
    const expectedWorkspacePath = await realpath(workspacePath);
    const resolvedTopLevelPath =
      topLevelResult.exitCode === 0 ? await realpath(topLevelResult.stdout.trim()) : null;

    if (topLevelResult.exitCode !== 0 || resolvedTopLevelPath !== expectedWorkspacePath) {
      throw new QuestDomainError({
        code: "quest_integration_failed",
        details: { path: workspacePath, runId: run.id },
        message: `Integration workspace already exists and is not reusable: ${workspacePath}`,
        statusCode: 1,
      });
    }

    const status = await readGitStatus(workspacePath);
    if (status.trim().length > 0) {
      throw new QuestDomainError({
        code: "quest_integration_failed",
        details: { path: workspacePath, runId: run.id, status },
        message: `Integration workspace is dirty and cannot be resumed: ${workspacePath}`,
        statusCode: 1,
      });
    }

    return workspacePath;
  }

  await ensureDirectory(run.workspaceRoot ?? "");
  const result = await runSubprocess({
    cmd: ["git", "worktree", "add", "--detach", workspacePath, targetRef],
    cwd: repositoryRoot,
    env: Bun.env,
  });

  if (result.exitCode !== 0) {
    throw new QuestDomainError({
      code: "quest_integration_failed",
      details: {
        path: workspacePath,
        stderr: result.stderr,
        stdout: result.stdout,
        targetRef,
      },
      message: `Failed to create integration worktree for ${workspacePath}`,
      statusCode: 1,
    });
  }

  return workspacePath;
}

async function freezeSliceResult(
  run: QuestRunDocument,
  sliceState: QuestRunSliceState,
): Promise<{
  baseRevision: string;
  noop: boolean;
  resultRevision: string;
}> {
  if (!sliceState.workspacePath) {
    throw new QuestDomainError({
      code: "quest_integration_failed",
      details: { sliceId: sliceState.sliceId },
      message: `Slice ${sliceState.sliceId} has no workspace path`,
      statusCode: 1,
    });
  }

  const baseRevision =
    sliceState.baseRevision ?? (await readHeadRevision(sliceState.workspacePath));
  sliceState.baseRevision = baseRevision;

  const aheadCount = await readAheadCount(baseRevision, sliceState.workspacePath);
  const status = await readGitStatus(sliceState.workspacePath);
  const hasWorkingTreeChanges = status.trim().length > 0;

  if (aheadCount > 1 || (aheadCount > 0 && hasWorkingTreeChanges)) {
    throw new QuestDomainError({
      code: "quest_integration_failed",
      details: {
        aheadCount,
        runId: run.id,
        sliceId: sliceState.sliceId,
      },
      message: `Slice ${sliceState.sliceId} has unsupported git history for v0 integration`,
      statusCode: 1,
    });
  }

  if (aheadCount === 0 && !hasWorkingTreeChanges) {
    const resultRevision = await readHeadRevision(sliceState.workspacePath);
    sliceState.resultRevision = resultRevision;
    return {
      baseRevision,
      noop: true,
      resultRevision,
    };
  }

  if (hasWorkingTreeChanges) {
    const addResult = await runSubprocess({
      cmd: ["git", "add", "-A"],
      cwd: sliceState.workspacePath,
      env: Bun.env,
    });

    if (addResult.exitCode !== 0) {
      throw new QuestDomainError({
        code: "quest_integration_failed",
        details: {
          runId: run.id,
          sliceId: sliceState.sliceId,
          stderr: addResult.stderr,
          stdout: addResult.stdout,
        },
        message: `Failed to stage slice ${sliceState.sliceId} before freezing integration state`,
        statusCode: 1,
      });
    }

    const commitResult = await runSubprocess({
      cmd: [
        "git",
        "commit",
        "-m",
        [
          `quest-runner: freeze ${sliceState.sliceId}`,
          "",
          `Quest-Run-Id: ${run.id}`,
          `Quest-Slice-Id: ${sliceState.sliceId}`,
          `Quest-Base-Revision: ${baseRevision}`,
        ].join("\n"),
      ],
      cwd: sliceState.workspacePath,
      env: Bun.env,
    });

    if (commitResult.exitCode !== 0) {
      throw new QuestDomainError({
        code: "quest_integration_failed",
        details: {
          runId: run.id,
          sliceId: sliceState.sliceId,
          stderr: commitResult.stderr,
          stdout: commitResult.stdout,
        },
        message: `Failed to freeze slice ${sliceState.sliceId} into a commit`,
        statusCode: 1,
      });
    }
  }

  const resultRevision = await readHeadRevision(sliceState.workspacePath);
  sliceState.resultRevision = resultRevision;
  return {
    baseRevision,
    noop: false,
    resultRevision,
  };
}

async function commitIntegrationSlice(
  run: QuestRunDocument,
  integrationWorkspacePath: string,
  sliceState: QuestRunSliceState,
  baseRevision: string,
  resultRevision: string,
  driftedFromBase: boolean,
): Promise<string> {
  const commitResult = await runSubprocess({
    cmd: [
      "git",
      "commit",
      "-m",
      [
        `quest-runner: integrate ${sliceState.sliceId}`,
        "",
        `Quest-Run-Id: ${run.id}`,
        `Quest-Slice-Id: ${sliceState.sliceId}`,
        `Quest-Base-Revision: ${baseRevision}`,
        `Quest-Result-Revision: ${resultRevision}`,
        `Quest-Drifted: ${driftedFromBase}`,
      ].join("\n"),
    ],
    cwd: integrationWorkspacePath,
    env: Bun.env,
  });

  if (commitResult.exitCode !== 0) {
    throw new QuestDomainError({
      code: "quest_integration_failed",
      details: {
        runId: run.id,
        sliceId: sliceState.sliceId,
        stderr: commitResult.stderr,
        stdout: commitResult.stdout,
      },
      message: `Failed to commit integrated slice ${sliceState.sliceId}`,
      statusCode: 1,
    });
  }

  return await readHeadRevision(integrationWorkspacePath);
}

async function integrateSlice(
  run: QuestRunDocument,
  integrationWorkspacePath: string,
  sliceState: QuestRunSliceState,
): Promise<boolean> {
  if (sliceState.integrationStatus === "integrated" || sliceState.integrationStatus === "noop") {
    return false;
  }

  const { baseRevision, noop, resultRevision } = await freezeSliceResult(run, sliceState);
  const integrationHead = await readHeadRevision(integrationWorkspacePath);
  const driftedFromBase = integrationHead !== baseRevision;
  sliceState.driftedFromBase = driftedFromBase;

  if (noop) {
    sliceState.integrationStatus = "noop";
    return false;
  }

  const cherryPickResult = await runSubprocess({
    cmd: ["git", "cherry-pick", "--no-commit", resultRevision],
    cwd: integrationWorkspacePath,
    env: Bun.env,
  });

  if (cherryPickResult.exitCode !== 0) {
    sliceState.integrationStatus = "failed";
    await runSubprocess({
      cmd: ["git", "cherry-pick", "--abort"],
      cwd: integrationWorkspacePath,
      env: Bun.env,
    });
    throw new QuestDomainError({
      code: "quest_integration_failed",
      details: {
        driftedFromBase,
        runId: run.id,
        sliceId: sliceState.sliceId,
        stderr: cherryPickResult.stderr,
        stdout: cherryPickResult.stdout,
      },
      message: `Failed to cherry-pick slice ${sliceState.sliceId} into integration workspace`,
      statusCode: 1,
    });
  }

  sliceState.integratedCommit = await commitIntegrationSlice(
    run,
    integrationWorkspacePath,
    sliceState,
    baseRevision,
    resultRevision,
    driftedFromBase,
  );
  sliceState.integrationStatus = "integrated";
  return true;
}

async function runIntegrationChecks(
  commands: string[],
  cwd: string,
): Promise<QuestRunCheckResult[]> {
  const results: QuestRunCheckResult[] = [];

  for (const command of commands) {
    const result = await $`${{ raw: command }}`.cwd(cwd).env(Bun.env).nothrow().quiet();
    results.push({
      command,
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
      stdout: result.stdout.toString(),
    });
  }

  return results;
}

function orderedSlices(run: QuestRunDocument): QuestRunSliceState[] {
  const byId = new Map(run.slices.map((slice) => [slice.sliceId, slice]));
  return run.plan.waves.flatMap((wave) =>
    wave.slices
      .map((plannedSlice) => byId.get(plannedSlice.id))
      .filter((sliceState): sliceState is QuestRunSliceState => Boolean(sliceState)),
  );
}

export class QuestRunIntegrator {
  constructor(private readonly runStore: QuestRunStore) {}

  async integrateRun(
    runId: string,
    options: { sourceRepositoryPath?: string; targetRef?: string } = {},
  ): Promise<QuestRunDocument> {
    const run = await this.runStore.getRun(runId);
    if (options.sourceRepositoryPath) {
      run.sourceRepositoryPath = options.sourceRepositoryPath;
    }

    requireIntegratableRun(run);
    if (run.events.some((event) => event.type === "run_integrated")) {
      return run;
    }

    const sourceRepositoryPath = run.sourceRepositoryPath;
    if (!sourceRepositoryPath) {
      throw new QuestDomainError({
        code: "quest_run_not_integratable",
        details: { runId: run.id },
        message: `Quest run ${run.id} has no source repository configured`,
        statusCode: 1,
      });
    }

    const repositoryRoot = await resolveGitRepositoryRoot(sourceRepositoryPath);
    const targetRef = options.targetRef ?? run.targetRef ?? "HEAD";
    await ensureGitRepositoryIsClean(repositoryRoot);

    const integrationWorkspacePath = await prepareIntegrationWorkspace(
      run,
      repositoryRoot,
      targetRef,
    );
    appendEvent(run, "run_integration_started", {
      integrationWorkspacePath,
      runId: run.id,
      sourceRepositoryPath: repositoryRoot,
      targetRef,
    });
    await this.runStore.saveRun(run);

    let appliedSliceCount = 0;
    for (const sliceState of orderedSlices(run)) {
      const applied = await integrateSlice(run, integrationWorkspacePath, sliceState);
      appendEvent(run, "slice_integrated", {
        applied,
        integrationStatus: sliceState.integrationStatus,
        sliceId: sliceState.sliceId,
      });
      await this.runStore.saveRun(run);
      if (applied) {
        appliedSliceCount += 1;
      }
    }

    if (run.spec.acceptanceChecks.length > 0) {
      appendEvent(run, "run_integration_checks_started", {
        checkCount: run.spec.acceptanceChecks.length,
        integrationWorkspacePath,
        runId: run.id,
      });

      const checkResults = await runIntegrationChecks(
        run.spec.acceptanceChecks,
        integrationWorkspacePath,
      );
      run.lastIntegrationChecks = checkResults;
      const failedCheck = checkResults.find((check) => check.exitCode !== 0);
      if (failedCheck) {
        appendEvent(run, "run_integration_checks_failed", {
          command: failedCheck.command,
          exitCode: failedCheck.exitCode,
          integrationWorkspacePath,
          runId: run.id,
        });
        await this.runStore.saveRun(run);
        throw new QuestDomainError({
          code: "quest_integration_failed",
          details: {
            command: failedCheck.command,
            integrationWorkspacePath,
            runId: run.id,
            stderr: failedCheck.stderr,
            stdout: failedCheck.stdout,
          },
          message: `Integration acceptance check failed for run ${run.id}`,
          statusCode: 1,
        });
      }

      appendEvent(run, "run_integration_checks_completed", {
        checkCount: run.spec.acceptanceChecks.length,
        integrationWorkspacePath,
        runId: run.id,
      });
      await this.runStore.saveRun(run);
    }

    appendEvent(run, "run_integrated", {
      appliedSliceCount,
      integrationWorkspacePath,
      runId: run.id,
      sourceRepositoryPath: repositoryRoot,
      targetRef,
    });

    return await this.runStore.saveRun(run);
  }
}
