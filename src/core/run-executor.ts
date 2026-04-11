import { QuestDomainError } from "./errors";
import { appendEvent, nowIsoString, setRunStatus, setSliceStatus } from "./run-lifecycle";
import { QuestRunStore } from "./run-store";
import { type QuestRunCheckResult, type QuestRunDocument, type QuestRunSliceState } from "./run-schema";
import { DryRunRunnerAdapter, LocalCommandRunnerAdapter, RunnerRegistry } from "./runner";
import { WorkerRegistry } from "./worker-registry";
import { type RegisteredWorker } from "./worker-schema";

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

function resolveExecutionCwd(sliceState: QuestRunSliceState, workers: Map<string, RegisteredWorker>): string {
  const workerId = sliceState.assignedWorkerId;
  if (!workerId) {
    return Bun.env.PWD ?? ".";
  }

  const worker = workers.get(workerId);
  return worker?.backend.workingDirectory ?? Bun.env.PWD ?? ".";
}

function runAcceptanceChecks(commands: string[], cwd: string): QuestRunCheckResult[] {
  return commands.map((command) => {
    const result = Bun.spawnSync({
      cmd: ["/bin/sh", "-lc", command],
      cwd,
      env: Bun.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    return {
      command,
      exitCode: result.exitCode,
      stderr: new TextDecoder().decode(result.stderr),
      stdout: new TextDecoder().decode(result.stdout),
    };
  });
}

export class QuestRunExecutor {
  private readonly runnerRegistry = new RunnerRegistry([new DryRunRunnerAdapter(), new LocalCommandRunnerAdapter()]);

  constructor(
    private readonly runStore: QuestRunStore,
    private readonly workerRegistry: WorkerRegistry,
  ) {}

  async executeRun(runId: string, options: { dryRun?: boolean } = {}): Promise<QuestRunDocument> {
    const run = await this.runStore.getRun(runId);
    requireExecutableRun(run);

    const workers = await this.workerRegistry.listWorkers();
    const workerMap = new Map(workers.map((worker) => [worker.id, worker]));
    const specSliceMap = new Map(run.spec.slices.map((slice) => [slice.id, slice]));
    const startedAt = nowIsoString();

    setRunStatus(run, "running");
    appendEvent(run, "run_started", { dryRun: options.dryRun === true }, startedAt);
    await this.runStore.saveRun(run);

    try {
      for (const wave of run.plan.waves) {
        const waveSliceStates = wave.slices.map((plannedSlice) => findSliceState(run, plannedSlice.id));

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

        const results = await Promise.all(
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

            const adapter = this.runnerRegistry.resolve(worker, { forceDryRun: options.dryRun === true });
            return {
              result: await adapter.execute({
                run,
                slice,
                sliceState,
                worker,
              }),
              sliceState,
            };
          }),
        );

        results.forEach(({ result, sliceState }) => {
          const workerCwd = resolveExecutionCwd(sliceState, workerMap);
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

          const checkResults = runAcceptanceChecks(sliceSpec.acceptanceChecks, workerCwd);
          sliceState.lastChecks = checkResults;

          const failedCheck = checkResults.find((check) => check.exitCode !== 0);
          if (failedCheck) {
            const eventAt = nowIsoString();
            setSliceStatus(sliceState, "failed", {
              completedAt: eventAt,
              lastError: `Acceptance check failed: ${failedCheck.command}`,
              lastOutput: {
                exitCode: result.exitCode,
                stderr: result.stderr,
                stdout: result.stdout,
                summary: result.summary,
              },
            });
            appendEvent(
              run,
              "slice_testing_failed",
              {
                command: failedCheck.command,
                exitCode: failedCheck.exitCode,
                sliceId: sliceState.sliceId,
              },
              eventAt,
            );
            throw new QuestDomainError({
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
            });
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
        });
        await this.runStore.saveRun(run);
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

      const activeSliceStates = run.slices.filter((slice) => slice.status === "running");
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

      appendEvent(run, "run_failed", { error: error instanceof Error ? error.message : String(error) }, eventAt);
      await this.runStore.saveRun(run);
      throw error;
    }
  }
}
