import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { QuestCommandSpec, QuestSliceSpec, QuestSpec } from "../src/core/spec-schema";
import type { RegisteredWorker, WorkerRunner } from "../src/core/worker-schema";

export type CliTestContext = {
  secretServiceName: string;
  stateRoot: string;
};

export type CliResult = {
  code: number | null;
  stderr: string;
  stdout: string;
};

const cliArgs = ["./src/cli.ts"];
const projectRoot = import.meta.dir.replace(/\/test$/, "");
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function createTempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupTempRoot(root: string): void {
  rmSync(root, { force: true, recursive: true });
}

export function runCommandOrThrow(cmd: string[], cwd: string): void {
  const result = Bun.spawnSync({
    cmd,
    cwd,
    env: Bun.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${cmd.join(" ")}\n${new TextDecoder().decode(result.stderr)}`);
  }
}

export function createCommittedRepo(root: string): string {
  const repositoryRoot = join(root, "source-repo");
  mkdirSync(repositoryRoot, { recursive: true });
  runCommandOrThrow(["git", "init"], repositoryRoot);
  runCommandOrThrow(["git", "config", "user.name", "Quest Runner"], repositoryRoot);
  runCommandOrThrow(["git", "config", "user.email", "quest-runner@example.com"], repositoryRoot);
  writeFileSync(join(repositoryRoot, "tracked.txt"), "from-source-repo\n", "utf8");
  runCommandOrThrow(["git", "add", "tracked.txt"], repositoryRoot);
  runCommandOrThrow(["git", "commit", "-m", "Initial commit"], repositoryRoot);
  return repositoryRoot;
}

export function createCliContext(): CliTestContext {
  return {
    secretServiceName: `quest-runner-test-${crypto.randomUUID()}`,
    stateRoot: createTempRoot("quest-cli-"),
  };
}

export function runCli(
  context: CliTestContext,
  args: string[],
  options: { env?: Record<string, string | undefined>; input?: string } = {},
): CliResult {
  const result = Bun.spawnSync({
    cmd: ["bun", ...cliArgs, ...args],
    cwd: projectRoot,
    env: {
      ...Bun.env,
      ...options.env,
      QUEST_RUNNER_STATE_ROOT: context.stateRoot,
      QUEST_RUNNER_WORKER_REGISTRY_PATH: join(context.stateRoot, "workers.json"),
      QUEST_RUNNER_SECRET_STORE_SERVICE_NAME: context.secretServiceName,
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

export function createWorker(
  overrides: Partial<RegisteredWorker> = {},
  backendOverrides: Partial<RegisteredWorker["backend"]> = {},
): RegisteredWorker {
  const base: RegisteredWorker = {
    backend: {
      adapter: "local-cli",
      profile: "gpt-5.4",
      runner: "codex",
      toolPolicy: { allow: [], deny: [] },
    },
    class: "engineer",
    enabled: true,
    id: "ember",
    name: "Ember",
    persona: {
      approach: "test-first",
      prompt: "Keep diffs tight and explain tradeoffs briefly.",
      voice: "terse",
    },
    progression: {
      level: 7,
      xp: 1840,
    },
    resources: {
      cpuCost: 2,
      gpuCost: 0,
      maxParallel: 1,
      memoryCost: 3,
    },
    stats: {
      coding: 82,
      contextEndurance: 58,
      docs: 44,
      mergeSafety: 79,
      research: 51,
      speed: 63,
      testing: 77,
    },
    tags: ["typescript"],
    title: "Battle Engineer",
    trust: {
      calibratedAt: "2026-04-10T00:00:00Z",
      rating: 0.74,
    },
  };

  return {
    ...base,
    ...overrides,
    backend: {
      ...base.backend,
      ...overrides.backend,
      ...backendOverrides,
      toolPolicy: {
        ...base.backend.toolPolicy,
        ...overrides.backend?.toolPolicy,
        ...backendOverrides.toolPolicy,
      },
    },
    persona: {
      ...base.persona,
      ...overrides.persona,
    },
    progression: {
      ...base.progression,
      ...overrides.progression,
    },
    resources: {
      ...base.resources,
      ...overrides.resources,
    },
    stats: {
      ...base.stats,
      ...overrides.stats,
    },
    trust: {
      ...base.trust,
      ...overrides.trust,
    },
  };
}

export function createWorkerJson(
  overrides: Partial<RegisteredWorker> = {},
  backendOverrides: Partial<RegisteredWorker["backend"]> = {},
): string {
  return JSON.stringify(createWorker(overrides, backendOverrides));
}

export function createWorkerForRunner(
  id: string,
  runner: WorkerRunner = "codex",
  backendOverrides: Partial<RegisteredWorker["backend"]> = {},
): RegisteredWorker {
  return createWorker(
    {
      class: runner === "hermes" ? "tester" : "engineer",
      id,
      name: id,
      progression: { level: 1, xp: 0 },
      resources: {
        cpuCost: 1,
        gpuCost: runner === "hermes" ? 1 : 0,
        maxParallel: 1,
        memoryCost: 1,
      },
      stats: {
        coding: 80,
        contextEndurance: 60,
        docs: 40,
        mergeSafety: 75,
        research: 50,
        speed: 65,
        testing: runner === "hermes" ? 90 : 55,
      },
      tags: [],
      title: "Worker",
      trust: {
        calibratedAt: "2026-04-11T00:00:00Z",
        rating: 0.75,
      },
    },
    {
      adapter: "local-cli",
      profile: runner === "hermes" ? "qwen3.5-27b" : "gpt-5.4",
      runner,
      ...backendOverrides,
    },
  );
}

export function createSlice(overrides: Partial<QuestSliceSpec> = {}): QuestSliceSpec {
  return {
    acceptanceChecks: [],
    contextHints: [],
    dependsOn: [],
    discipline: "coding",
    goal: "Implement parser changes",
    id: "parser",
    owns: ["src/security/url.ts"],
    title: "Parser",
    ...overrides,
  };
}

export function createCommand(argv: string[], env: Record<string, string> = {}): QuestCommandSpec {
  return { argv, env };
}

export function createSpec(
  overrides: Partial<Omit<QuestSpec, "slices">> & { slices?: QuestSliceSpec[] } = {},
): QuestSpec {
  return {
    acceptanceChecks: [],
    featureDoc: { enabled: false },
    hotspots: [],
    maxParallel: 1,
    slices: overrides.slices ?? [createSlice()],
    title: "Quest Run",
    version: 1,
    workspace: "command-center",
    ...overrides,
  };
}
