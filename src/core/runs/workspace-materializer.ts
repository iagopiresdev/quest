import { lstat, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { QuestDomainError } from "../errors";
import type { QuestCommandSpec } from "../planning/spec-schema";
import { ensureDirectory } from "../storage";
import { matchesQuestPathPattern } from "./path-patterns";
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

const allowedPreparationArtifactPatterns = [
  "node_modules",
  "node_modules/**",
  ".yarn",
  ".yarn/**",
  ".pnpm-store",
  ".pnpm-store/**",
  ".pnp.cjs",
  ".pnp.loader.mjs",
  "vendor/bundle",
  "vendor/bundle/**",
] as const;

async function detectWorkspaceInstallCommands(cwd: string): Promise<QuestCommandSpec[]> {
  const hasBunLock = await pathExists(`${cwd}/bun.lock`);
  const hasPackageJson = await pathExists(`${cwd}/package.json`);
  const hasPnpmLock = await pathExists(`${cwd}/pnpm-lock.yaml`);
  const hasPackageLock = await pathExists(`${cwd}/package-lock.json`);
  const hasYarnLock = await pathExists(`${cwd}/yarn.lock`);
  const hasRequirements = await pathExists(`${cwd}/requirements.txt`);
  const commands: QuestCommandSpec[] = [];

  // Pre-install exists to make slice and boss-fight trials self-sufficient when the operator
  // prefers real dependency installs over shared source-tree node_modules links.
  if (hasBunLock && hasPackageJson) {
    commands.push({ argv: ["bun", "install", "--frozen-lockfile"], env: {} });
  } else if (hasPnpmLock && hasPackageJson) {
    commands.push({ argv: ["pnpm", "install", "--frozen-lockfile"], env: {} });
  } else if (hasPackageLock && hasPackageJson) {
    commands.push({ argv: ["npm", "ci"], env: {} });
  } else if (hasYarnLock && hasPackageJson) {
    commands.push({ argv: ["yarn", "install", "--frozen-lockfile"], env: {} });
  }

  if (hasRequirements) {
    commands.push({ argv: ["python3", "-m", "pip", "install", "-r", "requirements.txt"], env: {} });
  }

  return commands;
}

export async function runWorkspacePreInstall(
  preInstall: boolean,
  cwd: string,
  options: Parameters<typeof runWorkspacePreparationCommands>[2] = {},
): Promise<void> {
  if (!preInstall) {
    return;
  }

  const commands = await detectWorkspaceInstallCommands(cwd);
  if (commands.length === 0) {
    return;
  }

  await runWorkspacePreparationCommands(commands, cwd, options);
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
    const changedPaths = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    throw new QuestDomainError({
      code: "quest_source_repo_dirty",
      details: {
        changedPathCount: changedPaths.length,
        path: repositoryRoot,
        status: result.stdout,
      },
      message:
        `Source repository has uncommitted changes (${changedPaths.length} path(s)): ` +
        `${repositoryRoot}`,
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

export async function linkSourceDependenciesIntoWorkspace(
  repositoryRoot: string,
  workspacePath: string,
): Promise<void> {
  const sourceNodeModules = `${repositoryRoot}/node_modules`;
  const workspaceNodeModules = `${workspacePath}/node_modules`;
  if (!(await pathExists(sourceNodeModules)) || (await pathExists(workspaceNodeModules))) {
    return;
  }

  // Slice workspaces are isolated git worktrees, so dependency access must be linked explicitly
  // when we want trials to validate real package imports instead of only file existence.
  await symlink(sourceNodeModules, workspaceNodeModules, "junction");
}

async function buildWorkspaceManifest(cwd: string): Promise<string> {
  const rootFiles = [
    "package.json",
    "tsconfig.json",
    "tsconfig.base.json",
    "biome.json",
    "eslint.config.js",
    "eslint.config.mjs",
    "bun.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "README.md",
    "AGENTS.md",
  ];
  const presentRootFiles = (
    await Promise.all(
      rootFiles.map(async (file) => ({
        exists: await pathExists(`${cwd}/${file}`),
        file,
      })),
    )
  )
    .filter((entry) => entry.exists)
    .map((entry) => entry.file);

  let packageSummary = "package.json not present";
  if (await pathExists(`${cwd}/package.json`)) {
    try {
      const packageJson = JSON.parse(await readFile(`${cwd}/package.json`, "utf8")) as {
        name?: string;
        packageManager?: string;
        scripts?: Record<string, string>;
      };
      const scriptNames = Object.keys(packageJson.scripts ?? {}).slice(0, 12);
      packageSummary = [
        `name: ${packageJson.name ?? "unknown"}`,
        `packageManager: ${packageJson.packageManager ?? "unspecified"}`,
        `scripts: ${scriptNames.length > 0 ? scriptNames.join(", ") : "none"}`,
      ].join(" | ");
    } catch {
      packageSummary = "package.json present but could not be summarized";
    }
  }

  return [
    "# Workspace Manifest",
    "",
    "Use this manifest as the fast path for repo conventions before exploring ad hoc files.",
    "",
    `Root files present: ${presentRootFiles.length > 0 ? presentRootFiles.join(", ") : "none"}`,
    `Package summary: ${packageSummary}`,
    `Dependencies linked: ${(await pathExists(`${cwd}/node_modules`)) ? "yes" : "no"}`,
    "",
    "Only trust files that are present in this workspace. Do not assume RTK.md, AGENTS.md, or",
    "other convention files exist unless the manifest or filesystem shows them.",
    "",
  ].join("\n");
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
  await writeFile(
    `${questStateDir}/workspace-manifest.md`,
    await buildWorkspaceManifest(cwd),
    "utf8",
  );
}

export async function refreshWorkspaceManifest(cwd: string): Promise<void> {
  const questStateDir = `${cwd}/.quest-runner`;
  await ensureDirectory(questStateDir);
  await writeFile(
    `${questStateDir}/workspace-manifest.md`,
    await buildWorkspaceManifest(cwd),
    "utf8",
  );
}

export async function runWorkspacePreparationCommands(
  commands: QuestCommandSpec[] | undefined,
  cwd: string,
  options: {
    idleTimeoutMs?: number | undefined;
    onExit?: ((pid: number) => Promise<void> | void) | undefined;
    onSpawn?: ((command: string[], pid: number) => Promise<void> | void) | undefined;
    timeoutMs?: number | undefined;
  } = {},
): Promise<void> {
  for (const command of commands ?? []) {
    const result = await runSubprocess({
      cmd: command.argv,
      cwd,
      env: buildProcessEnv(command.env),
      idleTimeoutMs: options.idleTimeoutMs,
      onExit: options.onExit,
      onSpawn: (pid) => options.onSpawn?.(command.argv, pid),
      timeoutMs: options.timeoutMs,
    });

    if (result.exitCode === 0) {
      continue;
    }

    throw new QuestDomainError({
      code: "quest_workspace_prepare_failed",
      details: {
        command,
        cwd,
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        timedOut: result.timedOut,
      },
      message: `Workspace preparation command failed in ${cwd}: ${command.argv.join(" ")}`,
      statusCode: 1,
    });
  }

  const gitProbe = await runSubprocess({
    cmd: ["git", "rev-parse", "--is-inside-work-tree"],
    cwd,
    env: buildProcessEnv(),
    idleTimeoutMs: options.idleTimeoutMs,
    timeoutMs: options.timeoutMs,
  });
  if (gitProbe.exitCode !== 0) {
    return;
  }

  const trackedChanges = await runSubprocess({
    cmd: ["git", "ls-files", "-m", "-d"],
    cwd,
    env: buildProcessEnv(),
    idleTimeoutMs: options.idleTimeoutMs,
    timeoutMs: options.timeoutMs,
  });
  if (trackedChanges.exitCode !== 0) {
    throw new QuestDomainError({
      code: "quest_workspace_prepare_failed",
      details: {
        cwd,
        stderr: trackedChanges.stderr,
        stdout: trackedChanges.stdout,
      },
      message: `Failed to inspect tracked changes after workspace preparation in ${cwd}`,
      statusCode: 1,
    });
  }

  const unsafeTrackedPaths = trackedChanges.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => !matchesQuestPathPattern(entry, [...allowedPreparationArtifactPatterns]));

  if (unsafeTrackedPaths.length > 0) {
    throw new QuestDomainError({
      code: "quest_workspace_prepare_failed",
      details: {
        cwd,
        unsafeTrackedPaths,
      },
      message: `Workspace preparation modified tracked files outside dependency artifact paths in ${cwd}`,
      statusCode: 1,
    });
  }
}

export function isAllowedPreparationArtifactPath(relativePath: string): boolean {
  return matchesQuestPathPattern(relativePath, [...allowedPreparationArtifactPatterns]);
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
  options: {
    idleTimeoutMs?: number | undefined;
    onExit?: ((pid: number) => Promise<void> | void) | undefined;
    onSpawn?: ((command: string[], pid: number) => Promise<void> | void) | undefined;
    timeoutMs?: number | undefined;
  } = {},
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
    const repositoryRoot = await resolveGitRepositoryRoot(run.sourceRepositoryPath);
    await materializeGitWorktree(repositoryRoot, cwd);
    if (run.spec.execution.shareSourceDependencies && !run.spec.execution.preInstall) {
      await linkSourceDependenciesIntoWorkspace(repositoryRoot, cwd);
    }
    baseRevision = await readHeadRevision(cwd);
  } else {
    await ensureDirectory(cwd);
  }

  await writeQuestContext(run, sliceState, cwd);
  await runWorkspacePreInstall(run.spec.execution.preInstall, cwd, options);
  await runWorkspacePreparationCommands(run.spec.execution.prepareCommands, cwd, options);
  await refreshWorkspaceManifest(cwd);
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
