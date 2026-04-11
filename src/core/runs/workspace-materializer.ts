import { readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { QuestDomainError } from "../errors";
import { ensureDirectory } from "../storage";
import { runSubprocess } from "./process";
import { buildProcessEnv } from "./process-env";
import type { QuestRunDocument, QuestRunSliceState } from "./schema";
import {
  assertWorkspacePathWithinRoot,
  resolveIntegrationWorkspacePathForRunRoot,
} from "./workspace-layout";

async function directoryHasEntries(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.length > 0;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw new QuestDomainError({
      code: "quest_workspace_materialization_failed",
      details: {
        path,
        reason: error instanceof Error ? error.message : String(error),
      },
      message: `Failed to inspect workspace directory ${path}`,
      statusCode: 1,
    });
  }
}

export async function resolveGitRepositoryRoot(sourceRepositoryPath: string): Promise<string> {
  const resolvedSourcePath = resolve(sourceRepositoryPath);
  const result = await runSubprocess({
    cmd: ["git", "rev-parse", "--show-toplevel"],
    cwd: resolvedSourcePath,
    env: buildProcessEnv(),
  });

  if (result.exitCode !== 0) {
    throw new QuestDomainError({
      code: "quest_source_repo_invalid",
      details: {
        path: resolvedSourcePath,
        stderr: result.stderr,
        stdout: result.stdout,
      },
      message: `Source repository is not a valid git checkout: ${resolvedSourcePath}`,
      statusCode: 1,
    });
  }

  return result.stdout.trim();
}

export async function ensureGitRepositoryIsClean(repositoryRoot: string): Promise<void> {
  const result = await runSubprocess({
    cmd: ["git", "status", "--porcelain"],
    cwd: repositoryRoot,
    env: buildProcessEnv(),
  });

  if (result.exitCode !== 0) {
    throw new QuestDomainError({
      code: "quest_workspace_materialization_failed",
      details: {
        path: repositoryRoot,
        stderr: result.stderr,
        stdout: result.stdout,
      },
      message: `Failed to inspect source repository status for ${repositoryRoot}`,
      statusCode: 1,
    });
  }

  if (result.stdout.trim().length > 0) {
    throw new QuestDomainError({
      code: "quest_source_repo_dirty",
      details: {
        path: repositoryRoot,
        status: result.stdout,
      },
      message: `Source repository has uncommitted changes: ${repositoryRoot}`,
      statusCode: 1,
    });
  }
}

async function materializeGitWorktree(
  sourceRepositoryPath: string,
  workspacePath: string,
): Promise<void> {
  const repositoryRoot = await resolveGitRepositoryRoot(sourceRepositoryPath);
  await ensureGitRepositoryIsClean(repositoryRoot);
  await ensureDirectory(dirname(workspacePath));

  if (await directoryHasEntries(workspacePath)) {
    throw new QuestDomainError({
      code: "quest_workspace_materialization_failed",
      details: {
        path: workspacePath,
      },
      message: `Workspace path is not empty: ${workspacePath}`,
      statusCode: 1,
    });
  }

  const result = await runSubprocess({
    cmd: ["git", "worktree", "add", "--detach", workspacePath, "HEAD"],
    cwd: repositoryRoot,
    env: buildProcessEnv(),
  });

  if (result.exitCode !== 0) {
    throw new QuestDomainError({
      code: "quest_workspace_materialization_failed",
      details: {
        path: workspacePath,
        sourceRepositoryPath: repositoryRoot,
        stderr: result.stderr,
        stdout: result.stdout,
      },
      message: `Failed to materialize git worktree for ${workspacePath}`,
      statusCode: 1,
    });
  }
}

