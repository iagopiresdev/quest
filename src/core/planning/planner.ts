import { QuestDomainError } from "../errors";
import { workerSupportsBuilderRole, workerSupportsTesterRole } from "../workers/management";
import type { RegisteredWorker, WorkerDiscipline } from "../workers/schema";
import type { QuestSliceSpec, QuestSpec } from "./spec-schema";

type QuestPlanWarningCode =
  | "ownership_conflict"
  | "preferred_worker_missing"
  | "preferred_worker_incompatible"
  | "preferred_tester_missing"
  | "preferred_tester_incompatible"
  | "no_tester_available"
  | "no_worker_available";

export type QuestPlanWarning = {
  code: QuestPlanWarningCode;
  message: string;
  paths?: string[];
  relatedSliceIds?: string[];
  sliceId: string;
};

export type PlannedQuestSlice = {
  assignedRunner: RegisteredWorker["backend"]["runner"];
  assignedTesterRunner: RegisteredWorker["backend"]["runner"];
  assignedTesterWorkerId: string;
  assignedWorkerId: string;
  conflictPaths: string[];
  dependsOn: string[];
  hot: boolean;
  id: string;
  score: number | null;
  testerScore: number | null;
  title: string;
  wave: number;
};

export type QuestPlanWave = {
  index: number;
  slices: PlannedQuestSlice[];
};

type UnassignedQuestSliceReasonCode =
  | "dependency_blocked"
  | "no_tester_available"
  | "no_worker_available";

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

