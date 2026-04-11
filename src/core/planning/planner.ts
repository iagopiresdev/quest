import { QuestDomainError } from "../errors";
import type { RegisteredWorker, WorkerDiscipline } from "../workers/schema";
import type { QuestSliceSpec, QuestSpec } from "./spec-schema";

type QuestPlanWarningCode =
  | "preferred_worker_missing"
  | "preferred_worker_incompatible"
  | "no_worker_available";

export type QuestPlanWarning = {
  code: QuestPlanWarningCode;
  message: string;
  sliceId: string;
};

export type PlannedQuestSlice = {
  assignedRunner: RegisteredWorker["backend"]["runner"];
  assignedWorkerId: string;
  conflictPaths: string[];
  dependsOn: string[];
  hot: boolean;
  id: string;
  score: number | null;
  title: string;
  wave: number;
};

export type QuestPlanWave = {
  index: number;
  slices: PlannedQuestSlice[];
};

type UnassignedQuestSliceReasonCode = "dependency_blocked" | "no_worker_available";

export type UnassignedQuestSlice = {
  dependsOn: string[];
  id: string;
  message: string;
  reasonCode: UnassignedQuestSliceReasonCode;
  title: string;
};

export type QuestPlan = {
  maxParallel: number;
  questTitle: string;
  unassigned: UnassignedQuestSlice[];
  warnings: QuestPlanWarning[];
  waves: QuestPlanWave[];
  workspace: string;
};

type WorkerAssignment = {
  score: number;
  worker: RegisteredWorker;
};

const disciplineToStatKey: Record<WorkerDiscipline, keyof RegisteredWorker["stats"]> = {
  coding: "coding",
  docs: "docs",
  research: "research",
  testing: "testing",
};

function normalizePattern(pattern: string): string {
  return pattern
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .replace(/\/\*\*$/, "")
    .replace(/\/\*$/, "");
}

