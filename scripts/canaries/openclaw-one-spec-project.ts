#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type CanaryOptions = {
  builderAgentId: string;
  builderProfile: string;
  gatewayUrl: string | undefined;
  json: boolean;
  keep: boolean;
  openClawExecutable: string;
  root: string;
  testerAgentId: string;
  testerProfile: string;
};

type CanaryExecuteResult = {
  run: {
    featureDocPath?: string | null;
    integrationWorkspacePath?: string | null;
    slices: Array<{ id: string; status: string }>;
    status: string;
  };
};

type CanaryResult = {
  builder: string;
  featureDocPath: string | null;
  integrationWorkspacePath: string | null;
  repositoryRoot: string;
  runId: string;
  runStatus: string;
  sliceStatus: string;
  stateRoot: string;
  tester: string;
  testOutput: string;
};

const repoRoot = resolve(import.meta.dir, "..", "..");

function findOptionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseArgs(args: string[]): CanaryOptions {
  return {
    builderAgentId:
      findOptionValue(args, "--builder-agent-id") ??
      Bun.env.QUEST_OPENCLAW_BUILDER_AGENT_ID ??
      "zai",
    builderProfile:
      findOptionValue(args, "--builder-profile") ??
      Bun.env.QUEST_OPENCLAW_BUILDER_PROFILE ??
      "zai/glm-5.1",
    gatewayUrl: findOptionValue(args, "--gateway-url") ?? Bun.env.OPENCLAW_GATEWAY_URL,
    json: hasFlag(args, "--json"),
    keep: hasFlag(args, "--keep"),
    openClawExecutable:
      findOptionValue(args, "--openclaw-executable") ??
      Bun.env.QUEST_OPENCLAW_EXECUTABLE ??
      Bun.which("openclaw") ??
      "openclaw",
    root: findOptionValue(args, "--root")
      ? resolve(findOptionValue(args, "--root") ?? "")
      : mkdtempSync(join(tmpdir(), "quest-openclaw-one-spec-")),
    testerAgentId:
      findOptionValue(args, "--tester-agent-id") ??
      Bun.env.QUEST_OPENCLAW_TESTER_AGENT_ID ??
      "minimax",
    testerProfile:
      findOptionValue(args, "--tester-profile") ??
      Bun.env.QUEST_OPENCLAW_TESTER_PROFILE ??
      "minimax/MiniMax-M2.7",
  };
}

