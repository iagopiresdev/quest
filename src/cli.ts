#!/usr/bin/env bun

import { ZodError } from "zod";

import { isQuestDomainError } from "./core/errors";
import { planQuest } from "./core/planner";
import { QuestRunCleanup } from "./core/run-cleanup";
import { QuestRunExecutor } from "./core/run-executor";
import { QuestRunIntegrator } from "./core/run-integrator";
import { QuestRunStore } from "./core/run-store";
import { SecretStore } from "./core/secret-store";
import { questSpecSchema } from "./core/spec-schema";
import {
  resolveQuestRunsRoot,
  resolveQuestStateRoot,
  resolveQuestWorkspacesRoot,
  resolveWorkerRegistryPath,
} from "./core/storage";
import { WorkerRegistry } from "./core/worker-registry";
import { registeredWorkerSchema } from "./core/worker-schema";

type QuestCliCommand =
  | "plan"
  | "run"
  | "runs:abort"
  | "runs:cleanup"
  | "runs:integrate"
  | "runs:rerun"
  | "runs:execute"
  | "runs:logs"
  | "runs:list"
  | "runs:status"
  | "secrets:delete"
  | "secrets:set"
  | "secrets:status"
  | "workers:list"
  | "workers:upsert";

type QuestCliContext = {
  args: string[];
  runCleanup: QuestRunCleanup;
  registry: WorkerRegistry;
  runExecutor: QuestRunExecutor;
  runIntegrator: QuestRunIntegrator;
  runStore: QuestRunStore;
  secretStore: SecretStore;
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

async function readTextInput(args: string[]): Promise<string> {
  const filePath = findOptionValue(args, "--file");
  const useStdin = hasFlag(args, "--stdin");

  if (filePath) {
    return await Bun.file(filePath).text();
  }

  if (useStdin || !stdinIsTty()) {
    return await readStdin();
  }

  throw new Error("Expected --file <path> or --stdin");
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
    id: "secrets:set",
    matches: (args) => args.length >= 2 && args[0] === "secrets" && args[1] === "set",
    run: async ({ args, secretStore }) => {
      const name = requireOptionValue(args, "--name", "--name <secret-name>");
      await secretStore.setSecret(name, await readTextInput(args));
      return { ok: true, secret: await secretStore.getStatus(name) };
    },
    usage: "quest secrets set --name <secret-name> (--file <path> | --stdin)",
  },
  {
    id: "secrets:delete",
    matches: (args) => args.length >= 2 && args[0] === "secrets" && args[1] === "delete",
    run: async ({ args, secretStore }) => {
      const name = requireOptionValue(args, "--name", "--name <secret-name>");
      await secretStore.deleteSecret(name);
      return { ok: true, name };
    },
    usage: "quest secrets delete --name <secret-name>",
  },
  {
    id: "secrets:status",
    matches: (args) => args.length >= 2 && args[0] === "secrets" && args[1] === "status",
    run: async ({ args, secretStore }) => ({
      secret: await secretStore.getStatus(
        requireOptionValue(args, "--name", "--name <secret-name>"),
      ),
    }),
    usage: "quest secrets status --name <secret-name>",
  },
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
      return {
        run: await runStore.createRun(spec, await registry.listWorkers(), {
          sourceRepositoryPath: findOptionValue(args, "--source-repo") ?? undefined,
        }),
      };
    },
    usage:
      "quest run --file <path> [--source-repo <path>] [--registry <path>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:list",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "list",
    run: async ({ runStore }) => ({ runs: await runStore.listRuns() }),
    usage: "quest runs list [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:abort",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "abort",
    run: async ({ args, runStore }) => ({
      run: await runStore.abortRun(requireOptionValue(args, "--id", "--id <run-id>")),
    }),
    usage:
      "quest runs abort --id <run-id> [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:cleanup",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "cleanup",
    run: async ({ args, runCleanup }) => ({
      run: await runCleanup.cleanupRun(requireOptionValue(args, "--id", "--id <run-id>")),
    }),
    usage:
      "quest runs cleanup --id <run-id> [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:integrate",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "integrate",
    run: async ({ args, runIntegrator }) => ({
      run: await runIntegrator.integrateRun(requireOptionValue(args, "--id", "--id <run-id>"), {
        sourceRepositoryPath: findOptionValue(args, "--source-repo") ?? undefined,
        targetRef: findOptionValue(args, "--target-ref") ?? undefined,
      }),
    }),
    usage:
      "quest runs integrate --id <run-id> [--source-repo <path>] [--target-ref <ref>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:rerun",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "rerun",
    run: async ({ args, registry, runStore }) => {
      const previousRun = await runStore.getRun(requireOptionValue(args, "--id", "--id <run-id>"));
      return {
        run: await runStore.createRun(previousRun.spec, await registry.listWorkers(), {
          sourceRepositoryPath:
            findOptionValue(args, "--source-repo") ?? previousRun.sourceRepositoryPath,
        }),
      };
    },
    usage:
      "quest runs rerun --id <run-id> [--source-repo <path>] [--registry <path>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:execute",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "execute",
    run: async ({ args, runExecutor }) => ({
      run: await runExecutor.executeRun(requireOptionValue(args, "--id", "--id <run-id>"), {
        dryRun: hasFlag(args, "--dry-run"),
        sourceRepositoryPath: findOptionValue(args, "--source-repo") ?? undefined,
      }),
    }),
    usage:
      "quest runs execute --id <run-id> [--dry-run] [--source-repo <path>] [--registry <path>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
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
      "quest runs logs --id <run-id> [--slice <slice-id>] [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
  },
  {
    id: "runs:status",
    matches: (args) => args.length >= 2 && args[0] === "runs" && args[1] === "status",
    run: async ({ args, runStore }) => ({
      run: await runStore.getRun(requireOptionValue(args, "--id", "--id <run-id>")),
    }),
    usage:
      "quest runs status --id <run-id> [--runs-root <path>] [--workspaces-root <path>] [--state-root <path>]",
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
  const workspacesRoot = resolveQuestWorkspacesRoot({
    explicitWorkspacesRoot: findOptionValue(args, "--workspaces-root") ?? undefined,
    stateRoot,
  });
  const registry = new WorkerRegistry(registryPath);
  const runStore = new QuestRunStore(runsRoot, workspacesRoot);
  const secretStore = new SecretStore();
  const runCleanup = new QuestRunCleanup(runStore);
  const runExecutor = new QuestRunExecutor(runStore, registry, secretStore);
  const runIntegrator = new QuestRunIntegrator(runStore);

  try {
    writeJson(
      await command.run({
        args,
        registry,
        runCleanup,
        runExecutor,
        runIntegrator,
        runStore,
        secretStore,
      }),
    );
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
