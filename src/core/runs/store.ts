import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { QuestDomainError } from "../errors";
import { isWorkerCompatibleWithSlice, planQuest } from "../planning/planner";
import type { QuestSpec } from "../planning/spec-schema";
import {
  readJsonFileOrDefault,
  resolveQuestRunPath,
  resolveQuestRunsRoot,
  resolveQuestWorkspacesRoot,
  writeJsonFileAtomically,
} from "../storage";
import type { RegisteredWorker } from "../workers/schema";
import { appendEvent, nowIsoString, setRunStatus, setSliceStatus } from "./lifecycle";
import {
  type QuestRunDocument,
  type QuestRunEvent,
  type QuestRunSliceState,
  type QuestRunStatus,
  questRunDocumentSchema,
} from "./schema";
import {
  assertWorkspacePathWithinRoot,
  resolveRunWorkspaceRootPath,
  resolveSliceWorkspacePathForRunRoot,
} from "./workspace-layout";

export type QuestRunSummary = Pick<
  QuestRunDocument,
  "createdAt" | "id" | "status" | "updatedAt"
> & {
  questTitle: string;
  unassignedCount: number;
  warningCount: number;
  waveCount: number;
  workspace: string;
};

export type QuestRunLogView = {
  runId: string;
  workspaceRoot: string;
  slices: Array<{
    lastChecks?: QuestRunSliceState["lastChecks"] | undefined;
    lastError?: string | undefined;
    lastOutput?: QuestRunSliceState["lastOutput"] | undefined;
    sliceId: string;
    status: QuestRunSliceState["status"];
    title: string;
    wave: number;
    workspacePath: string;
  }>;
};

function createQuestRunId(): string {
  const timePart = Date.now().toString(36).slice(-8).padStart(8, "0");
  const randomPart = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `quest-${timePart}-${randomPart}`;
}

function summarizeRun(run: QuestRunDocument): QuestRunSummary {
  return {
    createdAt: run.createdAt,
    id: run.id,
    questTitle: run.spec.title,
    status: run.status,
    unassignedCount: run.plan.unassigned.length,
    updatedAt: run.updatedAt,
    warningCount: run.plan.warnings.length,
    waveCount: run.plan.waves.length,
    workspace: run.spec.workspace,
  };
}

function resolveRunWorkspaceRootForStore(runId: string, workspacesRoot: string): string {
  return resolveRunWorkspaceRootPath(workspacesRoot, runId);
}

function resolveSliceWorkspacePathForStore(workspaceRoot: string, sliceId: string): string {
  return resolveSliceWorkspacePathForRunRoot(workspaceRoot, sliceId);
}

function buildInitialSliceStates(
  run: Pick<QuestRunDocument, "id" | "plan" | "spec" | "workspaceRoot">,
): QuestRunSliceState[] {
  const workspaceRoot = run.workspaceRoot;
  if (!workspaceRoot) {
    throw new QuestDomainError({
      code: "invalid_quest_run",
      details: { runId: run.id },
      message: `Quest run ${run.id} is missing a workspace root`,
      statusCode: 1,
    });
  }

  const scheduledSlices = run.plan.waves.flatMap((wave) =>
    wave.slices.map<QuestRunSliceState>((slice) => ({
      assignedRunner: slice.assignedRunner,
      assignedWorkerId: slice.assignedWorkerId,
      integrationStatus: "pending",
      sliceId: slice.id,
      status: "pending",
      title: slice.title,
      wave: slice.wave,
      workspacePath: resolveSliceWorkspacePathForStore(workspaceRoot, slice.id),
    })),
  );

  const blockedSlices = run.plan.unassigned.map<QuestRunSliceState>((slice) => ({
    assignedRunner: null,
    assignedWorkerId: null,
    integrationStatus: "pending",
    lastError: slice.message,
    sliceId: slice.id,
    status: "blocked",
    title: slice.title,
    wave: 0,
    workspacePath: resolveSliceWorkspacePathForStore(workspaceRoot, slice.id),
  }));

  const orderedSliceIds = run.spec.slices.map((slice) => slice.id);
  const allSlices = [...scheduledSlices, ...blockedSlices];
  return allSlices.sort(
    (left, right) => orderedSliceIds.indexOf(left.sliceId) - orderedSliceIds.indexOf(right.sliceId),
  );
}

function hydrateWorkspacePaths(run: QuestRunDocument, workspacesRoot: string): QuestRunDocument {
  const workspaceRoot =
    run.workspaceRoot ?? resolveRunWorkspaceRootForStore(run.id, workspacesRoot);

  run.workspaceRoot = workspaceRoot;
  run.slices.forEach((slice) => {
    slice.workspacePath ??= resolveSliceWorkspacePathForStore(workspaceRoot, slice.sliceId);
  });

  return run;
}

