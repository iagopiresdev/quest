import { QuestDomainError } from "./errors";
import { QuestRunStore } from "./run-store";
import { type QuestRunDocument, type QuestRunEvent, type QuestRunSliceState } from "./run-schema";
import { DryRunRunnerAdapter, LocalCommandRunnerAdapter, RunnerRegistry } from "./runner";
import { WorkerRegistry } from "./worker-registry";

function nowIsoString(): string {
  return new Date().toISOString();
}

function appendEvent(run: QuestRunDocument, event: QuestRunEvent): void {
  run.events.push(event);
  run.updatedAt = event.at;
}

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

    run.status = "running";
    appendEvent(run, {
      at: startedAt,
      details: { dryRun: options.dryRun === true },
      type: "run_started",
    });
    await this.runStore.saveRun(run);

    try {
      for (const wave of run.plan.waves) {
        const waveSliceStates = wave.slices.map((plannedSlice) => findSliceState(run, plannedSlice.id));

        waveSliceStates.forEach((sliceState) => {
          const eventAt = nowIsoString();
          sliceState.status = "running";
          sliceState.startedAt = eventAt;
          appendEvent(run, {
            at: eventAt,
            details: {
              sliceId: sliceState.sliceId,
              wave: sliceState.wave,
              workerId: sliceState.assignedWorkerId,
            },
            type: "slice_started",
          });
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
          const eventAt = nowIsoString();
          sliceState.completedAt = eventAt;
          sliceState.lastError = undefined;
          sliceState.lastOutput = {
            exitCode: result.exitCode,
            stderr: result.stderr,
            stdout: result.stdout,
            summary: result.summary,
          };
          sliceState.status = "completed";
          appendEvent(run, {
            at: eventAt,
            details: {
              sliceId: sliceState.sliceId,
              summary: result.summary,
              workerId: sliceState.assignedWorkerId,
            },
            type: "slice_completed",
          });
        });
        await this.runStore.saveRun(run);
      }

      run.status = "completed";
      appendEvent(run, {
        at: nowIsoString(),
        details: {
          completedSliceCount: run.slices.filter((slice) => slice.status === "completed").length,
        },
        type: "run_completed",
      });
      await this.runStore.saveRun(run);
      return run;
    } catch (error: unknown) {
      const eventAt = nowIsoString();
      run.status = "failed";

      const activeSliceStates = run.slices.filter((slice) => slice.status === "running");
      activeSliceStates.forEach((sliceState) => {
        sliceState.completedAt = eventAt;
        sliceState.lastError = error instanceof Error ? error.message : String(error);
        sliceState.lastOutput = undefined;
        sliceState.status = "failed";
        appendEvent(run, {
          at: eventAt,
          details: {
            error: sliceState.lastError,
            sliceId: sliceState.sliceId,
            workerId: sliceState.assignedWorkerId,
          },
          type: "slice_failed",
        });
      });

      appendEvent(run, {
        at: eventAt,
        details: { error: error instanceof Error ? error.message : String(error) },
        type: "run_failed",
      });
      await this.runStore.saveRun(run);
      throw error;
    }
  }
}
