import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test, { afterEach } from "node:test";

type TestContext = {
  stateRoot: string;
};

const activeContexts: TestContext[] = [];
const cliArgs = ["--import", "./node_modules/tsx/dist/loader.mjs", "./src/cli.ts"];
const projectRoot = process.cwd();

function createContext(): TestContext {
  const stateRoot = mkdtempSync(join(tmpdir(), "grind-quest-cli-"));
  const context = { stateRoot };
  activeContexts.push(context);
  return context;
}

function runCli(
  context: TestContext,
  args: string[],
  options: { input?: string } = {},
): {
  code: number | null;
  stderr: string;
  stdout: string;
} {
  const result = spawnSync(process.execPath, [...cliArgs, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      QUEST_RUNNER_STATE_ROOT: context.stateRoot,
      QUEST_RUNNER_WORKER_REGISTRY_PATH: join(context.stateRoot, "workers.json"),
    },
    input: options.input,
  });

  return {
    code: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

afterEach(() => {
  while (activeContexts.length > 0) {
    const context = activeContexts.pop();
    if (context) {
      rmSync(context.stateRoot, { force: true, recursive: true });
    }
  }
});

test("quest cli upserts, lists, and plans from stdin", () => {
  const context = createContext();
  const workerJson = JSON.stringify({
    id: "ember",
    name: "Ember",
    title: "Battle Engineer",
    class: "engineer",
    enabled: true,
    backend: {
      runner: "codex",
      profile: "gpt-5.4",
      adapter: "local-cli",
      toolPolicy: { allow: ["git"], deny: [] },
    },
    persona: {
      voice: "terse",
      approach: "test-first",
      prompt: "Keep diffs tight and explain tradeoffs briefly.",
    },
    stats: {
      coding: 82,
      testing: 77,
      docs: 44,
      research: 51,
      speed: 63,
      mergeSafety: 79,
      contextEndurance: 58,
    },
    resources: {
      cpuCost: 2,
      memoryCost: 3,
      gpuCost: 0,
      maxParallel: 1,
    },
    trust: {
      rating: 0.74,
      calibratedAt: "2026-04-10T00:00:00Z",
    },
    progression: {
      level: 7,
      xp: 1840,
    },
    tags: ["typescript"],
  });

  const upsert = runCli(context, ["workers", "upsert", "--stdin"], { input: workerJson });
  assert.equal(upsert.code, 0);
  assert.equal(JSON.parse(upsert.stdout).worker.id, "ember");

  const listed = runCli(context, ["workers", "list"]);
  assert.equal(listed.code, 0);
  assert.equal(JSON.parse(listed.stdout).workers.length, 1);

  const plan = runCli(
    context,
    ["plan", "--stdin"],
    {
      input: JSON.stringify({
        version: 1,
        title: "Add SSRF protection",
        workspace: "command-center",
        maxParallel: 2,
        acceptanceChecks: ["npm test"],
        hotspots: [],
        featureDoc: { enabled: true, outputPath: "docs/features/ssrf-protection.md" },
        slices: [
          {
            id: "parser",
            title: "Parser",
            goal: "Implement SSRF parser validation",
            discipline: "coding",
            owns: ["src/security/url.ts"],
            dependsOn: [],
            acceptanceChecks: [],
            contextHints: [],
          },
          {
            id: "docs",
            title: "Docs",
            goal: "Draft feature notes",
            discipline: "docs",
            owns: ["docs/features/**"],
            dependsOn: [],
            acceptanceChecks: [],
            contextHints: [],
          },
        ],
      }),
    },
  );

  assert.equal(plan.code, 0);
  const planned = JSON.parse(plan.stdout).plan;
  assert.deepEqual(planned.waves.map((wave: { slices: Array<{ id: string }> }) => wave.slices.map((slice) => slice.id)), [
    ["parser"],
    ["docs"],
  ]);
  assert.deepEqual(planned.unassigned, []);
});

test("quest cli plans from file and reports unassigned slices", () => {
  const context = createContext();
  const specPath = join(context.stateRoot, "spec.json");
  writeFileSync(
    specPath,
    JSON.stringify({
      version: 1,
      title: "Incompatible worker planning",
      workspace: "command-center",
      maxParallel: 2,
      acceptanceChecks: [],
      hotspots: [],
      featureDoc: { enabled: false },
      slices: [
        {
          id: "parser",
          title: "Parser",
          goal: "Implement parser changes",
          discipline: "coding",
          owns: ["src/security/url.ts"],
          preferredRunner: "openclaw",
          dependsOn: [],
          acceptanceChecks: [],
          contextHints: [],
        },
        {
          id: "tests",
          title: "Tests",
          goal: "Validate parser changes",
          discipline: "testing",
          owns: ["src/**/*.test.ts"],
          dependsOn: ["parser"],
          acceptanceChecks: [],
          contextHints: [],
        },
      ],
    }),
    "utf8",
  );

  const planned = runCli(context, ["plan", "--file", specPath]);
  assert.equal(planned.code, 0);
  const plan = JSON.parse(planned.stdout).plan;
  assert.deepEqual(plan.waves, []);
  assert.deepEqual(
    plan.unassigned.map((slice: { id: string; reasonCode: string }) => ({ id: slice.id, reasonCode: slice.reasonCode })),
    [
      { id: "parser", reasonCode: "no_worker_available" },
      { id: "tests", reasonCode: "dependency_blocked" },
    ],
  );
});

test("quest cli creates persisted runs and reads them back", () => {
  const context = createContext();
  const workerJson = JSON.stringify({
    id: "ember",
    name: "Ember",
    title: "Battle Engineer",
    class: "engineer",
    enabled: true,
    backend: {
      runner: "codex",
      profile: "gpt-5.4",
      adapter: "local-cli",
      toolPolicy: { allow: ["git"], deny: [] },
    },
    persona: {
      voice: "terse",
      approach: "test-first",
      prompt: "Keep diffs tight and explain tradeoffs briefly.",
    },
    stats: {
      coding: 82,
      testing: 77,
      docs: 44,
      research: 51,
      speed: 63,
      mergeSafety: 79,
      contextEndurance: 58,
    },
    resources: {
      cpuCost: 2,
      memoryCost: 3,
      gpuCost: 0,
      maxParallel: 1,
    },
    trust: {
      rating: 0.74,
      calibratedAt: "2026-04-10T00:00:00Z",
    },
    progression: {
      level: 7,
      xp: 1840,
    },
    tags: ["typescript"],
  });

  const upsert = runCli(context, ["workers", "upsert", "--stdin"], { input: workerJson });
  assert.equal(upsert.code, 0);

  const created = runCli(
    context,
    ["run", "--stdin"],
    {
      input: JSON.stringify({
        version: 1,
        title: "Create quest run",
        workspace: "command-center",
        maxParallel: 1,
        acceptanceChecks: [],
        hotspots: [],
        featureDoc: { enabled: false },
        slices: [
          {
            id: "parser",
            title: "Parser",
            goal: "Implement parser validation",
            discipline: "coding",
            owns: ["src/security/url.ts"],
            dependsOn: [],
            acceptanceChecks: [],
            contextHints: [],
          },
        ],
      }),
    },
  );

  assert.equal(created.code, 0);
  const createdRun = JSON.parse(created.stdout).run;
  assert.equal(createdRun.status, "planned");
  assert.match(createdRun.id, /^quest-[a-z0-9]{8}-[a-z0-9]{8}$/);

  const listed = runCli(context, ["runs", "list"]);
  assert.equal(listed.code, 0);
  const runs = JSON.parse(listed.stdout).runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, createdRun.id);

  const status = runCli(context, ["runs", "status", "--id", createdRun.id]);
  assert.equal(status.code, 0);
  assert.equal(JSON.parse(status.stdout).run.id, createdRun.id);
});

