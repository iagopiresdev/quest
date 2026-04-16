#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type CanaryResult = {
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
    integrationWorkspacePath: string;
    slices: Array<{ status: string }>;
    status: string;
  };
};

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
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

function createSpecFile(root: string): string {
  const specPath = join(root, "acp-canary-spec.json");
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
        featureDoc: { enabled: false },
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
        title: "ACP Adapter Canary",
        version: 1,
        workspace: "acp-canary",
      },
      null,
      2,
    ),
    "utf8",
  );
  return specPath;
}

function registerAcpWorker(projectRoot: string, stateRoot: string, echoAgentPath: string): void {
  const questEnv = {
    ...Bun.env,
    QUEST_RUNNER_STATE_ROOT: stateRoot,
  } as Record<string, string>;

  runCommandOrThrow(
    ["./bin/quest", "workers", "upsert", "--stdin"],
    projectRoot,
    questEnv,
    JSON.stringify({
      backend: {
        adapter: "acp",
        executable: `node ${echoAgentPath}`,
        profile: "echo",
        runner: "custom",
        toolPolicy: { allow: [], deny: [] },
      },
      calibration: { history: [] },
      class: "engineer",
      enabled: true,
      id: "canary-acp",
      name: "Canary ACP",
      persona: {
        approach: "update the file directly",
        prompt: "Fix the status.",
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
      title: "Canary ACP",
      trust: { calibratedAt: new Date().toISOString(), rating: 0.8 },
    }),
  );
}

function main(): void {
  const args = Bun.argv.slice(2);
  const projectRoot = resolve(import.meta.dir, "..", "..");
  const scratchRoot = mkdtempSync(join(tmpdir(), "quest-acp-canary-"));
  const stateRoot = join(scratchRoot, "state");
  const echoAgentPath = resolve(import.meta.dir, "fixtures", "acp-echo-agent.cjs");
  const repositoryRoot = createCommittedRepo(scratchRoot);
  const specPath = createSpecFile(scratchRoot);
  const questEnv = {
    ...Bun.env,
    QUEST_RUNNER_STATE_ROOT: stateRoot,
  } as Record<string, string>;

  try {
    registerAcpWorker(projectRoot, stateRoot, echoAgentPath);

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
      throw new Error("ACP adapter canary expected one slice result");
    }

    const result: CanaryResult = {
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

    console.log("ACP Adapter Canary");
    console.log(`  run: ${result.runId}`);
    console.log(`  status: ${result.runStatus}`);
    console.log(`  slice: ${result.sliceStatus}`);
    console.log(`  repo value: ${result.repoValue}`);
    console.log(`  integration value: ${result.integrationValue}`);
    console.log(`  integration workspace: ${result.integrationWorkspacePath}`);
    console.log(`  state root: ${result.stateRoot}`);
  } finally {
    if (hasFlag(args, "--keep") !== true) {
      rmSync(scratchRoot, { force: true, recursive: true });
    }
  }
}

main();
