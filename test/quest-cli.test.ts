import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CliTestContext,
  cleanupTempRoot,
  createCalibrationCommandScript,
  createCliContext,
  createCodexMockExecutable,
  createCommand,
  createCommittedRepo,
  createLocalCommandWorkerJson,
  createSlice,
  createSpec,
  createWorkerJson,
  runCli,
  runCliAsync,
} from "./helpers";

const activeContexts: CliTestContext[] = [];

function trackContext(): CliTestContext {
  const context = createCliContext();
  activeContexts.push(context);
  return context;
}

afterEach(() => {
  while (activeContexts.length > 0) {
    const context = activeContexts.pop();
    if (context) {
      cleanupTempRoot(context.stateRoot);
    }
  }
});

function expectWorkerUpserted(context: CliTestContext, workerJson = createWorkerJson()): void {
  expect(runCli(context, ["workers", "upsert", "--stdin"], { input: workerJson }).code).toBe(0);
}

test("quest cli upserts, lists, and plans from stdin", () => {
  const context = trackContext();

  const upsert = runCli(context, ["workers", "upsert", "--stdin"], {
    input: createWorkerJson(),
  });
  expect(upsert.code).toBe(0);
  expect(JSON.parse(upsert.stdout).worker.id).toBe("ember");

  const listed = runCli(context, ["workers", "list"]);
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.stdout).workers.length).toBe(1);

  const plan = runCli(context, ["plan", "--stdin"], {
    input: JSON.stringify(
      createSpec({
        acceptanceChecks: [createCommand(["npm", "test"])],
        featureDoc: { enabled: true, outputPath: "docs/features/ssrf-protection.md" },
        maxParallel: 2,
        slices: [
          createSlice({
            goal: "Implement SSRF parser validation",
            id: "parser",
            title: "Parser",
          }),
          createSlice({
            discipline: "docs",
            goal: "Draft feature notes",
            id: "docs",
            owns: ["docs/features/**"],
            title: "Docs",
          }),
        ],
        title: "Add SSRF protection",
      }),
    ),
  });

  expect(plan.code).toBe(0);
  const planned = JSON.parse(plan.stdout).plan;
  expect(
    planned.waves.map((wave: { slices: Array<{ id: string }> }) =>
      wave.slices.map((slice) => slice.id),
    ),
  ).toEqual([["parser"], ["docs"]]);
  expect(planned.unassigned).toEqual([]);
});

test("quest cli adds a codex worker from flags", () => {
  const context = trackContext();

  const added = runCli(context, [
    "workers",
    "add",
    "codex",
    "--name",
    "Quest Codex",
    "--profile",
    "gpt-5.4-mini",
    "--auth-mode",
    "native-login",
  ]);

  expect(added.code).toBe(0);
  const worker = JSON.parse(added.stdout).worker;
  expect(worker.id).toBe("quest-codex");
  expect(worker.backend.adapter).toBe("codex-cli");
  expect(worker.backend.profile).toBe("gpt-5.4-mini");
  expect(worker.backend.auth.mode).toBe("native-login");

  const listed = runCli(context, ["workers", "list"]);
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.stdout).workers).toHaveLength(1);
});

test("quest cli setup bootstraps a codex worker from detected tooling", () => {
  const context = trackContext();
  const codexExecutable = createCodexMockExecutable(context.stateRoot);

  const setup = runCli(context, [
    "setup",
    "--yes",
    "--codex-executable",
    codexExecutable,
    "--worker-name",
    "Quest Codex",
    "--profile",
    "gpt-5.4-mini",
  ]);

  expect(setup.code).toBe(0);
  const result = JSON.parse(setup.stdout);
  expect(result.doctor.ok).toBe(true);
  expect(result.createdWorker.id).toBe("quest-codex");
  expect(result.createdWorker.backend.adapter).toBe("codex-cli");
  expect(result.workers).toHaveLength(1);
});