async function writeQuestContext(
  run: QuestRunDocument,
  sliceState: QuestRunSliceState,
  cwd: string,
): Promise<void> {
  const questStateDir = `${cwd}/.quest-runner`;
  await ensureDirectory(questStateDir);
  await writeFile(
    `${questStateDir}/context.json`,
    `${JSON.stringify(
      {
        cwd,
        runId: run.id,
        sliceId: sliceState.sliceId,
        status: sliceState.status,
        title: sliceState.title,
        wave: sliceState.wave,
        workspaceRoot: run.workspaceRoot,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function readHeadRevision(cwd: string): Promise<string> {
  const result = await runSubprocess({
    cmd: ["git", "rev-parse", "HEAD"],
    cwd,
    env: buildProcessEnv(),
  });

  if (result.exitCode !== 0) {
    throw new QuestDomainError({
      code: "quest_workspace_materialization_failed",
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

export async function prepareExecutionWorkspace(
  run: QuestRunDocument,
  sliceState: QuestRunSliceState,
  cwd: string,
): Promise<{ baseRevision?: string | undefined }> {
  const workspaceRoot = run.workspaceRoot;
  if (!workspaceRoot) {
    throw new QuestDomainError({
      code: "quest_workspace_materialization_failed",
      details: { runId: run.id, sliceId: sliceState.sliceId },
      message: `Quest run ${run.id} is missing a workspace root`,
      statusCode: 1,
    });
  }

  await assertWorkspacePathWithinRoot(workspaceRoot, cwd, `Slice workspace ${sliceState.sliceId}`);

  let baseRevision: string | undefined;
  if (run.sourceRepositoryPath) {
    await materializeGitWorktree(run.sourceRepositoryPath, cwd);
    baseRevision = await readHeadRevision(cwd);
  } else {
    await ensureDirectory(cwd);
  }

  await writeQuestContext(run, sliceState, cwd);
  return { baseRevision };
}

export async function cleanupExecutionWorkspaces(run: QuestRunDocument): Promise<void> {
  const workspaceRoot = run.workspaceRoot;
  if (!workspaceRoot) {
    return;
  }

  const workspacePaths = run.slices
    .map((slice) => slice.workspacePath)
    .filter((workspacePath): workspacePath is string => Boolean(workspacePath));
  if (run.integrationWorkspacePath) {
    workspacePaths.push(run.integrationWorkspacePath);
  }

  if (run.sourceRepositoryPath) {
    const repositoryRoot = await resolveGitRepositoryRoot(run.sourceRepositoryPath);

    for (const workspacePath of workspacePaths) {
      const confinedWorkspacePath = await assertWorkspacePathWithinRoot(
        workspaceRoot,
        workspacePath,
        "Workspace path",
      );

      if (!(await directoryHasEntries(confinedWorkspacePath))) {
        continue;
      }

      const result = await runSubprocess({
        cmd: ["git", "worktree", "remove", "--force", confinedWorkspacePath],
        cwd: repositoryRoot,
        env: buildProcessEnv(),
      });

      if (result.exitCode !== 0) {
        throw new QuestDomainError({
          code: "quest_workspace_materialization_failed",
          details: {
            path: confinedWorkspacePath,
            sourceRepositoryPath: repositoryRoot,
            stderr: result.stderr,
            stdout: result.stdout,
          },
          message: `Failed to remove git worktree for ${confinedWorkspacePath}`,
          statusCode: 1,
        });
      }
    }
  }

  await assertWorkspacePathWithinRoot(workspaceRoot, workspaceRoot, "Workspace root");

  const integrationWorkspacePath =
    run.integrationWorkspacePath ?? resolveIntegrationWorkspacePathForRunRoot(workspaceRoot);
  await assertWorkspacePathWithinRoot(
    workspaceRoot,
    integrationWorkspacePath,
    "Integration workspace",
  );

  try {
    await rm(workspaceRoot, { force: true, recursive: true });
  } catch (error: unknown) {
    throw new QuestDomainError({
      code: "quest_workspace_materialization_failed",
      details: {
        path: workspaceRoot,
        reason: error instanceof Error ? error.message : String(error),
      },
      message: `Failed to remove workspace root ${workspaceRoot}`,
      statusCode: 1,
    });
  }
}
