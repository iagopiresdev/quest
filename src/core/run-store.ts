import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { QuestDomainError } from "./errors";
import { planQuest } from "./planner";
import { appendEvent, nowIsoString, setRunStatus, setSliceStatus } from "./run-lifecycle";
import {
  type QuestRunDocument,
  type QuestRunEvent,
  type QuestRunSliceState,
  questRunDocumentSchema,
} from "./run-schema";
import type { QuestSpec } from "./spec-schema";
import {
  readJsonFileOrDefault,
  resolveQuestRunPath,
  resolveQuestRunsRoot,
  resolveQuestRunWorkspaceRoot,
  resolveQuestSliceWorkspacePath,
  resolveQuestWorkspacesRoot,
  writeJsonFileAtomically,
} from "./storage";
import type { RegisteredWorker } from "./worker-schema";

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
    sliceId: string;
    status: QuestRunSliceState["status"];
    title: string;
    wave: number;
    workspacePath: string;
    lastChecks?: QuestRunSliceState["lastChecks"];
    lastError?: string;
    lastOutput?: QuestRunSliceState["lastOutput"];
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
  return resolveQuestRunWorkspaceRoot(runId, {
    explicitWorkspacesRoot: workspacesRoot,
  });
}

function resolveSliceWorkspacePathForStore(
  runId: string,
  sliceId: string,
  workspacesRoot: string,
): string {
  return resolveQuestSliceWorkspacePath(runId, sliceId, {
    explicitWorkspacesRoot: workspacesRoot,
  });
}

function buildInitialSliceStates(
  run: Pick<QuestRunDocument, "id" | "plan" | "spec" | "workspaceRoot">,
  workspacesRoot: string,
): QuestRunSliceState[] {
  const scheduledSlices = run.plan.waves.flatMap((wave) =>
    wave.slices.map<QuestRunSliceState>((slice) => ({
      assignedRunner: slice.assignedRunner,
      assignedWorkerId: slice.assignedWorkerId,
      sliceId: slice.id,
      status: "pending",
      title: slice.title,
      wave: slice.wave,
      workspacePath: resolveSliceWorkspacePathForStore(run.id, slice.id, workspacesRoot),
    })),
  );

  const blockedSlices = run.plan.unassigned.map<QuestRunSliceState>((slice) => ({
    assignedRunner: null,
    assignedWorkerId: null,
    lastError: slice.message,
    sliceId: slice.id,
    status: "blocked",
    title: slice.title,
    wave: 0,
    workspacePath: resolveSliceWorkspacePathForStore(run.id, slice.id, workspacesRoot),
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
    slice.workspacePath ??= resolveSliceWorkspacePathForStore(
      run.id,
      slice.sliceId,
      workspacesRoot,
    );
  });

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
    options: { sourceRepositoryPath?: string } = {},
  ): Promise<QuestRunDocument> {
    const createdAt = nowIsoString();
    const plan = planQuest(spec, workers);
    const runId = createQuestRunId();
    const events: QuestRunEvent[] = [
      {
        at: createdAt,
        details: {
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
      spec,
      workspaceRoot: resolveRunWorkspaceRootForStore(runId, this.workspacesRoot),
    };

    const run: QuestRunDocument = {
      ...runBase,
      slices: buildInitialSliceStates(runBase, this.workspacesRoot),
      status: plan.unassigned.length > 0 ? "blocked" : "planned",
      updatedAt: createdAt,
      version: 1,
    };

    return this.saveRun(hydrateWorkspacePaths(run, this.workspacesRoot));
  }

  async getRun(runId: string): Promise<QuestRunDocument> {
    const path = resolveQuestRunPath(runId, { explicitRunsRoot: this.runsRoot });
    const rawDocument = await readJsonFileOrDefault<QuestRunDocument | null>(path, null);
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

    return hydrateWorkspacePaths(parsed.data, this.workspacesRoot);
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
    const parsed = questRunDocumentSchema.safeParse(
      hydrateWorkspacePaths(run, this.workspacesRoot),
    );
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

  async getRunLogs(runId: string, sliceId?: string): Promise<QuestRunLogView> {
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
          slice.workspacePath ??
          resolveSliceWorkspacePathForStore(run.id, slice.sliceId, this.workspacesRoot),
        lastError: slice.lastError,
        lastChecks: slice.lastChecks,
        lastOutput: slice.lastOutput,
      })),
    };
  }
}