test("quest cli can force planning and runs to a specific worker", () => {
  const context = trackContext();

  expect(
    runCli(context, ["workers", "upsert", "--stdin"], {
      input: createWorkerJson({ id: "ember", name: "Ember" }),
    }).code,
  ).toBe(0);
  expect(
    runCli(context, ["workers", "upsert", "--stdin"], {
      input: createWorkerJson({
        id: "rook",
        name: "Rook",
        trust: { calibratedAt: "2026-04-11T00:00:00Z", rating: 0.2 },
      }),
    }).code,
  ).toBe(0);

  const plan = runCli(context, ["plan", "--worker-id", "rook", "--stdin"], {
    input: JSON.stringify(createSpec({ title: "Forced worker plan" })),
  });
  expect(plan.code).toBe(0);
  expect(JSON.parse(plan.stdout).plan.waves[0].slices[0].assignedWorkerId).toBe("rook");

  const run = runCli(context, ["run", "--worker-id", "rook", "--stdin"], {
    input: JSON.stringify(createSpec({ title: "Forced worker run" })),
  });
  expect(run.code).toBe(0);
  const createdRun = JSON.parse(run.stdout).run;
  expect(createdRun.plan.waves[0].slices[0].assignedWorkerId).toBe("rook");
  expect(createdRun.spec.slices[0].preferredWorkerId).toBe("rook");
  expect(createdRun.events[0].details.forcedWorkerId).toBe("rook");
});

test("quest cli configures webhook sinks and delivers run events", async () => {
  const context = trackContext();
  const receivedEvents: Array<{ eventId: string; eventType: string; kind: string }> = [];
  const server = Bun.serve({
    fetch: async (request) => {
      receivedEvents.push(
        (await request.json()) as { eventId: string; eventType: string; kind: string },
      );
      return new Response("ok");
    },
    port: 0,
  });

  try {
    const upsertSink = await runCliAsync(context, [
      "observability",
      "webhook",
      "upsert",
      "--id",
      "local-webhook",
      "--url",
      `http://127.0.0.1:${server.port}/events`,
      "--events",
      "run_created,run_started,run_completed",
    ]);
    expect(upsertSink.code).toBe(0);

    const listed = await runCliAsync(context, ["observability", "sinks", "list"]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout).sinks).toHaveLength(1);

    expectWorkerUpserted(context);
    const created = await runCliAsync(context, ["run", "--stdin"], {
      input: JSON.stringify(createSpec({ title: "Observed run" })),
    });
    expect(created.code).toBe(0);
    const runId = JSON.parse(created.stdout).run.id as string;

    const executed = await runCliAsync(context, ["runs", "execute", "--id", runId, "--dry-run"]);
    expect(executed.code).toBe(0);

    const events = await runCliAsync(context, [
      "observability",
      "events",
      "list",
      "--run-id",
      runId,
    ]);
    expect(events.code).toBe(0);
    expect(
      JSON.parse(events.stdout).events.map((event: { eventType: string }) => event.eventType),
    ).toEqual(["run_created", "run_started", "slice_started", "slice_completed", "run_completed"]);

    expect(receivedEvents.map((event) => event.eventType)).toEqual([
      "run_created",
      "run_started",
      "run_completed",
    ]);

    const deleted = await runCliAsync(context, [
      "observability",
      "sinks",
      "delete",
      "--id",
      "local-webhook",
    ]);
    expect(deleted.code).toBe(0);
    expect(JSON.parse(deleted.stdout)).toMatchObject({ deleted: "local-webhook", ok: true });
  } finally {
    server.stop(true);
  }
});

