import { readdir, realpath } from "node:fs/promises";
import { writeRunChronicle } from "../chronicles/generator";
import { QuestDomainError } from "../errors";
import type { QuestCommandSpec } from "../planning/spec-schema";
import { ensureDirectory } from "../storage";
import { appendEvent } from "./lifecycle";
import { matchesQuestPathPattern } from "./path-patterns";
import { runSubprocess } from "./process";
import { buildProcessEnv } from "./process-env";
import type {
  QuestRunActiveProcess,
  QuestRunCheckResult,
  QuestRunDocument,
  QuestRunSliceState,
} from "./schema";
import type { QuestRunStore } from "./store";
import {
  assertWorkspacePathWithinRoot,
  resolveIntegrationWorkspacePathForRunRoot,
} from "./workspace-layout";
import {
  ensureGitRepositoryIsClean,
  isAllowedPreparationArtifactPath,
  linkSourceDependenciesIntoWorkspace,
  resolveGitRepositoryRoot,
  runWorkspacePreInstall,
  runWorkspacePreparationCommands,
} from "./workspace-materializer";

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

function buildTrackedProcess(
  command: string[],
  options: {
    kind: QuestRunActiveProcess["kind"];
    pid: number;
    sliceId?: string | undefined;
  },
): QuestRunActiveProcess {
  return {
    command: command
      .slice(0, 32)
      .map((part) => (part.length <= 240 ? part : `${part.slice(0, 237)}...`)),
    kind: options.kind,
    pid: options.pid,
    sliceId: options.sliceId,
    startedAt: new Date().toISOString(),
  };
}

function buildSafeGitCommand(args: string[]): string[] {
  return ["git", "-c", "core.hooksPath=/dev/null", ...args];
}

function clearExecutionStateOnRun(run: QuestRunDocument): void {
  run.activeProcesses = [];
  delete run.executionHeartbeatAt;
  delete run.executionHostPid;
  delete run.executionStage;
}

function createTrackedProcessHooks(
  runStore: QuestRunStore,
  runId: string,
  descriptor: { kind: QuestRunActiveProcess["kind"]; sliceId?: string | undefined },
): {
  onExit: (pid: number) => Promise<void>;
  onSpawn: (command: string[], pid: number) => Promise<void>;
} {
  return {
    onExit: async (pid) => {
      await runStore.clearActiveProcess(runId, pid);
    },
    onSpawn: async (command, pid) => {
      await runStore.registerActiveProcess(
        runId,
        buildTrackedProcess(command, { ...descriptor, pid }),
      );
    },
  };
}

