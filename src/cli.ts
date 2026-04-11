#!/usr/bin/env bun

import { ZodError } from "zod";

import { isQuestDomainError } from "./core/errors";
import { planQuest } from "./core/planner";
import { QuestRunExecutor } from "./core/run-executor";
import { QuestRunStore } from "./core/run-store";
import { questSpecSchema } from "./core/spec-schema";
import {
  resolveQuestRunsRoot,
  resolveQuestStateRoot,
  resolveWorkerRegistryPath,
} from "./core/storage";
import { WorkerRegistry } from "./core/worker-registry";
import { registeredWorkerSchema } from "./core/worker-schema";

type QuestCliCommand =
  | "plan"
  | "run"
  | "runs:abort"
  | "runs:rerun"
  | "runs:execute"
  | "runs:logs"
  | "runs:list"
  | "runs:status"
  | "workers:list"
  | "workers:upsert";

type QuestCliContext = {
  args: string[];
  registry: WorkerRegistry;
  runExecutor: QuestRunExecutor;
  runStore: QuestRunStore;
};

type QuestCliCommandDefinition = {
  id: QuestCliCommand;
  matches(args: string[]): boolean;
  usage: string;
  run(context: QuestCliContext): Promise<unknown>;
};

function printUsage(): void {
  void Bun.write(
    Bun.stdout,
    `${[
      "Usage:",
      ...commandDefinitions.map((definition) => `  ${definition.usage}`),
      "",
      "Output is always JSON.",
    ].join("\n")}\n`,
  );
}

function stdinIsTty(): boolean {
  return process.stdin.isTTY === true;
}

function findOptionValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index < 0) {
    return null;
  }

  return args[index + 1] ?? null;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function requireOptionValue(args: string[], flag: string, label: string): string {
  const value = findOptionValue(args, flag);
  if (!value) {
    throw new Error(`Expected ${label}`);
  }

  return value;
}

async function readStdin(): Promise<string> {
  return await Bun.stdin.text();
}

async function readJsonInput(args: string[]): Promise<unknown> {
  const filePath = findOptionValue(args, "--file");
  const useStdin = hasFlag(args, "--stdin");

  if (filePath) {
    return JSON.parse(await Bun.file(filePath).text()) as unknown;
  }

  if (useStdin || !stdinIsTty()) {
    const raw = await readStdin();
    return JSON.parse(raw) as unknown;
  }

  throw new Error("Expected --file <path> or --stdin");
}

function writeJson(value: unknown): void {
  void Bun.write(Bun.stdout, `${JSON.stringify(value, null, 2)}\n`);
}

function writeError(error: unknown): void {
  if (error instanceof ZodError) {
    void Bun.write(
      Bun.stderr,
      `${JSON.stringify(
        {
          error: "validation_failed",
          details: error.flatten(),
          message: "Input validation failed",
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (isQuestDomainError(error)) {
    void Bun.write(
      Bun.stderr,
      `${JSON.stringify(
        {
          error: error.code,
          details: error.details,
          message: error.message,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  void Bun.write(
    Bun.stderr,
    `${JSON.stringify(
      {
        error: "cli_failure",
        message: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    )}\n`,
  );
}

const commandDefinitions: QuestCliCommandDefinition[] = [
  {
    id: "workers:list",
    matches: (args) => args.length >= 2 && args[0] === "workers" && args[1] === "list",
    run: async ({ registry }) => ({ workers: await registry.listWorkers() }),
    usage: "quest workers list [--registry <path>]",
  },
  {
    id: "workers:upsert",
    matches: (args) => args.length >= 2 && args[0] === "workers" && args[1] === "upsert",
    run: async ({ args, registry }) => {
      const payload = registeredWorkerSchema.parse(await readJsonInput(args));
      return { worker: await registry.upsertWorker(payload) };
    },
    usage: "quest workers upsert --file <path> [--registry <path>]",
  },
  {
    id: "plan",
    matches: (args) => args.length >= 1 && args[0] === "plan",
    run: async ({ args, registry }) => {
      const spec = questSpecSchema.parse(await readJsonInput(args));
      return { plan: planQuest(spec, await registry.listWorkers()) };
    },
    usage: "quest plan --file <path> [--registry <path>]",
  },
  {
    id: "run",
    matches: (args) => args.length >= 1 && args[0] === "run",
    run: async ({ args, registry, runStore }) => {
      const spec = questSpecSchema.parse(await readJsonInput(args));
      return { run: await runStore.createRun(spec, await registry.listWorkers()) };
    },
    usage: "quest run --file <path> [--registry <path>] [--runs-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:list",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "list",
    run: async ({ runStore }) => ({ runs: await runStore.listRuns() }),
    usage: "quest runs list [--runs-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:abort",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "abort",
    run: async ({ args, runStore }) => ({
      run: await runStore.abortRun(requireOptionValue(args, "--id", "--id <run-id>")),
    }),
    usage: "quest runs abort --id <run-id> [--runs-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:rerun",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "rerun",
    run: async ({ args, registry, runStore }) => {
      const previousRun = await runStore.getRun(requireOptionValue(args, "--id", "--id <run-id>"));
      return { run: await runStore.createRun(previousRun.spec, await registry.listWorkers()) };
    },
    usage:
      "quest runs rerun --id <run-id> [--registry <path>] [--runs-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:execute",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "execute",
    run: async ({ args, runExecutor }) => ({
      run: await runExecutor.executeRun(requireOptionValue(args, "--id", "--id <run-id>"), {
        dryRun: hasFlag(args, "--dry-run"),
      }),
    }),
    usage:
      "quest runs execute --id <run-id> [--dry-run] [--registry <path>] [--runs-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:logs",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "logs",
    run: async ({ args, runStore }) => ({
      logs: await runStore.getRunLogs(
        requireOptionValue(args, "--id", "--id <run-id>"),
        findOptionValue(args, "--slice") ?? undefined,
      ),
    }),
    usage:
      "quest runs logs --id <run-id> [--slice <slice-id>] [--runs-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:status",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "status",
    run: async ({ args, runStore }) => ({
      run: await runStore.getRun(requireOptionValue(args, "--id", "--id <run-id>")),
    }),
    usage: "quest runs status --id <run-id> [--runs-root <path>] [--state-root <path>]",
  },
];

async function main(): Promise<number> {
  const args = Bun.argv.slice(2);

  if (args.length === 0 || hasFlag(args, "--help")) {
    printUsage();
    return 0;
  }

  const command = commandDefinitions.find((definition) => definition.matches(args)) ?? null;
  if (!command) {
    printUsage();
    return 1;
  }

  const stateRoot = resolveQuestStateRoot(findOptionValue(args, "--state-root") ?? undefined);
  const registryPath = resolveWorkerRegistryPath({
    explicitRegistryPath: findOptionValue(args, "--registry") ?? undefined,
    stateRoot,
  });
  const runsRoot = resolveQuestRunsRoot({
    explicitRunsRoot: findOptionValue(args, "--runs-root") ?? undefined,
    stateRoot,
  });
  const registry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot);
  const runExecutor = new QuestRunExecutor(runStore, registry);

  try {
    writeJson(await command.run({ args, registry, runExecutor, runStore }));
    return 0;
  } catch (error: unknown) {
    writeError(error);
    return 1;
  }
}

const exitCode = await main();
if (exitCode !== 0) {
  process.exit(exitCode);
}