test("quest cli lists and retries failed webhook deliveries", async () => {
  const context = trackContext();
  let shouldFail = true;
  const receivedEvents: string[] = [];
  const server = Bun.serve({
    fetch: async (request) => {
      const payload = (await request.json()) as { eventType: string };
      receivedEvents.push(payload.eventType);
      return shouldFail ? new Response("nope", { status: 500 }) : new Response("ok");
    },
    port: 0,
  });

  try {
    const sink = await runCliAsync(context, [
      "observability",
      "webhook",
      "upsert",
      "--id",
      "retry-webhook",
      "--url",
      `http://127.0.0.1:${server.port}/events`,
      "--events",
      "run_created,run_started,run_completed",
    ]);
    expect(sink.code).toBe(0);

    expectWorkerUpserted(context);
    const created = await runCliAsync(context, ["run", "--stdin"], {
      input: JSON.stringify(createSpec({ title: "Retry observed run" })),
    });
    expect(created.code).toBe(0);
    const runId = JSON.parse(created.stdout).run.id as string;

    const executed = await runCliAsync(context, ["runs", "execute", "--id", runId, "--dry-run"]);
    expect(executed.code).toBe(0);

    const failedDeliveries = await runCliAsync(context, [
      "observability",
      "deliveries",
      "list",
      "--sink-id",
      "retry-webhook",
      "--status",
      "failed",
    ]);
    expect(failedDeliveries.code).toBe(0);
    const records = JSON.parse(failedDeliveries.stdout).deliveries as Array<{
      attempts: number;
      eventType: string;
      payload: { runId: string };
      status: string;
    }>;
    expect(records).toHaveLength(3);
    expect(records.map((record) => record.eventType).sort()).toEqual([
      "run_completed",
      "run_created",
      "run_started",
    ]);
    expect(new Set(records.map((record) => record.payload.runId))).toEqual(new Set([runId]));

    shouldFail = false;

    const retried = await runCliAsync(context, [
      "observability",
      "deliveries",
      "retry",
      "--sink-id",
      "retry-webhook",
      "--status",
      "failed",
    ]);
    expect(retried.code).toBe(0);
    expect(JSON.parse(retried.stdout).attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "run_completed", ok: true, status: "delivered" }),
        expect.objectContaining({ eventType: "run_started", ok: true, status: "delivered" }),
        expect.objectContaining({ eventType: "run_created", ok: true, status: "delivered" }),
      ]),
    );

    const delivered = await runCliAsync(context, [
      "observability",
      "deliveries",
      "list",
      "--sink-id",
      "retry-webhook",
      "--status",
      "delivered",
      "--run-id",
      runId,
    ]);
    expect(delivered.code).toBe(0);
    const deliveredRecords = JSON.parse(delivered.stdout).deliveries as Array<{
      attempts: number;
      lastError?: string;
      status: string;
    }>;
    expect(deliveredRecords).toHaveLength(3);
    expect(deliveredRecords.every((record) => record.attempts === 2)).toBe(true);
    expect(deliveredRecords.every((record) => record.lastError === undefined)).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("quest cli calibrates a worker through the training grounds suite", () => {
  const context = trackContext();
  const scriptPath = createCalibrationCommandScript(context.stateRoot);

  const upsert = runCli(context, ["workers", "upsert", "--stdin"], {
    input: createLocalCommandWorkerJson("sparrow", ["bun", scriptPath]),
  });
  expect(upsert.code).toBe(0);

  const calibrated = runCli(context, ["workers", "calibrate", "--id", "sparrow"]);
  expect(calibrated.code).toBe(0);
  const result = JSON.parse(calibrated.stdout).result;
  expect(result.calibration.suiteId).toBe("training-grounds-v1");
  expect(result.calibration.status).toBe("passed");
  expect(result.calibration.score).toBe(100);
  expect(result.run.status).toBe("completed");
  expect(result.worker.calibration.history).toHaveLength(1);
  expect(result.worker.calibration.history[0].runId).toBe(result.run.id);
  expect(result.worker.progression.xp).toBeGreaterThan(1840);
  expect(result.worker.trust.rating).toBeGreaterThan(0.74);
});

test("quest cli records failed calibration runs without crashing the command", () => {
  const context = trackContext();
  const scriptPath = join(context.stateRoot, "broken-calibration-worker.ts");
  writeFileSync(scriptPath, 'console.log("no-op calibration worker");\n', "utf8");

  const upsert = runCli(context, ["workers", "upsert", "--stdin"], {
    input: createLocalCommandWorkerJson("rook", ["bun", scriptPath]),
  });
  expect(upsert.code).toBe(0);

  const calibrated = runCli(context, ["workers", "calibrate", "--id", "rook"]);
  expect(calibrated.code).toBe(0);
  const result = JSON.parse(calibrated.stdout).result;
  expect(result.calibration.status).toBe("failed");
  expect(result.run.status).toBe("failed");
  expect(result.worker.calibration.history[0].status).toBe("failed");
  expect(result.worker.progression.xp).toBe(1840);
});

