import { resolve } from "node:path";
import { QuestDomainError } from "../errors";
import type { QuestCommandSpec } from "../planning/spec-schema";
import { SecretStore } from "../secret-store";
import { ensureDirectory } from "../storage";
import type { WorkerRegistry } from "../workers/registry";
import type { RegisteredWorker } from "../workers/schema";
import { appendEvent, nowIsoString, setRunStatus, setSliceStatus } from "./lifecycle";
import { runSubprocess } from "./process";
import { buildProcessEnv } from "./process-env";
import {
  CodexCliRunnerAdapter,
  DryRunRunnerAdapter,
  HermesApiRunnerAdapter,
  LocalCommandRunnerAdapter,
  RunnerRegistry,
} from "./runner";
import type { QuestRunCheckResult, QuestRunDocument, QuestRunSliceState } from "./schema";
import type { QuestRunStore } from "./store";
import { prepareExecutionWorkspace } from "./workspace-materializer";

function requireExecutableRun(run: QuestRunDocument): void {
  if (run.status === "blocked") {
    throw new QuestDomainError({
      code: "quest_run_not_executable",
      details: { runId: run.id, status: run.status },
      message: `Quest run ${run.id} is blocked and cannot be executed`,
      statusCode: 1,
    });
  }

  if (run.status === "completed") {
    throw new QuestDomainError({
      code: "quest_run_not_executable",
      details: { runId: run.id, status: run.status },
      message: `Quest run ${run.id} is already completed`,
      statusCode: 1,
    });
  }

  if (run.status === "aborted") {
    throw new QuestDomainError({
      code: "quest_run_not_executable",
      details: { runId: run.id, status: run.status },
      message: `Quest run ${run.id} is aborted and cannot be executed`,
      statusCode: 1,
    });
  }

  if (run.status === "failed") {
    throw new QuestDomainError({
      code: "quest_run_not_rerunnable",
      details: { runId: run.id, status: run.status },
      message: `Quest run ${run.id} failed and must be recreated with quest runs rerun`,
      statusCode: 1,
    });
  }
}

function findSliceState(run: QuestRunDocument, sliceId: string): QuestRunSliceState {
  const sliceState = run.slices.find((slice) => slice.sliceId === sliceId);
  if (!sliceState) {
    throw new QuestDomainError({
      code: "invalid_quest_run",
      details: { runId: run.id, sliceId },
      message: `Quest run ${run.id} is missing state for slice ${sliceId}`,
      statusCode: 1,
    });
  }

  return sliceState;
}

function resolveExecutionCwd(
  run: QuestRunDocument,
  sliceState: QuestRunSliceState,
  worker: RegisteredWorker,
): string {
  return (
    sliceState.workspacePath ??
    run.workspaceRoot ??
    worker.backend.workingDirectory ??
    Bun.env.PWD ??
    "."
  );
}

