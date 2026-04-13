#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type CanaryBackend = "codex" | "hermes" | "local-command" | "openclaw";

type CanaryResult = {
  backend: CanaryBackend;
  featureDocPath: string | null;
  integrationValue: string;
  integrationWorkspacePath: string;
  repoValue: string;
  runId: string;
  runStatus: string;
  sliceStatus: string;
  stateRoot: string;
};

type CanaryExecuteResult = {
  run: {
    featureDocPath?: string | null;
    integrationWorkspacePath: string;
    slices: Array<{ status: string }>;
    status: string;
  };
};

function findOptionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseBackend(args: string[]): CanaryBackend {
  const backend = findOptionValue(args, "--backend") ?? "codex";
  if (
    backend === "codex" ||
    backend === "hermes" ||
    backend === "local-command" ||
    backend === "openclaw"
  ) {
    return backend;
  }

  throw new Error(`Unsupported backend: ${backend}`);
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
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${cmd.join(" ")}):\nstdout:\n${new TextDecoder().decode(result.stdout)}\nstderr:\n${new TextDecoder().decode(result.stderr)}`,
    );
  }

  return new TextDecoder().decode(result.stdout);
}

function createCommittedRepo(root: string): string {
  const repositoryRoot = join(root, "source-repo");
  mkdirSync(repositoryRoot, { recursive: true });
  runCommandOrThrow(["git", "init"], repositoryRoot, Bun.env as Record<string, string>);
  runCommandOrThrow(
    ["git", "config", "user.name", "Quest Runner Canary"],
    repositoryRoot,
    Bun.env as Record<string, string>,
  );
  runCommandOrThrow(
    ["git", "config", "user.email", "quest-runner-canary@example.com"],
    repositoryRoot,
    Bun.env as Record<string, string>,
  );
  writeFileSync(join(repositoryRoot, "status.ts"), 'export const status = "stale";\n', "utf8");
  runCommandOrThrow(["git", "add", "status.ts"], repositoryRoot, Bun.env as Record<string, string>);
  runCommandOrThrow(
    ["git", "commit", "-m", "Initial canary state"],
    repositoryRoot,
    Bun.env as Record<string, string>,
  );
  return repositoryRoot;
}

function createLocalWorkerScript(root: string): string {
  const scriptPath = join(root, "local-worker.ts");
  writeFileSync(
    scriptPath,
    [
      "await Bun.write('status.ts', 'export const status = \"fixed\";\\n');",
      "console.log('local canary worker updated status.ts');",
    ].join("\n"),
    "utf8",
  );
  return scriptPath;
}

function createSpecFile(root: string): string {
  const specPath = join(root, "repo-edit-spec.json");
  writeFileSync(
    specPath,
    JSON.stringify(
      {
        acceptanceChecks: [
          {
            argv: [
              "bun",
              "-e",
              "const text = await Bun.file('status.ts').text(); if (!text.includes('fixed')) process.exit(1);",
            ],
            env: {},
          },
        ],
        featureDoc: {
          enabled: true,
          outputPath: "docs/features/repo-edit-canary.md",
        },
        hotspots: [],
        maxParallel: 1,
        slices: [
          {
            acceptanceChecks: [],
            contextHints: [],
            dependsOn: [],
            discipline: "coding",
            goal: "Update status.ts so the exported status becomes fixed.",
            id: "fix-status",
            owns: ["status.ts"],
            title: "Fix Status",
          },
        ],
        title: "Repo Edit Canary",
        version: 1,
        workspace: "repo-edit-canary",
      },
      null,
      2,
    ),
    "utf8",
  );
  return specPath;
}

function registerWorker(
  backend: CanaryBackend,
  projectRoot: string,
  stateRoot: string,
  scratchRoot: string,
): void {
  const questEnv = {
    ...Bun.env,
    QUEST_RUNNER_STATE_ROOT: stateRoot,
  } as Record<string, string>;

  if (backend === "local-command") {
    const scriptPath = createLocalWorkerScript(scratchRoot);
    runCommandOrThrow(
      ["./bin/quest", "workers", "upsert", "--stdin"],
      projectRoot,
      questEnv,
      JSON.stringify({
        backend: {
          adapter: "local-command",
          command: ["bun", scriptPath],
          profile: "local-command",
          runner: "custom",
          toolPolicy: { allow: [], deny: [] },
        },
        calibration: { history: [] },
        class: "engineer",
        enabled: true,
        id: "canary-local",
        name: "Canary Local",
        persona: {
          approach: "write the file directly",
          prompt: "Keep the diff minimal.",
          voice: "direct",
        },
        progression: { level: 1, xp: 0 },
        role: "hybrid",
        resources: { cpuCost: 1, gpuCost: 0, maxParallel: 1, memoryCost: 1 },
        stats: {
          coding: 80,
          contextEndurance: 60,
          docs: 30,
          mergeSafety: 80,
          research: 30,
          speed: 70,
          testing: 60,
        },
        tags: ["canary"],
        title: "Canary Local",
        trust: { calibratedAt: new Date().toISOString(), rating: 0.8 },
      }),
    );
    return;
  }

  if (backend === "codex") {
    runCommandOrThrow(
      [
        "./bin/quest",
        "workers",
        "add",
        "codex",
        "--id",
        "canary-codex",
        "--name",
        "Canary Codex",
        "--profile",
        "gpt-5.4",
      ],
      projectRoot,
      questEnv,
    );
    return;
  }

  if (backend === "openclaw") {
    runCommandOrThrow(
      [
        "./bin/quest",
        "workers",
        "add",
        "openclaw",
        "--id",
        "canary-openclaw",
        "--name",
        "Canary OpenClaw",
        "--agent-id",
        "codex",
        "--profile",
        "openai-codex/gpt-5.4",
      ],
      projectRoot,
      questEnv,
    );
    return;
  }

  runCommandOrThrow(
    [
      "./bin/quest",
      "workers",
      "add",
      "hermes",
      "--id",
      "canary-hermes",
      "--name",
      "Canary Hermes",
      "--base-url",
      findOptionValue(Bun.argv.slice(2), "--hermes-base-url") ?? "http://127.0.0.1:8000/v1",
    ],
    projectRoot,
    questEnv,
  );
}

function main(): void {
  const args = Bun.argv.slice(2);
  const backend = parseBackend(args);
  const projectRoot = resolve(import.meta.dir, "..", "..");
  const scratchRoot = mkdtempSync(join(tmpdir(), "quest-repo-canary-"));
  const stateRoot = join(scratchRoot, "state");
  const repositoryRoot = createCommittedRepo(scratchRoot);
  const specPath = createSpecFile(scratchRoot);
  const questEnv = {
    ...Bun.env,
    QUEST_RUNNER_STATE_ROOT: stateRoot,
  } as Record<string, string>;

  try {
    registerWorker(backend, projectRoot, stateRoot, scratchRoot);

    const createdOutput = runCommandOrThrow(
      ["./bin/quest", "run", "--file", specPath, "--source-repo", repositoryRoot],
      projectRoot,
      questEnv,
    );
    const runId = (JSON.parse(createdOutput) as { run: { id: string } }).run.id;

    const executeOutput = runCommandOrThrow(
      ["./bin/quest", "runs", "execute", "--id", runId, "--auto-integrate", "--target-ref", "HEAD"],
      projectRoot,
      questEnv,
    );
    const run = (JSON.parse(executeOutput) as CanaryExecuteResult).run;
    const firstSlice = run.slices[0];
    if (!firstSlice) {
      throw new Error("Repo edit canary expected one slice result");
    }
    const result: CanaryResult = {
      backend,
      featureDocPath: run.featureDocPath ?? null,
      integrationValue: readFileSync(
        join(run.integrationWorkspacePath, "status.ts"),
        "utf8",
      ).trim(),
      integrationWorkspacePath: run.integrationWorkspacePath,
      repoValue: readFileSync(join(repositoryRoot, "status.ts"), "utf8").trim(),
      runId,
      runStatus: run.status,
      sliceStatus: firstSlice.status,
      stateRoot,
    };

    if (hasFlag(args, "--json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`Repo Edit Canary (${backend})`);
    console.log(`  run: ${result.runId}`);
    console.log(`  status: ${result.runStatus}`);
    console.log(`  slice: ${result.sliceStatus}`);
    console.log(`  repo value: ${result.repoValue}`);
    console.log(`  integration value: ${result.integrationValue}`);
    console.log(`  feature doc: ${result.featureDocPath ?? "none"}`);
    console.log(`  integration workspace: ${result.integrationWorkspacePath}`);
    console.log(`  state root: ${result.stateRoot}`);
  } finally {
    if (hasFlag(args, "--keep") !== true) {
      rmSync(scratchRoot, { force: true, recursive: true });
    }
  }
}

main();