export type WorkerAssignment = {
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

function collectPairConflictPaths(left: QuestSliceSpec, right: QuestSliceSpec): string[] {
  const conflicts = new Set<string>();

  for (const leftPattern of left.owns) {
    for (const rightPattern of right.owns) {
      if (!patternsConflict(leftPattern, rightPattern)) {
        continue;
      }

      conflicts.add(leftPattern);
      conflicts.add(rightPattern);
    }
  }

  return [...conflicts].sort();
}

function buildOwnershipConflictWarnings(spec: QuestSpec): QuestPlanWarning[] {
  const warnings: QuestPlanWarning[] = [];

  for (let index = 0; index < spec.slices.length; index += 1) {
    const left = spec.slices[index];
    if (!left) {
      continue;
    }

    for (let otherIndex = index + 1; otherIndex < spec.slices.length; otherIndex += 1) {
      const right = spec.slices[otherIndex];
      if (!right) {
        continue;
      }

      const conflictPaths = collectPairConflictPaths(left, right);
      if (conflictPaths.length === 0) {
        continue;
      }

      warnings.push({
        code: "ownership_conflict",
        message: `Slices ${left.id} and ${right.id} overlap on owned paths`,
        paths: conflictPaths,
        relatedSliceIds: [left.id, right.id],
        sliceId: left.id,
      });
    }
  }

  return warnings;
}

export function isBuilderCompatibleWithSlice(
  worker: RegisteredWorker,
  slice: QuestSliceSpec,
): boolean {
  if (!worker.enabled) {
    return false;
  }

  if (!workerSupportsBuilderRole(worker)) {
    return false;
  }

  if (slice.preferredRunner && worker.backend.runner !== slice.preferredRunner) {
    return false;
  }

  return true;
}

export function isTesterCompatibleWithSlice(
  worker: RegisteredWorker,
  slice: QuestSliceSpec,
): boolean {
  if (!worker.enabled) {
    return false;
  }

  if (!workerSupportsTesterRole(worker)) {
    return false;
  }

  if (slice.preferredTesterRunner && worker.backend.runner !== slice.preferredTesterRunner) {
    return false;
  }

  return true;
}

export function scoreBuilderWorkerForSlice(
  worker: RegisteredWorker,
  slice: QuestSliceSpec,
  preferredWorker: boolean,
): number {
  const trustScore = worker.trust.rating * 100;
  const resourcePenalty =
    worker.resources.cpuCost * 1.5 + worker.resources.memoryCost * 2 + worker.resources.gpuCost * 3;
  const preferredBonus = preferredWorker ? 15 : 0;
  const disciplineScore = worker.stats[disciplineToStatKey[slice.discipline]];
  const speedScore = worker.stats.speed * 0.35;
  const mergeScore = worker.stats.mergeSafety * 0.25;
  const contextScore = worker.stats.contextEndurance * 0.15;

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

export function scoreTesterWorkerForSlice(
  worker: RegisteredWorker,
  preferredWorker: boolean,
  builderWorkerId?: string | undefined,
): number {
  const trustScore = worker.trust.rating * 100;
  const resourcePenalty =
    worker.resources.cpuCost * 1.5 + worker.resources.memoryCost * 2 + worker.resources.gpuCost * 3;
  const preferredBonus = preferredWorker ? 15 : 0;
  const testingScore = worker.stats.testing;
  const mergeScore = worker.stats.mergeSafety * 0.45;
  const contextScore = worker.stats.contextEndurance * 0.2;
  const speedScore = worker.stats.speed * 0.15;
  const independenceBonus = builderWorkerId && worker.id !== builderWorkerId ? 10 : 0;

  return Number(
    (
      testingScore +
      trustScore +
      mergeScore +
      contextScore +
      speedScore +
      preferredBonus +
      independenceBonus -
      resourcePenalty
    ).toFixed(2),
  );
}

export function rankWorkersForSlice(
  slice: QuestSliceSpec,
  workers: RegisteredWorker[],
): WorkerAssignment[] {
  return [...workers]
    .filter((worker) => isBuilderCompatibleWithSlice(worker, slice))
    .sort(
      (left, right) =>
        scoreBuilderWorkerForSlice(right, slice, false) -
        scoreBuilderWorkerForSlice(left, slice, false),
    )
    .map((worker) => ({
      score: scoreBuilderWorkerForSlice(worker, slice, false),
      worker,
    }));
}

export function rankTesterWorkersForSlice(
  slice: QuestSliceSpec,
  workers: RegisteredWorker[],
  builderWorkerId?: string | undefined,
): WorkerAssignment[] {
  return [...workers]
    .filter((worker) => isTesterCompatibleWithSlice(worker, slice))
    .sort(
      (left, right) =>
        scoreTesterWorkerForSlice(right, false, builderWorkerId) -
        scoreTesterWorkerForSlice(left, false, builderWorkerId),
    )
    .map((worker) => ({
      score: scoreTesterWorkerForSlice(worker, false, builderWorkerId),
      worker,
    }));
}

function buildBuilderCandidates(
  slice: QuestSliceSpec,
  workers: RegisteredWorker[],
  warnings: QuestPlanWarning[],
): WorkerAssignment[] {
  const enabledWorkers = workers.filter((worker) => worker.enabled);
  const compatibleWorkers = enabledWorkers.filter((worker) =>
    isBuilderCompatibleWithSlice(worker, slice),
  );

  if (slice.preferredWorkerId) {
    const preferredWorker = enabledWorkers.find((worker) => worker.id === slice.preferredWorkerId);
    if (!preferredWorker) {
      warnings.push({
        code: "preferred_worker_missing",
        message: `Preferred builder ${slice.preferredWorkerId} is not registered or enabled`,
        sliceId: slice.id,
      });
    } else if (slice.preferredRunner && preferredWorker.backend.runner !== slice.preferredRunner) {
      warnings.push({
        code: "preferred_worker_incompatible",
        message: `Preferred builder ${slice.preferredWorkerId} uses ${preferredWorker.backend.runner}, not ${slice.preferredRunner}`,
        sliceId: slice.id,
      });
    } else {
      const fallbackWorkers = compatibleWorkers.filter(
        (worker) => worker.id !== preferredWorker.id,
      );
      return [
        {
          score: scoreBuilderWorkerForSlice(preferredWorker, slice, true),
          worker: preferredWorker,
        },
        ...rankWorkersForSlice(slice, fallbackWorkers),
      ];
    }
  }

  if (compatibleWorkers.length === 0) {
    warnings.push({
      code: "no_worker_available",
      message: `No enabled builder is compatible with slice ${slice.id}`,
      sliceId: slice.id,
    });
    return [];
  }

  return rankWorkersForSlice(slice, compatibleWorkers);
}

function buildTesterCandidates(
  slice: QuestSliceSpec,
  workers: RegisteredWorker[],
  warnings: QuestPlanWarning[],
  builderWorkerId: string,
): WorkerAssignment[] {
  const enabledWorkers = workers.filter((worker) => worker.enabled);
  const compatibleWorkers = enabledWorkers.filter((worker) =>
    isTesterCompatibleWithSlice(worker, slice),
  );

  if (slice.preferredTesterWorkerId) {
    const preferredWorker = enabledWorkers.find(
      (worker) => worker.id === slice.preferredTesterWorkerId,
    );
    if (!preferredWorker) {
      warnings.push({
        code: "preferred_tester_missing",
        message: `Preferred tester ${slice.preferredTesterWorkerId} is not registered or enabled`,
        sliceId: slice.id,
      });
    } else if (
      slice.preferredTesterRunner &&
      preferredWorker.backend.runner !== slice.preferredTesterRunner
    ) {
      warnings.push({
        code: "preferred_tester_incompatible",
        message: `Preferred tester ${slice.preferredTesterWorkerId} uses ${preferredWorker.backend.runner}, not ${slice.preferredTesterRunner}`,
        sliceId: slice.id,
      });
    } else {
      const fallbackWorkers = compatibleWorkers.filter(
        (worker) => worker.id !== preferredWorker.id,
      );
      return [
        {
          score: scoreTesterWorkerForSlice(preferredWorker, true, builderWorkerId),
          worker: preferredWorker,
        },
        ...rankTesterWorkersForSlice(slice, fallbackWorkers, builderWorkerId),
      ];
    }
  }

  if (compatibleWorkers.length === 0) {
    warnings.push({
      code: "no_tester_available",
      message: `No enabled tester is compatible with slice ${slice.id}`,
      sliceId: slice.id,
    });
    return [];
  }

  return rankTesterWorkersForSlice(slice, compatibleWorkers, builderWorkerId);
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

function findAvailableSlices(
  spec: QuestSpec,
  scheduled: Set<string>,
  unassigned: Map<string, UnassignedQuestSlice>,
): QuestSliceSpec[] {
  return spec.slices.filter((slice) => {
    if (scheduled.has(slice.id) || unassigned.has(slice.id)) {
      return false;
    }

    return slice.dependsOn.every((dependencyId) => scheduled.has(dependencyId));
  });
}

function markDependencyBlockedSlices(
  spec: QuestSpec,
  scheduled: Set<string>,
  unassigned: Map<string, UnassignedQuestSlice>,
): boolean {
  const dependencyBlockedSlices = spec.slices.filter((slice) => {
    if (scheduled.has(slice.id) || unassigned.has(slice.id)) {
      return false;
    }

    return slice.dependsOn.some((dependencyId) => unassigned.has(dependencyId));
  });

  if (dependencyBlockedSlices.length === 0) {
    return false;
  }

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

  return true;
}

function buildPlannedWaveSlice(
  slice: QuestSliceSpec,
  spec: QuestSpec,
  workers: RegisteredWorker[],
  warnings: QuestPlanWarning[],
  assignment: WorkerAssignment,
  waveIndex: number,
): PlannedQuestSlice | null {
  const testerAssignments = buildTesterCandidates(slice, workers, warnings, assignment.worker.id);
  const testerAssignment =
    testerAssignments.find((candidate) => candidate.worker.id !== assignment.worker.id) ??
    testerAssignments[0] ??
    null;

  if (!testerAssignment) {
    return null;
  }

  return {
    assignedRunner: assignment.worker.backend.runner,
    assignedTesterRunner: testerAssignment.worker.backend.runner,
    assignedTesterWorkerId: testerAssignment.worker.id,
    assignedWorkerId: assignment.worker.id,
    conflictPaths: collectConflictPaths(slice, spec.slices, spec.hotspots),
    dependsOn: slice.dependsOn,
    hot: slice.owns.some((pattern) =>
      spec.hotspots.some((hotspot) => patternsConflict(pattern, hotspot)),
    ),
    id: slice.id,
    score: assignment.score,
    testerScore: testerAssignment.score,
    title: slice.title,
    wave: waveIndex,
  };
}

function markWorkerlessSlices(
  availableSlices: QuestSliceSpec[],
  builderAssignments: Map<string, WorkerAssignment[]>,
  unassigned: Map<string, UnassignedQuestSlice>,
): boolean {
  const workerlessSlices = availableSlices.filter(
    (slice) => (builderAssignments.get(slice.id) ?? []).length === 0,
  );
  if (workerlessSlices.length === 0) {
    return false;
  }

  workerlessSlices.forEach((slice) => {
    unassigned.set(slice.id, {
      dependsOn: slice.dependsOn,
      id: slice.id,
      message: `No compatible enabled worker is available for slice ${slice.id}`,
      reasonCode: "no_worker_available",
      title: slice.title,
    });
  });

  return true;
}

function buildWaveSlices(
  spec: QuestSpec,
  workers: RegisteredWorker[],
  warnings: QuestPlanWarning[],
  availableSlices: QuestSliceSpec[],
  builderAssignments: Map<string, WorkerAssignment[]>,
  sliceMap: Map<string, QuestSliceSpec>,
  unassigned: Map<string, UnassignedQuestSlice>,
  waveIndex: number,
): PlannedQuestSlice[] {
  const waveSlices: PlannedQuestSlice[] = [];
  const workerUsage = new Map<string, number>();

  for (const slice of availableSlices) {
    if (waveSlices.length >= spec.maxParallel) {
      break;
    }

    const assignment = selectWorkerForWave(builderAssignments.get(slice.id) ?? [], workerUsage);
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

    const plannedSlice = buildPlannedWaveSlice(
      slice,
      spec,
      workers,
      warnings,
      assignment,
      waveIndex,
    );
    if (!plannedSlice) {
      unassigned.set(slice.id, {
        dependsOn: slice.dependsOn,
        id: slice.id,
        message: `No compatible enabled tester is available for slice ${slice.id}`,
        reasonCode: "no_tester_available",
        title: slice.title,
      });
      continue;
    }

    workerUsage.set(assignment.worker.id, (workerUsage.get(assignment.worker.id) ?? 0) + 1);
    waveSlices.push(plannedSlice);
  }

  return waveSlices;
}

export function planQuest(spec: QuestSpec, workers: RegisteredWorker[]): QuestPlan {
  assertNoDependencyCycles(spec);

  const warnings: QuestPlanWarning[] = buildOwnershipConflictWarnings(spec);
  const builderAssignments = new Map<string, WorkerAssignment[]>();
  const sliceMap = new Map(spec.slices.map((slice) => [slice.id, slice]));
  const unassigned = new Map<string, UnassignedQuestSlice>();
  const scheduled = new Set<string>();
  const waves: QuestPlanWave[] = [];

  spec.slices.forEach((slice) => {
    builderAssignments.set(slice.id, buildBuilderCandidates(slice, workers, warnings));
  });

  while (scheduled.size + unassigned.size < spec.slices.length) {
    const availableSlices = findAvailableSlices(spec, scheduled, unassigned);

    if (availableSlices.length === 0) {
      if (markDependencyBlockedSlices(spec, scheduled, unassigned)) {
        continue;
      }

      throw new QuestDomainError({
        code: "quest_dependency_cycle",
        details: { scheduled: [...scheduled] },
        message: "No schedulable slices remain; dependency graph is stuck",
      });
    }

    const waveIndex = waves.length + 1;
    const waveSlices = buildWaveSlices(
      spec,
      workers,
      warnings,
      availableSlices,
      builderAssignments,
      sliceMap,
      unassigned,
      waveIndex,
    );

    if (waveSlices.length === 0) {
      if (markWorkerlessSlices(availableSlices, builderAssignments, unassigned)) {
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
