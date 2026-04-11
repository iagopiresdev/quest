import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CliTestContext,
  cleanupTempRoot,
  createCliContext,
  createSlice,
  createSpec,
  createWorkerJson,
  runCli,
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
        acceptanceChecks: ["npm test"],
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
        slices: [createSlice({ acceptanceChecks: ['bun -e "process.exit(4)"'] })],
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
