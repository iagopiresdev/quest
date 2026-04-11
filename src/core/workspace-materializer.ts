import { readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { QuestDomainError } from "./errors";
import { runSubprocess } from "./process";
import type { QuestRunDocument, QuestRunSliceState } from "./run-schema";
import { ensureDirectory } from "./storage";

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

async function resolveGitRepositoryRoot(sourceRepositoryPath: string): Promise<string> {
  const resolvedSourcePath = resolve(sourceRepositoryPath);
  const result = await runSubprocess({
    cmd: ["git", "rev-parse", "--show-toplevel"],
    cwd: resolvedSourcePath,
    env: Bun.env,
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

async function ensureGitRepositoryIsClean(repositoryRoot: string): Promise<void> {
  const result = await runSubprocess({
    cmd: ["git", "status", "--porcelain"],
    cwd: repositoryRoot,
    env: Bun.env,
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
    env: Bun.env,
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

export async function prepareExecutionWorkspace(
  run: QuestRunDocument,
  sliceState: QuestRunSliceState,
  cwd: string,
): Promise<void> {
  if (run.sourceRepositoryPath) {
    await materializeGitWorktree(run.sourceRepositoryPath, cwd);
  } else {
    await ensureDirectory(cwd);
  }

  await writeQuestContext(run, sliceState, cwd);
}
