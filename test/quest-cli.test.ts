import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, expect, test } from "bun:test";

type TestContext = {
  stateRoot: string;
};

const activeContexts: TestContext[] = [];
const cliArgs = ["./src/cli.ts"];
const projectRoot = import.meta.dir.replace(/\/test$/, "");
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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
  const result = Bun.spawnSync({
    cmd: ["bun", ...cliArgs, ...args],
    cwd: projectRoot,
    env: {
      ...Bun.env,
      QUEST_RUNNER_STATE_ROOT: context.stateRoot,
      QUEST_RUNNER_WORKER_REGISTRY_PATH: join(context.stateRoot, "workers.json"),
    },
    stdin: options.input ? textEncoder.encode(options.input) : null,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    code: result.exitCode,
    stderr: textDecoder.decode(result.stderr),
    stdout: textDecoder.decode(result.stdout),
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
  expect(upsert.code).toBe(0);
  expect(JSON.parse(upsert.stdout).worker.id).toBe("ember");

  const listed = runCli(context, ["workers", "list"]);
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.stdout).workers.length).toBe(1);

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

  expect(plan.code).toBe(0);
  const planned = JSON.parse(plan.stdout).plan;
  expect(planned.waves.map((wave: { slices: Array<{ id: string }> }) => wave.slices.map((slice) => slice.id))).toEqual([
    ["parser"],
    ["docs"],
  ]);
  expect(planned.unassigned).toEqual([]);
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
  expect(planned.code).toBe(0);
  const plan = JSON.parse(planned.stdout).plan;
  expect(plan.waves).toEqual([]);
  expect(
    plan.unassigned.map((slice: { id: string; reasonCode: string }) => ({ id: slice.id, reasonCode: slice.reasonCode })),
  ).toEqual([
      { id: "parser", reasonCode: "no_worker_available" },
      { id: "tests", reasonCode: "dependency_blocked" },
    ]);
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
  expect(upsert.code).toBe(0);

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

  expect(runCli(context, ["workers", "upsert", "--stdin"], { input: workerJson }).code).toBe(0);

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

  expect(runCli(context, ["workers", "upsert", "--stdin"], { input: workerJson }).code).toBe(0);

  const created = runCli(
    context,
    ["run", "--stdin"],
    {
      input: JSON.stringify({
        version: 1,
        title: "Abort quest run",
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
  const context = createContext();
  const scriptPath = join(context.stateRoot, "worker.ts");
  writeFileSync(
    scriptPath,
    [
      "const input = JSON.parse(await Bun.stdin.text());",
      "await Bun.write(Bun.stdout, `real:${input.slice.id}:${input.worker.id}`);",
    ].join("\n"),
    "utf8",
  );

  const workerJson = JSON.stringify({
    id: "ember",
    name: "Ember",
    title: "Battle Engineer",
    class: "engineer",
    enabled: true,
    backend: {
      runner: "codex",
      profile: "gpt-5.4",
      adapter: "local-command",
      command: ["bun", scriptPath],
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

  expect(runCli(context, ["workers", "upsert", "--stdin"], { input: workerJson }).code).toBe(0);

  const created = runCli(
    context,
    ["run", "--stdin"],
    {
      input: JSON.stringify({
        version: 1,
        title: "Execute real local command run",
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
  expect(created.code).toBe(0);
  const runId = JSON.parse(created.stdout).run.id as string;

  const executed = runCli(context, ["runs", "execute", "--id", runId]);
  expect(executed.code).toBe(0);
  const executedRun = JSON.parse(executed.stdout).run;
  expect(executedRun.status).toBe("completed");
  expect(executedRun.slices[0].lastOutput.stdout).toContain("real:parser:ember");
});

test("quest cli fails a run when acceptance checks fail", () => {
  const context = createContext();
  const scriptPath = join(context.stateRoot, "worker.ts");
  writeFileSync(
    scriptPath,
    [
      "const input = JSON.parse(await Bun.stdin.text());",
      "await Bun.write(Bun.stdout, `real:${input.slice.id}:${input.worker.id}`);",
    ].join("\n"),
    "utf8",
  );

  const workerJson = JSON.stringify({
    id: "ember",
    name: "Ember",
    title: "Battle Engineer",
    class: "engineer",
    enabled: true,
    backend: {
      runner: "codex",
      profile: "gpt-5.4",
      adapter: "local-command",
      command: ["bun", scriptPath],
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

  expect(runCli(context, ["workers", "upsert", "--stdin"], { input: workerJson }).code).toBe(0);

  const created = runCli(
    context,
    ["run", "--stdin"],
    {
      input: JSON.stringify({
        version: 1,
        title: "Execute failing check run",
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
            acceptanceChecks: ["bun -e \"process.exit(4)\""],
            contextHints: [],
          },
        ],
      }),
    },
  );
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

  expect(runCli(context, ["workers", "upsert", "--stdin"], { input: workerJson }).code).toBe(0);

  const created = runCli(
    context,
    ["run", "--stdin"],
    {
      input: JSON.stringify({
        version: 1,
        title: "Rerun quest run",
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
  expect(created.code).toBe(0);
  const firstRun = JSON.parse(created.stdout).run;

  const rerun = runCli(context, ["runs", "rerun", "--id", firstRun.id]);
  expect(rerun.code).toBe(0);
  const secondRun = JSON.parse(rerun.stdout).run;

  expect(secondRun.id).not.toBe(firstRun.id);
  expect(secondRun.spec.title).toBe(firstRun.spec.title);
  expect(secondRun.status).toBe("planned");
});