function findSliceForMutation(run: QuestRunDocument, sliceId: string): QuestRunSliceState {
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

function findSpecSlice(run: QuestRunDocument, sliceId: string) {
  const slice = run.spec.slices.find((candidate) => candidate.id === sliceId);
  if (!slice) {
    throw new QuestDomainError({
      code: "invalid_quest_run",
      details: { runId: run.id, sliceId },
      message: `Quest run ${run.id} is missing spec for slice ${sliceId}`,
      statusCode: 1,
    });
  }

  return slice;
}

function removeWarningsForSlice(run: QuestRunDocument, sliceId: string): void {
  run.plan.warnings = run.plan.warnings.filter((warning) => warning.sliceId !== sliceId);
}

function reconcileRunStatus(run: QuestRunDocument): QuestRunStatus {
  if (run.slices.some((slice) => slice.status === "running" || slice.status === "testing")) {
    return "running";
  }

  if (run.slices.some((slice) => slice.status === "blocked")) {
    return "blocked";
  }

  if (run.slices.some((slice) => slice.status === "failed")) {
    return "failed";
  }

  if (run.slices.some((slice) => slice.status === "pending")) {
    return "planned";
  }

  return "completed";
}

function requireSteerableRun(run: QuestRunDocument, action: string): void {
  if (run.status === "running" || run.status === "paused") {
    throw new QuestDomainError({
      code: "quest_run_not_steerable",
      details: { action, runId: run.id, status: run.status },
      message: `Quest run ${run.id} cannot ${action} from status ${run.status}`,
      statusCode: 1,
    });
  }

  if (run.status === "aborted" || run.status === "completed") {
    throw new QuestDomainError({
      code: "quest_run_not_steerable",
      details: { action, runId: run.id, status: run.status },
      message: `Quest run ${run.id} cannot ${action} from status ${run.status}`,
      statusCode: 1,
    });
  }
}

function requirePendingLikeSlice(
  run: QuestRunDocument,
  sliceState: QuestRunSliceState,
  action: string,
): void {
  if (sliceState.status === "running" || sliceState.status === "testing") {
    throw new QuestDomainError({
      code: "quest_slice_not_steerable",
      details: { action, runId: run.id, sliceId: sliceState.sliceId, status: sliceState.status },
      message: `Slice ${sliceState.sliceId} cannot ${action} from status ${sliceState.status}`,
      statusCode: 1,
    });
  }

  if (sliceState.status === "completed" || sliceState.status === "aborted") {
    throw new QuestDomainError({
      code: "quest_slice_not_steerable",
      details: { action, runId: run.id, sliceId: sliceState.sliceId, status: sliceState.status },
      message: `Slice ${sliceState.sliceId} cannot ${action} from status ${sliceState.status}`,
      statusCode: 1,
    });
  }
}

function findPlannedSlice(run: QuestRunDocument, sliceId: string) {
  for (const wave of run.plan.waves) {
    const plannedSlice = wave.slices.find((slice) => slice.id === sliceId);
    if (plannedSlice) {
      return plannedSlice;
    }
  }

  return null;
}

function removeUnassignedSlice(run: QuestRunDocument, sliceId: string): void {
  run.plan.unassigned = run.plan.unassigned.filter((slice) => slice.id !== sliceId);
}

function appendBlockedSliceToWave(
  run: QuestRunDocument,
  sliceId: string,
  worker: RegisteredWorker,
): number {
  const specSlice = findSpecSlice(run, sliceId);
  removeUnassignedSlice(run, sliceId);
  const nextWaveIndex = (run.plan.waves.at(-1)?.index ?? 0) + 1;
  run.plan.waves.push({
    index: nextWaveIndex,
    slices: [
      {
        assignedRunner: worker.backend.runner,
        assignedWorkerId: worker.id,
        conflictPaths: [],
        dependsOn: [...specSlice.dependsOn],
        hot: false,
        id: specSlice.id,
        score: null,
        title: specSlice.title,
        wave: nextWaveIndex,
      },
    ],
  });
  return nextWaveIndex;
}

function selectWorkersForRun(
  workers: RegisteredWorker[],
  forcedWorkerId?: string | undefined,
): RegisteredWorker[] {
  if (!forcedWorkerId) {
    return workers;
  }

  const worker = workers.find((candidate) => candidate.id === forcedWorkerId) ?? null;
  if (!worker?.enabled) {
    throw new QuestDomainError({
      code: "quest_worker_not_found",
      details: { forcedWorkerId },
      message: `Forced worker ${forcedWorkerId} is not registered or enabled`,
      statusCode: 1,
    });
  }

  return [worker];
}

function applyForcedWorkerToSpec(spec: QuestSpec, forcedWorkerId?: string | undefined): QuestSpec {
  if (!forcedWorkerId) {
    return spec;
  }

  return {
    ...spec,
    slices: spec.slices.map((slice) => ({
      ...slice,
      preferredWorkerId: forcedWorkerId,
    })),
  };
}

async function validateWorkspacePaths(
  run: QuestRunDocument,
  workspacesRoot: string,
): Promise<QuestRunDocument> {
  // Run JSON is persisted local state, not trusted code. Validate paths on load/save so a tampered
  // document cannot trick cleanup or integration into walking outside the managed workspace tree.
  const workspaceRoot =
    run.workspaceRoot ?? resolveRunWorkspaceRootForStore(run.id, workspacesRoot);
  run.workspaceRoot = await assertWorkspacePathWithinRoot(
    workspacesRoot,
    workspaceRoot,
    "Workspace root",
  );

  for (const slice of run.slices) {
    const workspacePath =
      slice.workspacePath ?? resolveSliceWorkspacePathForStore(run.workspaceRoot, slice.sliceId);
    slice.workspacePath = await assertWorkspacePathWithinRoot(
      run.workspaceRoot,
      workspacePath,
      `Slice workspace ${slice.sliceId}`,
    );
  }

  if (run.integrationWorkspacePath) {
    run.integrationWorkspacePath = await assertWorkspacePathWithinRoot(
      run.workspaceRoot,
      run.integrationWorkspacePath,
      "Integration workspace",
    );
  }

  return run;
}

export class QuestRunStore {
  constructor(
    private readonly runsRoot: string = resolveQuestRunsRoot(),
    private readonly workspacesRoot: string = resolveQuestWorkspacesRoot(),
  ) {}

  async createRun(
    spec: QuestSpec,
    workers: RegisteredWorker[],
    options: {
      forcedWorkerId?: string | undefined;
      sourceRepositoryPath?: string | undefined;
    } = {},
  ): Promise<QuestRunDocument> {
    const createdAt = nowIsoString();
    const selectedWorkers = selectWorkersForRun(workers, options.forcedWorkerId);
    const runSpec = applyForcedWorkerToSpec(spec, options.forcedWorkerId);
    const plan = planQuest(runSpec, selectedWorkers);
    const runId = createQuestRunId();
    const events: QuestRunEvent[] = [
      {
        at: createdAt,
        details: {
          forcedWorkerId: options.forcedWorkerId ?? null,
          unassignedCount: plan.unassigned.length,
          warningCount: plan.warnings.length,
          waveCount: plan.waves.length,
        },
        type: "run_created",
      },
    ];

    if (plan.unassigned.length > 0) {
      events.push({
        at: createdAt,
        details: {
          sliceIds: plan.unassigned.map((slice) => slice.id),
        },
        type: "run_blocked",
      });
    }

    const runBase = {
      createdAt,
      events,
      id: runId,
      plan,
      sourceRepositoryPath: options.sourceRepositoryPath
        ? resolve(options.sourceRepositoryPath)
        : undefined,
      spec: runSpec,
      workspaceRoot: resolveRunWorkspaceRootForStore(runId, this.workspacesRoot),
    };

    const run: QuestRunDocument = {
      ...runBase,
      slices: buildInitialSliceStates(runBase),
      status: plan.unassigned.length > 0 ? "blocked" : "planned",
      updatedAt: createdAt,
      version: 1,
    };

    return this.saveRun(
      await validateWorkspacePaths(
        hydrateWorkspacePaths(run, this.workspacesRoot),
        this.workspacesRoot,
      ),
    );
  }

  async getRun(runId: string): Promise<QuestRunDocument> {
    const path = resolveQuestRunPath(runId, { explicitRunsRoot: this.runsRoot });
    const rawDocument = await readJsonFileOrDefault<QuestRunDocument | null>(path, null, {
      invalidJsonCode: "invalid_quest_run",
      invalidJsonMessage: `Invalid JSON in quest run file: ${path}`,
    });
    if (rawDocument === null) {
      throw new QuestDomainError({
        code: "quest_run_not_found",
        details: { runId },
        message: `Quest run ${runId} was not found`,
        statusCode: 1,
      });
    }

    const parsed = questRunDocumentSchema.safeParse(rawDocument);
    if (!parsed.success) {
      throw new QuestDomainError({
        code: "invalid_quest_run",
        details: parsed.error.flatten(),
        message: `Quest run ${runId} is invalid`,
        statusCode: 1,
      });
    }

    return await validateWorkspacePaths(
      hydrateWorkspacePaths(parsed.data, this.workspacesRoot),
      this.workspacesRoot,
    );
  }

  async listRuns(): Promise<QuestRunSummary[]> {
    let entries: string[];

    try {
      entries = await readdir(this.runsRoot);
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }

      throw new QuestDomainError({
        code: "quest_storage_failure",
        details: {
          path: this.runsRoot,
          reason: error instanceof Error ? error.message : String(error),
        },
        message: `Failed to list quest runs from ${this.runsRoot}`,
        statusCode: 1,
      });
    }

    const runIds = entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -".json".length));

    const runs = await Promise.all(runIds.map((runId) => this.getRun(runId)));
    return runs
      .map(summarizeRun)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async saveRun(run: QuestRunDocument): Promise<QuestRunDocument> {
    const hydratedRun = await validateWorkspacePaths(
      hydrateWorkspacePaths(run, this.workspacesRoot),
      this.workspacesRoot,
    );
    const parsed = questRunDocumentSchema.safeParse(hydratedRun);
    if (!parsed.success) {
      throw new QuestDomainError({
        code: "invalid_quest_run",
        details: parsed.error.flatten(),
        message: `Quest run ${run.id} is invalid`,
        statusCode: 1,
      });
    }

    await writeJsonFileAtomically(
      resolveQuestRunPath(run.id, { explicitRunsRoot: this.runsRoot }),
      parsed.data,
    );
    return parsed.data;
  }

  async abortRun(runId: string): Promise<QuestRunDocument> {
    const run = await this.getRun(runId);

    if (run.status === "completed" || run.status === "failed") {
      throw new QuestDomainError({
        code: "quest_run_not_abortable",
        details: { runId, status: run.status },
        message: `Quest run ${runId} cannot be aborted from status ${run.status}`,
        statusCode: 1,
      });
    }

    if (run.status === "aborted") {
      return run;
    }

    const eventAt = nowIsoString();
    setRunStatus(run, "aborted");

    run.slices.forEach((slice) => {
      if (slice.status === "completed" || slice.status === "failed" || slice.status === "blocked") {
        return;
      }

      setSliceStatus(slice, "aborted", {
        completedAt: eventAt,
        lastError: "Run aborted",
      });
      appendEvent(
        run,
        "slice_aborted",
        {
          sliceId: slice.sliceId,
          workerId: slice.assignedWorkerId,
        },
        eventAt,
      );
    });

    appendEvent(run, "run_aborted", { runId }, eventAt);
    return this.saveRun(run);
  }

  async pauseRun(runId: string, reason?: string | undefined): Promise<QuestRunDocument> {
    const run = await this.getRun(runId);
    if (
      run.status === "completed" ||
      run.status === "aborted" ||
      run.status === "running" ||
      run.status === "paused"
    ) {
      throw new QuestDomainError({
        code: "quest_run_not_steerable",
        details: { reason, runId, status: run.status },
        message: `Quest run ${runId} cannot be paused from status ${run.status}`,
        statusCode: 1,
      });
    }

    const eventAt = nowIsoString();
    setRunStatus(run, "paused");
    appendEvent(run, "run_paused", { reason: reason ?? null, runId }, eventAt);
    return this.saveRun(run);
  }

  async resumeRun(runId: string): Promise<QuestRunDocument> {
    const run = await this.getRun(runId);
    if (run.status !== "paused") {
      throw new QuestDomainError({
        code: "quest_run_not_steerable",
        details: { runId, status: run.status },
        message: `Quest run ${runId} is not paused`,
        statusCode: 1,
      });
    }

    const eventAt = nowIsoString();
    setRunStatus(run, reconcileRunStatus(run));
    appendEvent(run, "run_resumed", { runId }, eventAt);
    return this.saveRun(run);
  }

  async reassignSlice(
    runId: string,
    sliceId: string,
    worker: RegisteredWorker,
  ): Promise<QuestRunDocument> {
    const run = await this.getRun(runId);
    requireSteerableRun(run, "reassign slices");

    if (!worker.enabled) {
      throw new QuestDomainError({
        code: "quest_worker_not_found",
        details: { runId, sliceId, workerId: worker.id },
        message: `Worker ${worker.id} is not enabled`,
        statusCode: 1,
      });
    }

    const sliceState = findSliceForMutation(run, sliceId);
    requirePendingLikeSlice(run, sliceState, "be reassigned");
    const specSlice = findSpecSlice(run, sliceId);

    const eventAt = nowIsoString();
    specSlice.preferredWorkerId = worker.id;
    if (!isWorkerCompatibleWithSlice(worker, specSlice)) {
      // Explicit operator steering should become the persisted intent for future execution, even
      // when it overrides a stale preferred runner from the original plan snapshot.
      specSlice.preferredRunner = worker.backend.runner;
    }
    sliceState.assignedWorkerId = worker.id;
    sliceState.assignedRunner = worker.backend.runner;
    if (sliceState.status === "blocked") {
      const assignedWave = appendBlockedSliceToWave(run, sliceId, worker);
      sliceState.wave = assignedWave;
      removeWarningsForSlice(run, sliceId);
      setSliceStatus(sliceState, "pending");
      delete sliceState.completedAt;
      delete sliceState.lastChecks;
      delete sliceState.lastError;
      delete sliceState.lastOutput;
    } else {
      const plannedSlice = findPlannedSlice(run, sliceId);
      if (plannedSlice) {
        plannedSlice.assignedRunner = worker.backend.runner;
        plannedSlice.assignedWorkerId = worker.id;
      }
    }
    setRunStatus(run, reconcileRunStatus(run));
    appendEvent(
      run,
      "slice_reassigned",
      {
        runId,
        runner: worker.backend.runner,
        sliceId,
        workerId: worker.id,
      },
      eventAt,
    );
    return this.saveRun(run);
  }

  async retrySlice(runId: string, sliceId: string): Promise<QuestRunDocument> {
    const run = await this.getRun(runId);
    requireSteerableRun(run, "retry slices");

    const sliceState = findSliceForMutation(run, sliceId);
    if (sliceState.status !== "failed") {
      throw new QuestDomainError({
        code: "quest_slice_not_steerable",
        details: { runId, sliceId, status: sliceState.status },
        message: `Slice ${sliceId} cannot be retried from status ${sliceState.status}`,
        statusCode: 1,
      });
    }

    const eventAt = nowIsoString();
    setSliceStatus(sliceState, "pending");
    delete sliceState.completedAt;
    delete sliceState.startedAt;
    delete sliceState.lastChecks;
    delete sliceState.lastError;
    delete sliceState.lastOutput;
    sliceState.integrationStatus = "pending";
    delete sliceState.integratedCommit;
    delete sliceState.resultRevision;
    delete sliceState.driftedFromBase;
    setRunStatus(run, reconcileRunStatus(run));
    appendEvent(run, "slice_retry_queued", { runId, sliceId }, eventAt);
    return this.saveRun(run);
  }

  async skipSlice(
    runId: string,
    sliceId: string,
    reason?: string | undefined,
  ): Promise<QuestRunDocument> {
    const run = await this.getRun(runId);
    requireSteerableRun(run, "skip slices");

    const sliceState = findSliceForMutation(run, sliceId);
    requirePendingLikeSlice(run, sliceState, "be skipped");

    const eventAt = nowIsoString();
    const previousStatus = sliceState.status;
    setSliceStatus(sliceState, "skipped", { completedAt: eventAt });
    delete sliceState.lastChecks;
    if (reason) {
      sliceState.lastError = reason;
    } else {
      delete sliceState.lastError;
    }
    delete sliceState.lastOutput;
    sliceState.integrationStatus = "noop";
    delete sliceState.integratedCommit;
    if (previousStatus === "blocked") {
      removeUnassignedSlice(run, sliceId);
    }
    setRunStatus(run, reconcileRunStatus(run));
    appendEvent(run, "slice_skipped", { reason: reason ?? null, runId, sliceId }, eventAt);
    return this.saveRun(run);
  }

  async getRunLogs(runId: string, sliceId?: string | undefined): Promise<QuestRunLogView> {
    const run = await this.getRun(runId);
    const filteredSlices = sliceId
      ? run.slices.filter((slice) => slice.sliceId === sliceId)
      : run.slices;
    const workspaceRoot =
      run.workspaceRoot ?? resolveRunWorkspaceRootForStore(run.id, this.workspacesRoot);

    return {
      runId: run.id,
      workspaceRoot,
      slices: filteredSlices.map((slice) => ({
        sliceId: slice.sliceId,
        status: slice.status,
        title: slice.title,
        wave: slice.wave,
        workspacePath:
          slice.workspacePath ?? resolveSliceWorkspacePathForStore(workspaceRoot, slice.sliceId),
        lastError: slice.lastError,
        lastChecks: slice.lastChecks,
        lastOutput: slice.lastOutput,
      })),
    };
  }
}