function runCommandOrThrow(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
  input?: string,
): string {
  const result = Bun.spawnSync({
    cmd,
    cwd,
    env,
    stdin: input ? new TextEncoder().encode(input) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${cmd.join(" ")}):\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return stdout;
}

function createCommittedRepo(root: string): string {
  const repositoryRoot = join(root, "source-repo");
  mkdirSync(repositoryRoot, { recursive: true });
  runCommandOrThrow(["git", "init"], repositoryRoot, Bun.env as Record<string, string>);
  runCommandOrThrow(
    ["git", "config", "user.name", "Quest Canary"],
    repositoryRoot,
    Bun.env as Record<string, string>,
  );
  runCommandOrThrow(
    ["git", "config", "user.email", "quest-canary@example.com"],
    repositoryRoot,
    Bun.env as Record<string, string>,
  );
  writeFileSync(
    join(repositoryRoot, "README.md"),
    "# Score Package Canary\n\nQuest should build this from one spec.\n",
    "utf8",
  );
  runCommandOrThrow(["git", "add", "README.md"], repositoryRoot, Bun.env as Record<string, string>);
  runCommandOrThrow(
    ["git", "commit", "-m", "Initial canary project"],
    repositoryRoot,
    Bun.env as Record<string, string>,
  );
  return repositoryRoot;
}

function createSpecFile(root: string): string {
  const specPath = join(root, "one-spec-project.json");
  writeFileSync(
    specPath,
    JSON.stringify(
      {
        acceptanceChecks: [{ argv: ["bun", "test"], env: {} }],
        execution: {
          preInstall: false,
          shareSourceDependencies: true,
          testerSelectionStrategy: "balanced",
          timeoutMinutes: 60,
        },
        featureDoc: {
          enabled: true,
          outputPath: "docs/features/score-package.md",
        },
        hotspots: [],
        maxParallel: 1,
        slices: [
          {
            acceptanceChecks: [{ argv: ["bun", "test"], env: {} }],
            contextHints: [
              "Keep this as a small Bun TypeScript package with no external runtime dependency.",
            ],
            dependsOn: [],
            description:
              "Create package.json, src/score.ts, and test/score.test.ts. Export computeScore(input) for an array of events where each event has kind, points, and optional multiplier. Positive points add to the total, penalty events subtract points, multiplier defaults to 1, empty input returns 0, and invalid negative points throw a RangeError. Include README usage.",
            discipline: "coding",
            goal: "Build a complete tested Bun TypeScript score package from this single slice and make bun test pass.",
            id: "score-project",
            owns: ["README.md", "package.json", "src/score.ts", "test/score.test.ts"],
            preferredTesterWorkerId: "canary-minimax-tester",
            preferredWorkerId: "canary-glm-builder",
            title: "Score Project",
          },
        ],
        summary: "One-spec project canary using OpenClaw GLM builder and MiniMax tester workers.",
        title: "OpenClaw One Spec Project Canary",
        version: 1,
        workspace: "openclaw-one-spec-project",
      },
      null,
      2,
    ),
    "utf8",
  );
  return specPath;
}

function registerOpenClawWorkers(options: CanaryOptions, stateRoot: string): void {
  const questEnv = {
    ...Bun.env,
    QUEST_STATE_ROOT: stateRoot,
  } as Record<string, string>;
  const gatewayArgs = options.gatewayUrl ? ["--gateway-url", options.gatewayUrl] : [];

  runCommandOrThrow(
    [
      "./bin/quest",
      "workers",
      "add",
      "openclaw",
      "--no-import-existing",
      "--id",
      "canary-glm-builder",
      "--name",
      "Canary GLM Builder",
      "--agent-id",
      options.builderAgentId,
      "--profile",
      options.builderProfile,
      "--role",
      "builder",
      "--coding",
      "95",
      "--testing",
      "45",
      "--merge-safety",
      "60",
      "--max-parallel",
      "1",
      "--executable",
      options.openClawExecutable,
      ...gatewayArgs,
    ],
    repoRoot,
    questEnv,
  );

  runCommandOrThrow(
    [
      "./bin/quest",
      "workers",
      "add",
      "openclaw",
      "--no-import-existing",
      "--id",
      "canary-minimax-tester",
      "--name",
      "Canary MiniMax Tester",
      "--agent-id",
      options.testerAgentId,
      "--profile",
      options.testerProfile,
      "--role",
      "tester",
      "--coding",
      "35",
      "--testing",
      "95",
      "--merge-safety",
      "90",
      "--max-parallel",
      "1",
      "--executable",
      options.openClawExecutable,
      ...gatewayArgs,
    ],
    repoRoot,
    questEnv,
  );
}

function main(): void {
  const options = parseArgs(Bun.argv.slice(2));
  const stateRoot = join(options.root, "state");
  const repositoryRoot = createCommittedRepo(options.root);
  const specPath = createSpecFile(options.root);
  const processEnv = Bun.env as Record<string, string>;
  const questEnv = {
    ...Bun.env,
    QUEST_STATE_ROOT: stateRoot,
  } as Record<string, string>;

  try {
    registerOpenClawWorkers(options, stateRoot);
    const createdOutput = runCommandOrThrow(
      ["./bin/quest", "run", "--file", specPath, "--source-repo", repositoryRoot],
      repoRoot,
      questEnv,
    );
    const runId = (JSON.parse(createdOutput) as { run: { id: string } }).run.id;
    const executeOutput = runCommandOrThrow(
      [
        "./bin/quest",
        "runs",
        "execute",
        "--id",
        runId,
        "--auto-integrate",
        "--land",
        "--target-ref",
        "HEAD",
        "--source-repo",
        repositoryRoot,
      ],
      repoRoot,
      questEnv,
    );
    const run = (JSON.parse(executeOutput) as CanaryExecuteResult).run;
    const firstSlice = run.slices[0];
    if (!firstSlice) {
      throw new Error("OpenClaw one-spec canary expected one slice result");
    }

    const testOutput = runCommandOrThrow(["bun", "test"], repositoryRoot, processEnv);
    const result: CanaryResult = {
      builder: `${options.builderAgentId} ${options.builderProfile}`,
      featureDocPath: run.featureDocPath ?? null,
      integrationWorkspacePath: run.integrationWorkspacePath ?? null,
      repositoryRoot,
      runId,
      runStatus: run.status,
      sliceStatus: firstSlice.status,
      stateRoot,
      tester: `${options.testerAgentId} ${options.testerProfile}`,
      testOutput: testOutput.trim(),
    };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log("OpenClaw One Spec Project Canary");
    console.log(`  run: ${result.runId}`);
    console.log(`  status: ${result.runStatus}`);
    console.log(`  slice: ${result.sliceStatus}`);
    console.log(`  builder: ${result.builder}`);
    console.log(`  tester: ${result.tester}`);
    console.log(`  repo: ${result.repositoryRoot}`);
    console.log(`  integration workspace: ${result.integrationWorkspacePath ?? "none"}`);
    console.log(`  feature doc: ${result.featureDocPath ?? "none"}`);
    console.log(`  tests: ${result.testOutput.split("\n").at(-1) ?? result.testOutput}`);
  } finally {
    if (!options.keep) {
      rmSync(options.root, { force: true, recursive: true });
    }
  }
}

main();