export function patternsConflict(left: string, right: string): boolean {
  const normalizedLeft = normalizePattern(left);
  const normalizedRight = normalizePattern(right);

  if (normalizedLeft.length === 0 || normalizedRight.length === 0) {
    return false;
  }

  if (normalizedLeft === normalizedRight || normalizedLeft === "**" || normalizedRight === "**") {
    return true;
  }

  return (
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
}

function collectConflictPaths(
  slice: QuestSliceSpec,
  allSlices: QuestSliceSpec[],
  hotspots: string[],
): string[] {
  const conflicts = new Set<string>();

  for (const ownPattern of slice.owns) {
    for (const hotspot of hotspots) {
      if (patternsConflict(ownPattern, hotspot)) {
        conflicts.add(hotspot);
      }
    }

    for (const otherSlice of allSlices) {
      if (otherSlice.id === slice.id) {
        continue;
      }

      if (otherSlice.owns.some((otherPattern) => patternsConflict(ownPattern, otherPattern))) {
        conflicts.add(ownPattern);
      }
    }
  }

  return [...conflicts].sort();
}

function buildWorkerCandidates(
  slice: QuestSliceSpec,
  workers: RegisteredWorker[],
  warnings: QuestPlanWarning[],
): WorkerAssignment[] {
  const enabledWorkers = workers.filter((worker) => worker.enabled);
  const compatibleWorkers = enabledWorkers.filter((worker) => {
    if (slice.preferredRunner && worker.backend.runner !== slice.preferredRunner) {
      return false;
    }

    return true;
  });

  const sortCandidates = (candidates: RegisteredWorker[]): WorkerAssignment[] =>
    [...candidates]
      .sort(
        (left, right) =>
          scoreWorkerForSlice(right, slice, false) - scoreWorkerForSlice(left, slice, false),
      )
      .map((worker) => ({
        score: scoreWorkerForSlice(worker, slice, false),
        worker,
      }));

  if (slice.preferredWorkerId) {
    const preferredWorker = enabledWorkers.find((worker) => worker.id === slice.preferredWorkerId);
    if (!preferredWorker) {
      warnings.push({
        code: "preferred_worker_missing",
        message: `Preferred worker ${slice.preferredWorkerId} is not registered or enabled`,
        sliceId: slice.id,
      });
    } else if (slice.preferredRunner && preferredWorker.backend.runner !== slice.preferredRunner) {
      warnings.push({
        code: "preferred_worker_incompatible",
        message: `Preferred worker ${slice.preferredWorkerId} uses ${preferredWorker.backend.runner}, not ${slice.preferredRunner}`,
        sliceId: slice.id,
      });
    } else {
      const fallbackWorkers = compatibleWorkers.filter(
        (worker) => worker.id !== preferredWorker.id,
      );
      return [
        {
          score: scoreWorkerForSlice(preferredWorker, slice, true),
          worker: preferredWorker,
        },
        ...sortCandidates(fallbackWorkers),
      ];
    }
  }

  if (compatibleWorkers.length === 0) {
    warnings.push({
      code: "no_worker_available",
      message: `No enabled worker is compatible with slice ${slice.id}`,
      sliceId: slice.id,
    });
    return [];
  }

  return sortCandidates(compatibleWorkers);
}

function scoreWorkerForSlice(
  worker: RegisteredWorker,
  slice: QuestSliceSpec,
  preferredWorker: boolean,
): number {
  const disciplineScore = worker.stats[disciplineToStatKey[slice.discipline]];
  const trustScore = worker.trust.rating * 100;
  const speedScore = worker.stats.speed * 0.35;
  const mergeScore = worker.stats.mergeSafety * 0.25;
  const contextScore = worker.stats.contextEndurance * 0.15;
  const resourcePenalty =
    worker.resources.cpuCost * 1.5 + worker.resources.memoryCost * 2 + worker.resources.gpuCost * 3;
  const preferredBonus = preferredWorker ? 15 : 0;

  return Number(
    (
      disciplineScore +
      trustScore +
      speedScore +
      mergeScore +
      contextScore +
      preferredBonus -
      resourcePenalty
    ).toFixed(2),
  );
}

function assertNoDependencyCycles(spec: QuestSpec): void {
  const remainingDependencies = new Map<string, Set<string>>();
  const reverseEdges = new Map<string, string[]>();

  spec.slices.forEach((slice) => {
    remainingDependencies.set(slice.id, new Set(slice.dependsOn));
    reverseEdges.set(slice.id, []);
  });

  spec.slices.forEach((slice) => {
    slice.dependsOn.forEach((dependencyId) => {
      const next = reverseEdges.get(dependencyId);
      if (!next) {
        throw new QuestDomainError({
          code: "quest_unknown_dependency",
          details: { dependencyId, sliceId: slice.id },
          message: `Unknown dependency ${dependencyId} referenced by ${slice.id}`,
        });
      }
      next.push(slice.id);
    });
  });

  const queue = [...remainingDependencies.entries()]
    .filter(([, dependencies]) => dependencies.size === 0)
    .map(([sliceId]) => sliceId);
  let visitedCount = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    visitedCount += 1;
    const dependents = reverseEdges.get(current) ?? [];

    for (const dependentId of dependents) {
      const dependencies = remainingDependencies.get(dependentId);
      if (!dependencies) {
        continue;
      }

      dependencies.delete(current);
      if (dependencies.size === 0) {
        queue.push(dependentId);
      }
    }
  }

  if (visitedCount !== spec.slices.length) {
    throw new QuestDomainError({
      code: "quest_dependency_cycle",
      details: { sliceIds: spec.slices.map((slice) => slice.id) },
      message: "Quest spec contains a dependency cycle",
    });
  }
}

function slicesConflict(left: QuestSliceSpec, right: QuestSliceSpec): boolean {
  return left.owns.some((leftPattern) =>
    right.owns.some((rightPattern) => patternsConflict(leftPattern, rightPattern)),
  );
}

function waveHasWorkerCapacity(
  workerUsage: Map<string, number>,
  assignment: WorkerAssignment | null,
): boolean {
  if (!assignment) {
    return true;
  }

  const used = workerUsage.get(assignment.worker.id) ?? 0;
  return used < assignment.worker.resources.maxParallel;
}

function selectWorkerForWave(
  candidates: WorkerAssignment[],
  workerUsage: Map<string, number>,
): WorkerAssignment | null {
  for (const candidate of candidates) {
    if (waveHasWorkerCapacity(workerUsage, candidate)) {
      return candidate;
    }
  }

  return null;
}