async function readHeadRevision(cwd: string): Promise<string> {
  const result = await runSubprocess({
    cmd: ["git", "rev-parse", "HEAD"],
    cwd,
    env: buildProcessEnv(),
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

async function readRevisionForRef(cwd: string, ref: string): Promise<string> {
  const result = await runSubprocess({
    cmd: ["git", "rev-parse", ref],
    cwd,
    env: buildProcessEnv(),
  });

  if (result.exitCode !== 0) {
    throw new QuestDomainError({
      code: "quest_integration_failed",
      details: {
        cwd,
        ref,
        stderr: result.stderr,
        stdout: result.stdout,
      },
      message: `Failed to resolve git ref ${ref} for ${cwd}`,
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
    env: buildProcessEnv(),
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
    env: buildProcessEnv(),
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

async function listChangedWorkspacePaths(cwd: string): Promise<string[]> {
  const result = await runSubprocess({
    cmd: ["git", "ls-files", "-m", "-d", "-o", "--exclude-standard"],
    cwd,
    env: buildProcessEnv(),
  });

  if (result.exitCode !== 0) {
    throw new QuestDomainError({
      code: "quest_integration_failed",
      details: {
        cwd,
        stderr: result.stderr,
        stdout: result.stdout,
      },
      message: `Failed to inspect changed paths for ${cwd}`,
      statusCode: 1,
    });
  }

  return result.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isQuestManagedArtifactPath(path: string): boolean {
  return (
    path === ".openclaw" ||
    path.startsWith(".openclaw/") ||
    path === ".quest" ||
    path.startsWith(".quest/") ||
    [
      "AGENTS.md",
      "BOOTSTRAP.md",
      "HEARTBEAT.md",
      "IDENTITY.md",
      "SOUL.md",
      "TOOLS.md",
      "USER.md",
    ].includes(path)
  );
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
  const workspaceRoot = run.workspaceRoot;
  if (!workspaceRoot) {
    throw new QuestDomainError({
      code: "quest_integration_failed",
      details: { runId: run.id },
      message: `Quest run ${run.id} has no workspace root`,
      statusCode: 1,
    });
  }

  const targetBaseRevision = await readRevisionForRef(repositoryRoot, targetRef);
  const workspacePath =
    run.integrationWorkspacePath ?? resolveIntegrationWorkspacePathForRunRoot(workspaceRoot);
  run.integrationWorkspacePath = workspacePath;
  await assertWorkspacePathWithinRoot(workspaceRoot, workspacePath, "Integration workspace");

  if (await directoryHasEntries(workspacePath)) {
    // Resume is only safe when we can prove we're continuing against the same target intent and
    // the same base revision. Reusing a clean but differently-targeted worktree is still wrong.
    if (run.targetRef && run.targetRef !== targetRef) {
      throw new QuestDomainError({
        code: "quest_integration_failed",
        details: { previousTargetRef: run.targetRef, runId: run.id, targetRef },
        message: `Quest run ${run.id} cannot resume integration against a different target ref`,
        statusCode: 1,
      });
    }

    if (run.integrationBaseRevision && run.integrationBaseRevision !== targetBaseRevision) {
      throw new QuestDomainError({
        code: "quest_integration_failed",
        details: {
          expectedBaseRevision: run.integrationBaseRevision,
          runId: run.id,
          targetBaseRevision,
          targetRef,
        },
        message: `Quest run ${run.id} cannot resume integration against a different target revision`,
        statusCode: 1,
      });
    }

    const topLevelResult = await runSubprocess({
      cmd: ["git", "rev-parse", "--show-toplevel"],
      cwd: workspacePath,
      env: buildProcessEnv(),
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

    if (run.spec.execution.shareSourceDependencies && !run.spec.execution.preInstall) {
      await linkSourceDependenciesIntoWorkspace(repositoryRoot, workspacePath);
    }
    return workspacePath;
  }

  await ensureDirectory(workspaceRoot);
  const result = await runSubprocess({
    cmd: ["git", "worktree", "add", "--detach", workspacePath, targetRef],
    cwd: repositoryRoot,
    env: buildProcessEnv(),
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

  run.targetRef = targetRef;
  run.integrationBaseRevision = targetBaseRevision;
  if (run.spec.execution.shareSourceDependencies && !run.spec.execution.preInstall) {
    await linkSourceDependenciesIntoWorkspace(repositoryRoot, workspacePath);
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

  if (run.workspaceRoot) {
    await assertWorkspacePathWithinRoot(
      run.workspaceRoot,
      sliceState.workspacePath,
      `Slice workspace ${sliceState.sliceId}`,
    );
  }

  const baseRevision =
    sliceState.baseRevision ?? (await readHeadRevision(sliceState.workspacePath));
  sliceState.baseRevision = baseRevision;

  const aheadCount = await readAheadCount(baseRevision, sliceState.workspacePath);
  const changedPaths = await listChangedWorkspacePaths(sliceState.workspacePath);
  const hasMeaningfulWorkingTreeChanges = changedPaths.some(
    (path) => !isQuestManagedArtifactPath(path),
  );

  if (aheadCount > 1 || (aheadCount > 0 && hasMeaningfulWorkingTreeChanges)) {
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

  if (aheadCount === 0 && !hasMeaningfulWorkingTreeChanges) {
    const resultRevision = await readHeadRevision(sliceState.workspacePath);
    sliceState.resultRevision = resultRevision;
    return {
      baseRevision,
      noop: true,
      resultRevision,
    };
  }

  if (hasMeaningfulWorkingTreeChanges) {
    const specSlice = run.spec.slices.find((slice) => slice.id === sliceState.sliceId);
    if (!specSlice) {
      throw new QuestDomainError({
        code: "quest_integration_failed",
        details: { runId: run.id, sliceId: sliceState.sliceId },
        message: `Quest run ${run.id} is missing spec for slice ${sliceState.sliceId}`,
        statusCode: 1,
      });
    }

    const illegalPaths = changedPaths.filter(
      (path) =>
        !isQuestManagedArtifactPath(path) &&
        !matchesQuestPathPattern(path, specSlice.owns) &&
        !isAllowedPreparationArtifactPath(path),
    );
    if (illegalPaths.length > 0) {
      throw new QuestDomainError({
        code: "quest_integration_failed",
        details: {
          illegalPaths,
          runId: run.id,
          sliceId: sliceState.sliceId,
        },
        message: `Slice ${sliceState.sliceId} modified files outside its owned paths`,
        statusCode: 1,
      });
    }

    const stageablePaths = changedPaths.filter((path) =>
      matchesQuestPathPattern(path, specSlice.owns),
    );
    if (stageablePaths.length === 0) {
      const resultRevision = await readHeadRevision(sliceState.workspacePath);
      sliceState.resultRevision = resultRevision;
      return {
        baseRevision,
        noop: true,
        resultRevision,
      };
    }

    const addResult = await runSubprocess({
      cmd: buildSafeGitCommand(["add", "-A", "--", ...stageablePaths]),
      cwd: sliceState.workspacePath,
      env: buildProcessEnv(),
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
      cmd: buildSafeGitCommand([
        "commit",
        "--no-verify",
        "-m",
        [
          `quest: freeze ${sliceState.sliceId}`,
          "",
          `Quest-Run-Id: ${run.id}`,
          `Quest-Slice-Id: ${sliceState.sliceId}`,
          `Quest-Base-Revision: ${baseRevision}`,
        ].join("\n"),
      ]),
      cwd: sliceState.workspacePath,
      env: buildProcessEnv(),
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
    cmd: buildSafeGitCommand([
      "commit",
      "--no-verify",
      "-m",
      [
        `quest: integrate ${sliceState.sliceId}`,
        "",
        `Quest-Run-Id: ${run.id}`,
        `Quest-Slice-Id: ${sliceState.sliceId}`,
        `Quest-Base-Revision: ${baseRevision}`,
        `Quest-Result-Revision: ${resultRevision}`,
        `Quest-Drifted: ${driftedFromBase}`,
      ].join("\n"),
    ]),
    cwd: integrationWorkspacePath,
    env: buildProcessEnv(),
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
    cmd: buildSafeGitCommand(["cherry-pick", "--no-commit", resultRevision]),
    cwd: integrationWorkspacePath,
    env: buildProcessEnv(),
  });

  if (cherryPickResult.exitCode !== 0) {
    sliceState.integrationStatus = "failed";
    await runSubprocess({
      cmd: ["git", "cherry-pick", "--abort"],
      cwd: integrationWorkspacePath,
      env: buildProcessEnv(),
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
  commands: QuestCommandSpec[],
  cwd: string,
  options: {
    idleTimeoutMs?: number | undefined;
    onExit?: ((pid: number) => Promise<void> | void) | undefined;
    onSpawn?: ((command: string[], pid: number) => Promise<void> | void) | undefined;
    timeoutMs?: number | undefined;
  } = {},
): Promise<QuestRunCheckResult[]> {
  const results: QuestRunCheckResult[] = [];

  for (const command of commands) {
    const result = await runSubprocess({
      cmd: command.argv,
      cwd,
      env: buildProcessEnv(command.env),
      idleTimeoutMs: options.idleTimeoutMs,
      onExit: options.onExit,
      onSpawn: (pid) => options.onSpawn?.(command.argv, pid),
      timeoutMs: options.timeoutMs,
    });
    results.push({
      command,
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
    });
  }

  return results;
}

async function maybeRunIntegrationChecks(
  run: QuestRunDocument,
  integrationWorkspacePath: string,
  options: {
    idleTimeoutMs?: number | undefined;
    runStore: QuestRunStore;
    timeoutMs?: number | undefined;
  },
): Promise<void> {
  if (run.spec.acceptanceChecks.length === 0) {
    return;
  }

  await runWorkspacePreInstall(run.spec.execution.preInstall, integrationWorkspacePath, {
    idleTimeoutMs: options.idleTimeoutMs,
    ...createTrackedProcessHooks(options.runStore, run.id, { kind: "prepare" }),
    timeoutMs: options.timeoutMs,
  });
  await runWorkspacePreparationCommands(
    run.spec.execution.prepareCommands,
    integrationWorkspacePath,
    {
      idleTimeoutMs: options.idleTimeoutMs,
      ...createTrackedProcessHooks(options.runStore, run.id, { kind: "prepare" }),
      timeoutMs: options.timeoutMs,
    },
  );
  appendEvent(run, "run_integration_checks_started", {
    checkCount: run.spec.acceptanceChecks.length,
    integrationWorkspacePath,
    runId: run.id,
  });

  const checkResults = await runIntegrationChecks(
    run.spec.acceptanceChecks,
    integrationWorkspacePath,
    {
      idleTimeoutMs: options.idleTimeoutMs,
      ...createTrackedProcessHooks(options.runStore, run.id, { kind: "integration" }),
      timeoutMs: options.timeoutMs,
    },
  );
  run.lastIntegrationChecks = checkResults;
  const failedCheck = checkResults.find((check) => check.exitCode !== 0);
  if (failedCheck) {
    run.integrationRescueStatus = "pending";
    appendEvent(run, "run_integration_checks_failed", {
      command: failedCheck.command,
      exitCode: failedCheck.exitCode,
      integrationWorkspacePath,
      runId: run.id,
    });
    appendEvent(run, "run_integration_failed", {
      phase: "integration_checks",
      runId: run.id,
    });
    // The cleanup/repair path depends on this failure being durable even when integration exits
    // through the error path and the finally block clears execution bookkeeping from a fresh reload.
    await options.runStore.saveRun(run);
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
    options: { sourceRepositoryPath?: string | undefined; targetRef?: string | undefined } = {},
  ): Promise<QuestRunDocument> {
    const run = await this.runStore.getRun(runId);
    if (options.sourceRepositoryPath) {
      run.sourceRepositoryPath = options.sourceRepositoryPath;
    }

    requireIntegratableRun(run);
    if (
      run.events.some((event) => event.type === "run_integrated") &&
      run.integrationWorkspacePath &&
      run.integrationBaseRevision &&
      run.slices.every(
        (sliceState) =>
          sliceState.integrationStatus === "integrated" || sliceState.integrationStatus === "noop",
      )
    ) {
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
    const timeoutMs = run.spec.execution.timeoutMinutes * 60 * 1000;
    const idleTimeoutMs = run.spec.execution.idleTimeoutMinutes
      ? run.spec.execution.idleTimeoutMinutes * 60 * 1000
      : undefined;
    await ensureGitRepositoryIsClean(repositoryRoot);
    await this.runStore.markRunExecutionHost(run.id, "integrate");

    try {
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
        let applied: boolean;
        try {
          applied = await integrateSlice(run, integrationWorkspacePath, sliceState);
        } catch (error: unknown) {
          run.integrationRescueStatus = "pending";
          appendEvent(run, "run_integration_failed", {
            phase: "integrate",
            runId: run.id,
            sliceId: sliceState.sliceId,
          });
          await this.runStore.saveRun(run);
          throw error;
        }
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

      await maybeRunIntegrationChecks(run, integrationWorkspacePath, {
        idleTimeoutMs,
        runStore: this.runStore,
        timeoutMs,
      });
      await this.runStore.saveRun(run);

      appendEvent(run, "run_integrated", {
        appliedSliceCount,
        integrationWorkspacePath,
        runId: run.id,
        sourceRepositoryPath: repositoryRoot,
        targetRef,
      });
      run.integrationRescueStatus = "unset";

      if (run.spec.featureDoc.enabled) {
        const featureDocPath = await writeRunChronicle(run);
        run.featureDocGeneratedAt = new Date().toISOString();
        run.featureDocPath = featureDocPath;
        appendEvent(run, "run_feature_doc_written", {
          featureDocPath,
          runId: run.id,
        });
      }

      return await this.runStore.saveRun(run);
    } finally {
      clearExecutionStateOnRun(run);
      await this.runStore.clearRunExecutionState(run.id);
    }
  }
}