test("quest cli executes a planned run in dry-run mode", () => {
  const context = createContext();
  const workerJson = JSON.stringify({
    id: "ember",
    name: "Ember",
    title: "Battle Engineer",
    class: "engineer",
    enabled: true,
    backend: {
      runner: "codex",
      profile: "gpt-5.4",
      adapter: "local-cli",
      toolPolicy: { allow: ["git"], deny: [] },
    },
    persona: {
      voice: "terse",
      approach: "test-first",
      prompt: "Keep diffs tight and explain tradeoffs briefly.",
    },
    stats: {
      coding: 82,
      testing: 77,
      docs: 44,
      research: 51,
      speed: 63,
      mergeSafety: 79,
      contextEndurance: 58,
    },
    resources: {
      cpuCost: 2,
      memoryCost: 3,
      gpuCost: 0,
      maxParallel: 1,
    },
    trust: {
      rating: 0.74,
      calibratedAt: "2026-04-10T00:00:00Z",
    },
    progression: {
      level: 7,
      xp: 1840,
    },
    tags: ["typescript"],
  });

  assert.equal(runCli(context, ["workers", "upsert", "--stdin"], { input: workerJson }).code, 0);

  const created = runCli(
    context,
    ["run", "--stdin"],
    {
      input: JSON.stringify({
        version: 1,
        title: "Execute quest run",
        workspace: "command-center",
        maxParallel: 1,
        acceptanceChecks: [],
        hotspots: [],
        featureDoc: { enabled: false },
        slices: [
          {
            id: "parser",
            title: "Parser",
            goal: "Implement parser validation",
            discipline: "coding",
            owns: ["src/security/url.ts"],
            dependsOn: [],
            acceptanceChecks: [],
            contextHints: [],
          },
        ],
      }),
    },
  );
  assert.equal(created.code, 0);
  const runId = JSON.parse(created.stdout).run.id as string;

  const executed = runCli(context, ["runs", "execute", "--id", runId, "--dry-run"]);
  assert.equal(executed.code, 0);
  const executedRun = JSON.parse(executed.stdout).run;
  assert.equal(executedRun.status, "completed");
  assert.equal(executedRun.slices[0].status, "completed");
});