test("quest cli delivers calibration events to webhook sinks", async () => {
  const context = trackContext();
  const scriptPath = createCalibrationCommandScript(context.stateRoot);
  const receivedEvents: Array<{
    eventType: string;
    kind: string;
    score?: number;
    workerId?: string;
  }> = [];
  const server = Bun.serve({
    fetch: async (request) => {
      receivedEvents.push(
        (await request.json()) as {
          eventType: string;
          kind: string;
          score?: number;
          workerId?: string;
        },
      );
      return new Response("ok");
    },
    port: 0,
  });

  try {
    const sink = await runCliAsync(context, [
      "observability",
      "webhook",
      "upsert",
      "--id",
      "calibration-webhook",
      "--url",
      `http://127.0.0.1:${server.port}/events`,
      "--events",
      "worker_calibration_recorded",
    ]);
    expect(sink.code).toBe(0);

    const upsert = runCli(context, ["workers", "upsert", "--stdin"], {
      input: createLocalCommandWorkerJson("sparrow", ["bun", scriptPath]),
    });
    expect(upsert.code).toBe(0);

    const calibrated = await runCliAsync(context, ["workers", "calibrate", "--id", "sparrow"]);
    expect(calibrated.code).toBe(0);

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]).toMatchObject({
      eventType: "worker_calibration_recorded",
      kind: "worker_calibration",
      score: 100,
      workerId: "sparrow",
    });
  } finally {
    server.stop(true);
  }
});

test("quest cli plans from file and reports unassigned slices", () => {
  const context = trackContext();
  const specPath = join(context.stateRoot, "spec.json");

  writeFileSync(
    specPath,
    JSON.stringify(
      createSpec({
        maxParallel: 2,
        slices: [
          createSlice({
            goal: "Implement parser changes",
            id: "parser",
            preferredRunner: "openclaw",
            title: "Parser",
          }),
          createSlice({
            dependsOn: ["parser"],
            discipline: "testing",
            goal: "Validate parser changes",
            id: "tests",
            owns: ["src/**/*.test.ts"],
            title: "Tests",
          }),
        ],
        title: "Incompatible worker planning",
      }),
    ),
    "utf8",
  );

  const planned = runCli(context, ["plan", "--file", specPath]);
  expect(planned.code).toBe(0);
  const plan = JSON.parse(planned.stdout).plan;
  expect(plan.waves).toEqual([]);
  expect(
    plan.unassigned.map((slice: { id: string; reasonCode: string }) => ({
      id: slice.id,
      reasonCode: slice.reasonCode,
    })),
  ).toEqual([
    { id: "parser", reasonCode: "no_worker_available" },
    { id: "tests", reasonCode: "dependency_blocked" },
  ]);
});

test("quest cli creates persisted runs and reads them back", () => {
  const context = trackContext();
  expectWorkerUpserted(context);

  const created = runCli(context, ["run", "--stdin"], {
    input: JSON.stringify(
      createSpec({
        title: "Create quest run",
      }),
    ),
  });

  expect(created.code).toBe(0);
  const createdRun = JSON.parse(created.stdout).run;
  expect(createdRun.status).toBe("planned");
  expect(createdRun.id).toMatch(/^quest-[a-z0-9]{8}-[a-z0-9]{8}$/);

  const listed = runCli(context, ["runs", "list"]);
  expect(listed.code).toBe(0);
  const runs = JSON.parse(listed.stdout).runs;
  expect(runs.length).toBe(1);
  expect(runs[0].id).toBe(createdRun.id);

  const status = runCli(context, ["runs", "status", "--id", createdRun.id]);
  expect(status.code).toBe(0);
  expect(JSON.parse(status.stdout).run.id).toBe(createdRun.id);

  const summary = runCli(context, ["runs", "summary", "--id", createdRun.id]);
  expect(summary.code).toBe(0);
  expect(JSON.parse(summary.stdout).summary).toMatchObject({
    id: createdRun.id,
    integration: { status: "not_started" },
    status: "planned",
    title: "Create quest run",
  });
});

test("quest cli executes a planned run in dry-run mode", () => {
  const context = trackContext();
  expectWorkerUpserted(context);

  const created = runCli(context, ["run", "--stdin"], {
    input: JSON.stringify(createSpec({ title: "Execute quest run" })),
  });
  expect(created.code).toBe(0);
  const runId = JSON.parse(created.stdout).run.id as string;

  const executed = runCli(context, ["runs", "execute", "--id", runId, "--dry-run"]);
  expect(executed.code).toBe(0);
  const executedRun = JSON.parse(executed.stdout).run;
  expect(executedRun.status).toBe("completed");
  expect(executedRun.slices[0].status).toBe("completed");
  expect(executedRun.slices[0].lastOutput.summary).toContain("Dry run completed slice");

  const summary = runCli(context, ["runs", "summary", "--id", runId]);
  expect(summary.code).toBe(0);
  const runSummary = JSON.parse(summary.stdout).summary;
  expect(runSummary.counts.slices.completed).toBe(1);
  expect(runSummary.slices[0].workerId).toBe("ember");
});

