import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { QuestDomainError } from "../errors";
import { type QuestSliceSpec, type QuestSpec, questSpecSchema } from "../planning/spec-schema";
import type { QuestRunExecutor } from "../runs/executor";
import { runSubprocess } from "../runs/process";
import { buildProcessEnv } from "../runs/process-env";
import type { QuestRunDocument } from "../runs/schema";
import type { QuestRunStore } from "../runs/store";
import { ensureDirectory } from "../storage";
import type { WorkerRegistry } from "./registry";
import type {
  RegisteredWorker,
  WorkerCalibrationRecord,
  WorkerCalibrationSuite,
  WorkerDiscipline,
} from "./schema";

type CalibrationFixture = {
  repositoryPath: string;
  workspacePath: string;
};

type CalibrationSuiteDefinition = {
  description: string;
  displayName: string;
  id: WorkerCalibrationSuite;
  createFixture(root: string): Promise<CalibrationFixture>;
  spec: QuestSpec;
};

export type WorkerCalibrationResult = {
  calibration: WorkerCalibrationRecord;
  fixtureRepositoryPath: string;
  run: QuestRunDocument;
  suite: {
    description: string;
    displayName: string;
    id: WorkerCalibrationSuite;
  };
  worker: RegisteredWorker;
};

function createCalibrationId(suiteId: WorkerCalibrationSuite): string {
  const timePart = Date.now().toString(36).slice(-8).padStart(8, "0");
  const randomPart = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${suiteId}-${timePart}-${randomPart}`;
}

async function writeFixtureFile(path: string, content: string): Promise<void> {
  await ensureDirectory(dirname(path));
  await Bun.write(path, content);
}

async function runCheckedSubprocess(
  cmd: string[],
  cwd: string,
  errorMessage: string,
  details: Record<string, unknown>,
): Promise<void> {
  const result = await runSubprocess({
    cmd,
    cwd,
    env: buildProcessEnv(),
    timeoutMs: 30_000,
  });

  if (result.exitCode !== 0) {
    throw new QuestDomainError({
      code: "quest_workspace_materialization_failed",
      details: {
        ...details,
        cmd,
        cwd,
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
      },
      message: errorMessage,
      statusCode: 1,
    });
  }
}

function createCalibrationCommand(code: string): { argv: string[]; env: Record<string, string> } {
  return {
    argv: ["bun", "-e", code],
    env: {},
  };
}

async function createTrainingGroundsFixture(root: string): Promise<CalibrationFixture> {
  const workspacePath = resolve(root, "training-grounds");
  const repositoryPath = join(workspacePath, "repo");

  await mkdir(join(repositoryPath, "src"), { recursive: true });
  await mkdir(join(repositoryPath, "test"), { recursive: true });

  await writeFixtureFile(
    join(repositoryPath, "package.json"),
    JSON.stringify(
      {
        name: "quest-runner-training-grounds",
        private: true,
        type: "module",
      },
      null,
      2,
    ),
  );
  await writeFixtureFile(
    join(repositoryPath, "src", "sum.ts"),
    ["export function sum(a: number, b: number): number {", "  return a + b + 1;", "}", ""].join(
      "\n",
    ),
  );
  await writeFixtureFile(
    join(repositoryPath, "test", "sum.test.ts"),
    [
      'import { expect, test } from "bun:test";',
      "",
      'import { sum } from "../src/sum";',
      "",
      'test("sum adds positive numbers", () => {',
      "  expect(sum(2, 3)).toBe(5);",
      "});",
      "",
    ].join("\n"),
  );
  await writeFixtureFile(
    join(repositoryPath, "src", "echo.ts"),
    ["export function echo(value: string): string {", "  return value;", "}", ""].join("\n"),
  );
  await writeFixtureFile(
    join(repositoryPath, "test", "echo.test.ts"),
    [
      'import { expect, test } from "bun:test";',
      "",
      'import { echo } from "../src/echo";',
      "",
      'test("echo returns the original value", () => {',
      '  expect(echo("quest")).toBe("quest");',
      "});",
      "",
    ].join("\n"),
  );
  await writeFixtureFile(
    join(repositoryPath, "README.md"),
    ["# Training Grounds", "", "The `sum(a, b)` helper currently returns a noisy value.", ""].join(
      "\n",
    ),
  );

  await runCheckedSubprocess(
    ["git", "init"],
    repositoryPath,
    "Failed to initialize the calibration fixture repository",
    { repositoryPath },
  );
  await runCheckedSubprocess(
    ["git", "config", "user.name", "Quest Runner Calibration"],
    repositoryPath,
    "Failed to configure the calibration fixture repository",
    { repositoryPath },
  );
  await runCheckedSubprocess(
    ["git", "config", "user.email", "quest-runner-calibration@example.com"],
    repositoryPath,
    "Failed to configure the calibration fixture repository",
    { repositoryPath },
  );
  await runCheckedSubprocess(
    ["git", "add", "."],
    repositoryPath,
    "Failed to stage the calibration fixture repository",
    { repositoryPath },
  );
  await runCheckedSubprocess(
    ["git", "commit", "-m", "Initial training grounds state"],
    repositoryPath,
    "Failed to snapshot the calibration fixture repository",
    { repositoryPath },
  );

  return {
    repositoryPath,
    workspacePath,
  };
}

const trainingGroundsSuite: CalibrationSuiteDefinition = {
  description:
    "A throwaway three-slice quest that measures coding, testing, and docs discipline on a small repo.",
  displayName: "Training Grounds",
  id: "training-grounds-v1",
  createFixture: createTrainingGroundsFixture,
  spec: questSpecSchema.parse({
    acceptanceChecks: [],
    featureDoc: { enabled: false },
    hotspots: [],
    maxParallel: 1,
    slices: [
      {
        acceptanceChecks: [{ argv: ["bun", "test", "test/sum.test.ts"], env: {} }],
        contextHints: ["Read the failing test before editing the implementation."],
        dependsOn: [],
        discipline: "coding",
        goal: "Fix src/sum.ts so sum(a, b) returns the exact arithmetic sum without adding one.",
        id: "fix-sum",
        owns: ["src/sum.ts"],
        title: "Repair sum implementation",
      },
      {
        acceptanceChecks: [
          { argv: ["bun", "test", "test/echo.test.ts"], env: {} },
          createCalibrationCommand(
            'const text = await Bun.file("test/echo.test.ts").text(); if (!text.includes("echo(\\"\\")")) { throw new Error("missing empty echo regression test"); }',
          ),
        ],
        contextHints: ["Preserve the existing test style."],
        dependsOn: [],
        discipline: "testing",
        goal: 'Add a regression test for echo("") in test/echo.test.ts.',
        id: "add-empty-echo-test",
        owns: ["test/echo.test.ts"],
        title: "Add empty echo regression test",
      },
      {
        acceptanceChecks: [
          createCalibrationCommand(
            'const text = await Bun.file("README.md").text(); if (!text.includes("exact arithmetic sum")) { throw new Error("README not updated"); }',
          ),
        ],
        contextHints: ["Keep the README concise."],
        dependsOn: [],
        discipline: "docs",
        goal: "Update README.md to say that sum(a, b) returns the exact arithmetic sum.",
        id: "update-readme",
        owns: ["README.md"],
        title: "Update README",
      },
    ] satisfies QuestSliceSpec[],
    summary: "Throwaway calibration quest for a single worker.",
    title: "Training Grounds Calibration",
    version: 1,
    workspace: "training-grounds",
  }),
};

const calibrationSuites = new Map<WorkerCalibrationSuite, CalibrationSuiteDefinition>([
  [trainingGroundsSuite.id, trainingGroundsSuite],
]);

function getCalibrationSuite(suiteId: WorkerCalibrationSuite): CalibrationSuiteDefinition {
  const suite = calibrationSuites.get(suiteId);
  if (!suite) {
    throw new QuestDomainError({
      code: "invalid_quest_spec",
      details: { suiteId },
      message: `Calibration suite ${suiteId} is not defined`,
      statusCode: 1,
    });
  }

  return suite;
}

function computeSliceScore(
  run: QuestRunDocument,
  sliceState: QuestRunDocument["slices"][number],
): { checkCount: number; passedCheckCount: number; score: number } {
  const sliceSpec = run.spec.slices.find((slice) => slice.id === sliceState.sliceId);
  const totalCheckCount = sliceSpec?.acceptanceChecks.length ?? 0;
  const passedCheckCount =
    sliceState.lastChecks?.filter((check) => check.exitCode === 0).length ?? 0;
  const completionScore = sliceState.status === "completed" ? 70 : 0;
  const validationScore =
    totalCheckCount === 0
      ? sliceState.status === "completed"
        ? 30
        : 0
      : Math.round((passedCheckCount / totalCheckCount) * 30);

  return {
    checkCount: totalCheckCount,
    passedCheckCount,
    score: completionScore + validationScore,
  };
}

function buildCalibrationRecord(
  run: QuestRunDocument,
  suiteId: WorkerCalibrationSuite,
): WorkerCalibrationRecord {
  const disciplineBuckets = new Map<WorkerDiscipline, number[]>();
  const totalSliceCount = run.spec.slices.length;
  let completedSliceCount = 0;
  let totalCheckCount = 0;
  let passedCheckCount = 0;
  let totalScore = 0;

  for (const sliceSpec of run.spec.slices) {
    const sliceState = run.slices.find((slice) => slice.sliceId === sliceSpec.id);
    if (!sliceState) {
      continue;
    }

    const sliceScore = computeSliceScore(run, sliceState);
    if (sliceState.status === "completed") {
      completedSliceCount += 1;
    }

    totalCheckCount += sliceScore.checkCount;
    passedCheckCount += sliceScore.passedCheckCount;
    totalScore += sliceScore.score;

    const existingScores = disciplineBuckets.get(sliceSpec.discipline) ?? [];
    existingScores.push(sliceScore.score);
    disciplineBuckets.set(sliceSpec.discipline, existingScores);
  }

  const score = totalSliceCount === 0 ? 0 : Math.round(totalScore / totalSliceCount);
  const disciplineScores = Object.fromEntries(
    Array.from(disciplineBuckets.entries()).map(([discipline, scores]) => [
      discipline,
      Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length),
    ]),
  ) as Partial<Record<WorkerDiscipline, number>>;
  const checkPassRate = totalCheckCount === 0 ? 1 : passedCheckCount / totalCheckCount;
  const status = run.status === "completed" && score >= 80 ? "passed" : "failed";
  const xpAwarded = status === "passed" ? 100 + score : 0;

  return {
    at: new Date().toISOString(),
    checkPassRate,
    completedSliceCount,
    disciplineScores,
    passedCheckCount,
    runId: run.id,
    score,
    status,
    suiteId,
    totalCheckCount,
    totalSliceCount,
    workspacePath: run.workspaceRoot ?? "",
    xpAwarded,
  };
}

function applyCalibrationResult(
  worker: RegisteredWorker,
  record: WorkerCalibrationRecord,
): RegisteredWorker {
  const nextTrustRating = Number(
    (worker.trust.rating * 0.6 + (record.score / 100) * 0.4).toFixed(3),
  );
  const nextXp = worker.progression.xp + record.xpAwarded;
  const nextLevel = Math.min(99, Math.max(worker.progression.level, Math.floor(nextXp / 500) + 1));

  return {
    ...worker,
    calibration: {
      history: [record, ...worker.calibration.history].slice(0, 16),
    },
    progression: {
      level: nextLevel,
      xp: nextXp,
    },
    trust: {
      calibratedAt: record.at,
      rating: nextTrustRating,
    },
  };
}

export function listCalibrationSuites(): Array<{
  description: string;
  displayName: string;
  id: WorkerCalibrationSuite;
}> {
  return Array.from(calibrationSuites.values()).map((suite) => ({
    description: suite.description,
    displayName: suite.displayName,
    id: suite.id,
  }));
}

export class WorkerCalibrator {
  constructor(
    private readonly workerRegistry: WorkerRegistry,
    private readonly runStore: QuestRunStore,
    private readonly runExecutor: QuestRunExecutor,
    private readonly calibrationsRoot: string,
  ) {}

  async calibrateWorker(
    workerId: string,
    options: {
      dryRun?: boolean;
      suiteId?: WorkerCalibrationSuite;
    } = {},
  ): Promise<WorkerCalibrationResult> {
    const suiteId = options.suiteId ?? "training-grounds-v1";
    const suite = getCalibrationSuite(suiteId);
    const worker = await this.workerRegistry.getWorker(workerId);
    const calibrationRoot = resolve(this.calibrationsRoot, createCalibrationId(suite.id));

    // Calibration fixtures are persisted under their own root so failed runs stay inspectable
    // without contaminating the normal quest workspace tree.
    await ensureDirectory(calibrationRoot);
    const fixture = await suite.createFixture(calibrationRoot);
    const createdRun = await this.runStore.createRun(suite.spec, [worker], {
      sourceRepositoryPath: fixture.repositoryPath,
    });

    let executedRun: QuestRunDocument;
    try {
      executedRun = await this.runExecutor.executeRun(createdRun.id, {
        dryRun: options.dryRun === true,
        sourceRepositoryPath: fixture.repositoryPath,
      });
    } catch {
      executedRun = await this.runStore.getRun(createdRun.id);
    }

    const calibration = buildCalibrationRecord(executedRun, suite.id);
    const updatedWorker = applyCalibrationResult(worker, calibration);
    await this.workerRegistry.upsertWorker(updatedWorker);

    return {
      calibration,
      fixtureRepositoryPath: fixture.repositoryPath,
      run: executedRun,
      suite: {
        description: suite.description,
        displayName: suite.displayName,
        id: suite.id,
      },
      worker: updatedWorker,
    };
  }
}