async function runAcceptanceChecks(
  commands: QuestCommandSpec[],
  cwd: string,
): Promise<QuestRunCheckResult[]> {
  const results: QuestRunCheckResult[] = [];

  for (const command of commands) {
    const result = await runSubprocess({
      cmd: command.argv,
      cwd,
      env: buildProcessEnv(command.env),
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

type WaveExecutionSuccess = {
  result: {
    exitCode: number;
    stderr: string;
    stdout: string;
    summary: string;
  };
  sliceState: QuestRunSliceState;
};

type WaveExecutionFailure = {
  error: unknown;
  sliceState: QuestRunSliceState;
};

export class QuestRunExecutor {
  private readonly runnerRegistry: RunnerRegistry;

  constructor(
    private readonly runStore: QuestRunStore,
    private readonly workerRegistry: WorkerRegistry,
    secretStore: SecretStore = new SecretStore(),
  ) {
    this.runnerRegistry = new RunnerRegistry([
      new DryRunRunnerAdapter(),
      new LocalCommandRunnerAdapter(),
      new CodexCliRunnerAdapter(secretStore),
      new HermesApiRunnerAdapter(secretStore),
    ]);
  }

  async executeRun(
    runId: string,
    options: { dryRun?: boolean | undefined; sourceRepositoryPath?: string | undefined } = {},
  ): Promise<QuestRunDocument> {
    const run = await this.runStore.getRun(runId);
    requireExecutableRun(run);

    if (options.sourceRepositoryPath) {
      run.sourceRepositoryPath = resolve(options.sourceRepositoryPath);
    }

    const workers = await this.workerRegistry.listWorkers();
    const workerMap = new Map(workers.map((worker) => [worker.id, worker]));
    const specSliceMap = new Map(run.spec.slices.map((slice) => [slice.id, slice]));
    const startedAt = nowIsoString();
    const runWorkspaceRoot = run.workspaceRoot ?? Bun.env.PWD ?? ".";

    await ensureDirectory(runWorkspaceRoot);
    setRunStatus(run, "running");
    appendEvent(run, "run_started", { dryRun: options.dryRun === true }, startedAt);
    await this.runStore.saveRun(run);

    try {
      for (const wave of run.plan.waves) {
        const waveSliceStates = wave.slices
          .map((plannedSlice) => findSliceState(run, plannedSlice.id))
          .filter((sliceState) => sliceState.status !== "completed");

        if (waveSliceStates.length === 0) {
          continue;
        }

        waveSliceStates.forEach((sliceState) => {
          const eventAt = nowIsoString();
          setSliceStatus(sliceState, "running", { startedAt: eventAt });
          appendEvent(
            run,
            "slice_started",
            {
              sliceId: sliceState.sliceId,
              wave: sliceState.wave,
              workerId: sliceState.assignedWorkerId,
            },
            eventAt,
          );
        });
        await this.runStore.saveRun(run);

        const results = await Promise.allSettled(
          waveSliceStates.map(async (sliceState) => {
            const workerId = sliceState.assignedWorkerId;
            if (!workerId) {
              throw new QuestDomainError({
                code: "invalid_quest_run",
                details: { runId: run.id, sliceId: sliceState.sliceId },
                message: `Slice ${sliceState.sliceId} has no assigned worker`,
                statusCode: 1,
              });
            }

            const worker = workerMap.get(workerId);
            if (!worker) {
              throw new QuestDomainError({
                code: "quest_worker_not_found",
                details: { runId: run.id, sliceId: sliceState.sliceId, workerId },
                message: `Assigned worker ${workerId} is not registered`,
                statusCode: 1,
              });
            }

            const slice = specSliceMap.get(sliceState.sliceId);
            if (!slice) {
              throw new QuestDomainError({
                code: "invalid_quest_run",
                details: { runId: run.id, sliceId: sliceState.sliceId },
                message: `Quest run ${run.id} is missing spec for slice ${sliceState.sliceId}`,
                statusCode: 1,
              });
            }

            const adapter = this.runnerRegistry.resolve(worker, {
              forceDryRun: options.dryRun === true,
            });
            const cwd = resolveExecutionCwd(run, sliceState, worker);
            const preparedWorkspace = await prepareExecutionWorkspace(run, sliceState, cwd);
            if (preparedWorkspace.baseRevision) {
              sliceState.baseRevision = preparedWorkspace.baseRevision;
            }
            return {
              result: await adapter.execute({
                cwd,
                run,
                signal: undefined,
                slice,
                sliceState,
                worker,
              }),
              sliceState,
            };
          }),
        );

        const waveFailures: WaveExecutionFailure[] = [];
        const waveSuccesses: WaveExecutionSuccess[] = [];

        results.forEach((result, index) => {
          const sliceState = waveSliceStates[index];
          if (!sliceState) {
            return;
          }

          if (result.status === "rejected") {
            waveFailures.push({ error: result.reason, sliceState });
            return;
          }

          waveSuccesses.push({
            result: result.value.result,
            sliceState,
          });
        });

        for (const { result, sliceState } of waveSuccesses) {
          const workerId = sliceState.assignedWorkerId;
          if (!workerId) {
            throw new QuestDomainError({
              code: "invalid_quest_run",
              details: { runId: run.id, sliceId: sliceState.sliceId },
              message: `Slice ${sliceState.sliceId} has no assigned worker`,
              statusCode: 1,
            });
          }

          const worker = workerMap.get(workerId);
          if (!worker) {
            throw new QuestDomainError({
              code: "quest_worker_not_found",
              details: { runId: run.id, sliceId: sliceState.sliceId, workerId },
              message: `Assigned worker ${workerId} is not registered`,
              statusCode: 1,
            });
          }

          const workerCwd = resolveExecutionCwd(run, sliceState, worker);
          const sliceSpec = specSliceMap.get(sliceState.sliceId);
          if (!sliceSpec) {
            throw new QuestDomainError({
              code: "invalid_quest_run",
              details: { runId: run.id, sliceId: sliceState.sliceId },
              message: `Quest run ${run.id} is missing spec for slice ${sliceState.sliceId}`,
              statusCode: 1,
            });
          }

          if (sliceSpec.acceptanceChecks.length > 0) {
            const eventAt = nowIsoString();
            setSliceStatus(sliceState, "testing");
            appendEvent(
              run,
              "slice_testing_started",
              {
                checkCount: sliceSpec.acceptanceChecks.length,
                sliceId: sliceState.sliceId,
              },
              eventAt,
            );
          }

          const checkResults = await runAcceptanceChecks(sliceSpec.acceptanceChecks, workerCwd);
          sliceState.lastChecks = checkResults;

          const failedCheck = checkResults.find((check) => check.exitCode !== 0);
          if (failedCheck) {
            const eventAt = nowIsoString();
            setSliceStatus(sliceState, "failed", {
              completedAt: eventAt,
              lastError: `Acceptance check failed: ${failedCheck.command.argv.join(" ")}`,
              lastOutput: {
                exitCode: failedCheck.exitCode,
                stderr: failedCheck.stderr,
                stdout: failedCheck.stdout,
                summary: `Acceptance check failed: ${failedCheck.command.argv.join(" ")}`,
              },
            });
            appendEvent(
              run,
              "slice_testing_failed",
              {
                command: failedCheck.command.argv,
                exitCode: failedCheck.exitCode,
                sliceId: sliceState.sliceId,
              },
              eventAt,
            );
            waveFailures.push({
              error: new QuestDomainError({
                code: "quest_acceptance_check_failed",
                details: {
                  command: failedCheck.command,
                  runId: run.id,
                  sliceId: sliceState.sliceId,
                  stderr: failedCheck.stderr,
                  stdout: failedCheck.stdout,
                },
                message: `Acceptance check failed for slice ${sliceState.sliceId}`,
                statusCode: 1,
              }),
              sliceState,
            });
            continue;
          }

          if (sliceSpec.acceptanceChecks.length > 0) {
            appendEvent(run, "slice_testing_completed", {
              checkCount: sliceSpec.acceptanceChecks.length,
              sliceId: sliceState.sliceId,
            });
          }

          const eventAt = nowIsoString();
          setSliceStatus(sliceState, "completed", {
            completedAt: eventAt,
            lastError: undefined,
            lastOutput: {
              exitCode: result.exitCode,
              stderr: result.stderr,
              stdout: result.stdout,
              summary: result.summary,
            },
          });
          appendEvent(
            run,
            "slice_completed",
            {
              sliceId: sliceState.sliceId,
              summary: result.summary,
              workerId: sliceState.assignedWorkerId,
            },
            eventAt,
          );
        }

        for (const { error, sliceState } of waveFailures) {
          const eventAt = nowIsoString();
          setSliceStatus(sliceState, "failed", {
            completedAt: eventAt,
            lastError: error instanceof Error ? error.message : String(error),
            lastOutput: sliceState.lastOutput,
          });
          appendEvent(
            run,
            "slice_failed",
            {
              error: sliceState.lastError,
              sliceId: sliceState.sliceId,
              workerId: sliceState.assignedWorkerId,
            },
            eventAt,
          );
        }

        await this.runStore.saveRun(run);

        if (waveFailures.length > 0) {
          throw waveFailures[0]?.error;
        }
      }

      setRunStatus(run, "completed");
      appendEvent(run, "run_completed", {
        completedSliceCount: run.slices.filter((slice) => slice.status === "completed").length,
      });
      await this.runStore.saveRun(run);
      return run;
    } catch (error: unknown) {
      const eventAt = nowIsoString();
      setRunStatus(run, "failed");

      const activeSliceStates = run.slices.filter(
        (slice) => slice.status === "running" || slice.status === "testing",
      );
      activeSliceStates.forEach((sliceState) => {
        setSliceStatus(sliceState, "failed", {
          completedAt: eventAt,
          lastError: error instanceof Error ? error.message : String(error),
          lastOutput: undefined,
        });
        appendEvent(
          run,
          "slice_failed",
          {
            error: sliceState.lastError,
            sliceId: sliceState.sliceId,
            workerId: sliceState.assignedWorkerId,
          },
          eventAt,
        );
      });

      appendEvent(
        run,
        "run_failed",
        { error: error instanceof Error ? error.message : String(error) },
        eventAt,
      );
      await this.runStore.saveRun(run);
      throw error;
    }
  }
}