export function planQuest(spec: QuestSpec, workers: RegisteredWorker[]): QuestPlan {
  assertNoDependencyCycles(spec);

  const warnings: QuestPlanWarning[] = [];
  const assignments = new Map<string, WorkerAssignment[]>();
  const sliceMap = new Map(spec.slices.map((slice) => [slice.id, slice]));
  const unassigned = new Map<string, UnassignedQuestSlice>();
  const scheduled = new Set<string>();
  const waves: QuestPlanWave[] = [];

  spec.slices.forEach((slice) => {
    assignments.set(slice.id, buildWorkerCandidates(slice, workers, warnings));
  });

  while (scheduled.size + unassigned.size < spec.slices.length) {
    const availableSlices = spec.slices.filter((slice) => {
      if (scheduled.has(slice.id) || unassigned.has(slice.id)) {
        return false;
      }

      return slice.dependsOn.every((dependencyId) => scheduled.has(dependencyId));
    });

    if (availableSlices.length === 0) {
      const dependencyBlockedSlices = spec.slices.filter((slice) => {
        if (scheduled.has(slice.id) || unassigned.has(slice.id)) {
          return false;
        }

        return slice.dependsOn.some((dependencyId) => unassigned.has(dependencyId));
      });

      if (dependencyBlockedSlices.length > 0) {
        dependencyBlockedSlices.forEach((slice) => {
          const blockedDependencies = slice.dependsOn.filter((dependencyId) =>
            unassigned.has(dependencyId),
          );
          unassigned.set(slice.id, {
            dependsOn: slice.dependsOn,
            id: slice.id,
            message: `Slice depends on unassigned prerequisite(s): ${blockedDependencies.join(", ")}`,
            reasonCode: "dependency_blocked",
            title: slice.title,
          });
        });
        continue;
      }

      throw new QuestDomainError({
        code: "quest_dependency_cycle",
        details: { scheduled: [...scheduled] },
        message: "No schedulable slices remain; dependency graph is stuck",
      });
    }

    const waveIndex = waves.length + 1;
    const waveSlices: PlannedQuestSlice[] = [];
    const workerUsage = new Map<string, number>();

    for (const slice of availableSlices) {
      if (waveSlices.length >= spec.maxParallel) {
        break;
      }

      const assignment = selectWorkerForWave(assignments.get(slice.id) ?? [], workerUsage);

      if (!assignment) {
        continue;
      }

      const conflictsExistingWave = waveSlices.some((plannedSlice) => {
        const existingSlice = sliceMap.get(plannedSlice.id);
        return existingSlice ? slicesConflict(existingSlice, slice) : false;
      });

      if (conflictsExistingWave) {
        continue;
      }

      workerUsage.set(assignment.worker.id, (workerUsage.get(assignment.worker.id) ?? 0) + 1);

      waveSlices.push({
        assignedRunner: assignment.worker.backend.runner,
        assignedWorkerId: assignment.worker.id,
        conflictPaths: collectConflictPaths(slice, spec.slices, spec.hotspots),
        dependsOn: slice.dependsOn,
        hot: slice.owns.some((pattern) =>
          spec.hotspots.some((hotspot) => patternsConflict(pattern, hotspot)),
        ),
        id: slice.id,
        score: assignment.score,
        title: slice.title,
        wave: waveIndex,
      });
    }

    if (waveSlices.length === 0) {
      const workerlessSlices = availableSlices.filter(
        (slice) => (assignments.get(slice.id) ?? []).length === 0,
      );
      if (workerlessSlices.length > 0) {
        workerlessSlices.forEach((slice) => {
          unassigned.set(slice.id, {
            dependsOn: slice.dependsOn,
            id: slice.id,
            message: `No compatible enabled worker is available for slice ${slice.id}`,
            reasonCode: "no_worker_available",
            title: slice.title,
          });
        });
        continue;
      }

      throw new QuestDomainError({
        code: "invalid_quest_spec",
        details: {
          availableSliceIds: availableSlices.map((slice) => slice.id),
          scheduled: [...scheduled],
        },
        message: "Planner could not form a schedulable wave",
      });
    }

    waveSlices.forEach((slice) => {
      scheduled.add(slice.id);
    });
    waves.push({
      index: waveIndex,
      slices: waveSlices,
    });
  }

  return {
    maxParallel: spec.maxParallel,
    questTitle: spec.title,
    unassigned: spec.slices
      .map((slice) => unassigned.get(slice.id))
      .filter((slice): slice is UnassignedQuestSlice => slice !== undefined),
    warnings,
    waves,
    workspace: spec.workspace,
  };
}