test("quest cli returns logs and aborts a planned run", () => {
  const context = trackContext();
  expectWorkerUpserted(context);

  const created = runCli(context, ["run", "--stdin"], {
    input: JSON.stringify(createSpec({ title: "Abort quest run" })),
  });
  expect(created.code).toBe(0);
  const runId = JSON.parse(created.stdout).run.id as string;

  const logs = runCli(context, ["runs", "logs", "--id", runId]);
  expect(logs.code).toBe(0);
  const initialLogs = JSON.parse(logs.stdout).logs;
  expect(initialLogs.slices[0].status).toBe("pending");

  const aborted = runCli(context, ["runs", "abort", "--id", runId]);
  expect(aborted.code).toBe(0);
  const abortedRun = JSON.parse(aborted.stdout).run;
  expect(abortedRun.status).toBe("aborted");
  expect(abortedRun.slices[0].status).toBe("aborted");
});

test("quest cli cleans up run workspaces", () => {
  const context = trackContext();
  expectWorkerUpserted(context);

  const created = runCli(context, ["run", "--stdin"], {
    input: JSON.stringify(createSpec({ title: "Cleanup quest run" })),
  });
  expect(created.code).toBe(0);
  const createdRun = JSON.parse(created.stdout).run;
  const runId = createdRun.id as string;

  const executed = runCli(context, ["runs", "execute", "--id", runId, "--dry-run"]);
  expect(executed.code).toBe(0);
  const executedRun = JSON.parse(executed.stdout).run;
  expect(existsSync(executedRun.workspaceRoot)).toBe(true);

  const cleaned = runCli(context, ["runs", "cleanup", "--id", runId]);
  expect(cleaned.code).toBe(0);
  const cleanedRun = JSON.parse(cleaned.stdout).run;
  expect(existsSync(cleanedRun.workspaceRoot)).toBe(false);
  expect(
    cleanedRun.events.some((event: { type: string }) => event.type === "run_workspace_cleaned"),
  ).toBe(true);
});

test("quest cli executes a real local-command worker", () => {
  const context = trackContext();
  const scriptPath = join(context.stateRoot, "worker.ts");
  writeFileSync(
    scriptPath,
    [
      "const input = JSON.parse(await Bun.stdin.text());",
      "await Bun.write(Bun.stdout, 'real:' + input.slice.id + ':' + input.worker.id);",
    ].join("\n"),
    "utf8",
  );

  expectWorkerUpserted(
    context,
    createWorkerJson({}, { adapter: "local-command", command: ["bun", scriptPath] }),
  );

  const created = runCli(context, ["run", "--stdin"], {
    input: JSON.stringify(createSpec({ title: "Execute real local command run" })),
  });
  expect(created.code).toBe(0);
  const runId = JSON.parse(created.stdout).run.id as string;

  const executed = runCli(context, ["runs", "execute", "--id", runId]);
  expect(executed.code).toBe(0);
  const executedRun = JSON.parse(executed.stdout).run;
  expect(executedRun.status).toBe("completed");
  expect(executedRun.slices[0].lastOutput.stdout).toContain("real:parser:ember");
});

test("quest cli executes a run against a source git repository", () => {
  const context = trackContext();
  const repositoryRoot = createCommittedRepo(context.stateRoot);
  const scriptPath = join(context.stateRoot, "worker-materialized.ts");
  writeFileSync(
    scriptPath,
    [
      "const tracked = await Bun.file('tracked.txt').text();",
      "await Bun.write(Bun.stdout, tracked.trim());",
    ].join("\n"),
    "utf8",
  );

  expectWorkerUpserted(
    context,
    createWorkerJson({}, { adapter: "local-command", command: ["bun", scriptPath] }),
  );

  const created = runCli(context, ["run", "--stdin", "--source-repo", repositoryRoot], {
    input: JSON.stringify(createSpec({ title: "Execute source repo run" })),
  });
  expect(created.code).toBe(0);
  const runId = JSON.parse(created.stdout).run.id as string;

  const executed = runCli(context, ["runs", "execute", "--id", runId]);
  expect(executed.code).toBe(0);
  const executedRun = JSON.parse(executed.stdout).run;
  expect(executedRun.status).toBe("completed");
  expect(executedRun.sourceRepositoryPath).toBe(repositoryRoot);
  expect(executedRun.slices[0].lastOutput.stdout.trim()).toBe("from-source-repo");
});

test("quest cli integrates a completed run into a dedicated integration worktree", () => {
  const context = trackContext();
  const repositoryRoot = createCommittedRepo(context.stateRoot);
  const scriptPath = join(context.stateRoot, "worker-integrate.ts");
  writeFileSync(scriptPath, "await Bun.write('tracked.txt', 'integrated-change\\n');\n", "utf8");

  expectWorkerUpserted(
    context,
    createWorkerJson({}, { adapter: "local-command", command: ["bun", scriptPath] }),
  );

  const created = runCli(context, ["run", "--stdin", "--source-repo", repositoryRoot], {
    input: JSON.stringify(createSpec({ title: "Integrate source repo run" })),
  });
  expect(created.code).toBe(0);
  const runId = JSON.parse(created.stdout).run.id as string;

  const executed = runCli(context, ["runs", "execute", "--id", runId]);
  expect(executed.code).toBe(0);

  const integrated = runCli(context, ["runs", "integrate", "--id", runId]);
  expect(integrated.code).toBe(0);
  const integratedRun = JSON.parse(integrated.stdout).run;
  expect(integratedRun.slices[0].integrationStatus).toBe("integrated");
  expect(readFileSync(join(repositoryRoot, "tracked.txt"), "utf8")).toBe("from-source-repo\n");
  expect(readFileSync(join(integratedRun.integrationWorkspacePath, "tracked.txt"), "utf8")).toBe(
    "integrated-change\n",
  );
});

test("quest cli fails integration when top-level acceptance checks fail", () => {
  const context = trackContext();
  const repositoryRoot = createCommittedRepo(context.stateRoot);
  const scriptPath = join(context.stateRoot, "worker-integrate.ts");
  writeFileSync(scriptPath, "await Bun.write('tracked.txt', 'integrated-change\\n');\n", "utf8");

  expectWorkerUpserted(
    context,
    createWorkerJson({}, { adapter: "local-command", command: ["bun", scriptPath] }),
  );

  const created = runCli(context, ["run", "--stdin", "--source-repo", repositoryRoot], {
    input: JSON.stringify(
      createSpec({
        acceptanceChecks: [createCommand(["bun", "-e", "process.exit(9)"])],
        title: "Integration checks fail",
      }),
    ),
  });
  expect(created.code).toBe(0);
  const runId = JSON.parse(created.stdout).run.id as string;

  expect(runCli(context, ["runs", "execute", "--id", runId]).code).toBe(0);

  const integrated = runCli(context, ["runs", "integrate", "--id", runId]);
  expect(integrated.code).toBe(1);
  const status = runCli(context, ["runs", "status", "--id", runId]);
  const statusRun = JSON.parse(status.stdout).run;
  expect(statusRun.lastIntegrationChecks[0].exitCode).toBe(9);
});

test("quest cli fails a run when acceptance checks fail", () => {
  const context = trackContext();
  const scriptPath = join(context.stateRoot, "worker.ts");
  writeFileSync(
    scriptPath,
    [
      "const input = JSON.parse(await Bun.stdin.text());",
      "await Bun.write(Bun.stdout, 'real:' + input.slice.id + ':' + input.worker.id);",
    ].join("\n"),
    "utf8",
  );

  expectWorkerUpserted(
    context,
    createWorkerJson({}, { adapter: "local-command", command: ["bun", scriptPath] }),
  );

  const created = runCli(context, ["run", "--stdin"], {
    input: JSON.stringify(
      createSpec({
        slices: [
          createSlice({ acceptanceChecks: [createCommand(["bun", "-e", "process.exit(4)"])] }),
        ],
        title: "Execute failing check run",
      }),
    ),
  });
  expect(created.code).toBe(0);
  const runId = JSON.parse(created.stdout).run.id as string;

  const executed = runCli(context, ["runs", "execute", "--id", runId]);
  expect(executed.code).toBe(1);
  const logs = runCli(context, ["runs", "logs", "--id", runId]);
  expect(logs.code).toBe(0);
  const parsedLogs = JSON.parse(logs.stdout).logs;
  expect(parsedLogs.slices[0].status).toBe("failed");
  expect(parsedLogs.slices[0].lastChecks[0].exitCode).toBe(4);
});

test("quest cli reruns a prior run by cloning its spec", () => {
  const context = trackContext();
  expectWorkerUpserted(context);

  const created = runCli(context, ["run", "--stdin"], {
    input: JSON.stringify(createSpec({ title: "Rerun quest run" })),
  });
  expect(created.code).toBe(0);
  const firstRun = JSON.parse(created.stdout).run;

  const rerun = runCli(context, ["runs", "rerun", "--id", firstRun.id]);
  expect(rerun.code).toBe(0);
  const secondRun = JSON.parse(rerun.stdout).run;

  expect(secondRun.id).not.toBe(firstRun.id);
  expect(secondRun.spec.title).toBe(firstRun.spec.title);
  expect(secondRun.status).toBe("planned");
});

test("quest cli stores, checks, and deletes secrets through the keychain backend", () => {
  const context = trackContext();
  const secretName = "codex.api";
  const secretValue = "top-secret-token  ";

  const stored = runCli(context, ["secrets", "set", "--name", secretName, "--stdin"], {
    input: secretValue,
  });
  expect(stored.code).toBe(0);
  expect(JSON.parse(stored.stdout).secret.exists).toBe(true);

  const fetched = Bun.spawnSync({
    cmd: [
      "security",
      "find-generic-password",
      "-a",
      secretName,
      "-s",
      context.secretServiceName,
      "-w",
    ],
    cwd: context.stateRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(fetched.exitCode).toBe(0);
  expect(new TextDecoder().decode(fetched.stdout).replace(/\n$/, "")).toBe(secretValue);

  const status = runCli(context, ["secrets", "status", "--name", secretName]);
  expect(status.code).toBe(0);
  expect(JSON.parse(status.stdout).secret).toEqual({
    backend: "macos-keychain",
    exists: true,
    name: secretName,
  });

  const deleted = runCli(context, ["secrets", "delete", "--name", secretName]);
  expect(deleted.code).toBe(0);
  expect(JSON.parse(deleted.stdout)).toEqual({ name: secretName, ok: true });

  const missingStatus = runCli(context, ["secrets", "status", "--name", secretName]);
  expect(missingStatus.code).toBe(0);
  expect(JSON.parse(missingStatus.stdout).secret.exists).toBe(false);
});

test("quest cli doctor reports codex and storage health", () => {
  const context = trackContext();
  const fakeCodexPath = join(context.stateRoot, "fake-codex");
  writeFileSync(
    fakeCodexPath,
    [
      "#!/usr/bin/env bun",
      "const args = process.argv.slice(2);",
      "if (args.length === 1 && args[0] === '--version') {",
      "  await Bun.write(Bun.stdout, 'codex 0.0.0-test');",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'login' && args[1] === 'status') {",
      "  await Bun.write(Bun.stdout, 'Logged in using ChatGPT');",
      "  process.exit(0);",
      "}",
      "process.exit(1);",
    ].join("\n"),
    "utf8",
  );
  Bun.spawnSync({ cmd: ["chmod", "+x", fakeCodexPath], cwd: context.stateRoot });

  const doctor = runCli(context, ["doctor"], {
    env: { QUEST_RUNNER_CODEX_EXECUTABLE: fakeCodexPath },
  });

  expect(doctor.code).toBe(0);
  const report = JSON.parse(doctor.stdout);
  expect(report.ok).toBe(true);
  expect(report.checks.find((check: { name: string }) => check.name === "codex-binary")?.ok).toBe(
    true,
  );
  expect(report.checks.find((check: { name: string }) => check.name === "codex-login")?.ok).toBe(
    true,
  );
  expect(report.checks.find((check: { name: string }) => check.name === "secret-store")?.ok).toBe(
    true,
  );
});
