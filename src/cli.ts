#!/usr/bin/env bun

import { ZodError } from "zod";

import { isQuestDomainError } from "./core/errors";
import { QuestRunExecutor } from "./core/run-executor";
import { planQuest } from "./core/planner";
import { QuestRunStore } from "./core/run-store";
import { questSpecSchema } from "./core/spec-schema";
import { resolveQuestRunsRoot, resolveQuestStateRoot, resolveWorkerRegistryPath } from "./core/storage";
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

function printUsage(): void {
  void Bun.write(
    Bun.stdout,
    [
      "Usage:",
      "  quest workers list [--registry <path>]",
      "  quest workers upsert --file <path> [--registry <path>]",
      "  quest workers upsert --stdin [--registry <path>]",
      "  quest run --file <path> [--registry <path>] [--runs-root <path>] [--state-root <path>]",
      "  quest run --stdin [--registry <path>] [--runs-root <path>] [--state-root <path>]",
      "  quest plan --file <path> [--registry <path>]",
      "  quest plan --stdin [--registry <path>]",
      "  quest runs abort --id <run-id> [--runs-root <path>] [--state-root <path>]",
      "  quest runs rerun --id <run-id> [--registry <path>] [--runs-root <path>] [--state-root <path>]",
      "  quest runs execute --id <run-id> [--dry-run] [--registry <path>] [--runs-root <path>] [--state-root <path>]",
      "  quest runs logs --id <run-id> [--slice <slice-id>] [--runs-root <path>] [--state-root <path>]",
      "  quest runs list [--runs-root <path>] [--state-root <path>]",
      "  quest runs status --id <run-id> [--runs-root <path>] [--state-root <path>]",
      "",
      "Output is always JSON.",
    ].join("\n") + "\n",
  );
}

function stdinIsTty(): boolean {
  return Bun.spawnSync({
    cmd: ["/bin/sh", "-lc", "test -t 0"],
    stderr: "ignore",
    stdout: "ignore",
  }).exitCode === 0;
}

function resolveCommand(args: string[]): QuestCliCommand | null {
  if (args.length >= 2 && args[0] === "workers" && args[1] === "list") {
    return "workers:list";
  }

  if (args.length >= 2 && args[0] === "workers" && args[1] === "upsert") {
    return "workers:upsert";
  }

  if (args.length >= 1 && args[0] === "plan") {
    return "plan";
  }

  if (args.length >= 1 && args[0] === "run") {
    return "run";
  }

  if (args.length >= 2 && args[0] === "runs" && args[1] === "list") {
    return "runs:list";
  }

  if (args.length >= 2 && args[0] === "runs" && args[1] === "abort") {
    return "runs:abort";
  }

  if (args.length >= 2 && args[0] === "runs" && args[1] === "rerun") {
    return "runs:rerun";
  }

  if (args.length >= 2 && args[0] === "runs" && args[1] === "execute") {
    return "runs:execute";
  }

  if (args.length >= 2 && args[0] === "runs" && args[1] === "logs") {
    return "runs:logs";
  }

  if (args.length >= 2 && args[0] === "runs" && args[1] === "status") {
    return "runs:status";
  }

  return null;
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

async function main(): Promise<number> {
  const args = Bun.argv.slice(2);

  if (args.length === 0 || hasFlag(args, "--help")) {
    printUsage();
    return 0;
  }

  const command = resolveCommand(args);
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
    if (command === "workers:list") {
      writeJson({ workers: await registry.listWorkers() });
      return 0;
    }

    if (command === "workers:upsert") {
      const payload = registeredWorkerSchema.parse(await readJsonInput(args));
      writeJson({ worker: await registry.upsertWorker(payload) });
      return 0;
    }

    if (command === "plan") {
      const spec = questSpecSchema.parse(await readJsonInput(args));
      const workers = await registry.listWorkers();
      writeJson({ plan: planQuest(spec, workers) });
      return 0;
    }

    if (command === "run") {
      const spec = questSpecSchema.parse(await readJsonInput(args));
      const workers = await registry.listWorkers();
      writeJson({ run: await runStore.createRun(spec, workers) });
      return 0;
    }

    if (command === "runs:list") {
      writeJson({ runs: await runStore.listRuns() });
      return 0;
    }

    if (command === "runs:abort") {
      const runId = findOptionValue(args, "--id");
      if (!runId) {
        throw new Error("Expected --id <run-id>");
      }

      writeJson({ run: await runStore.abortRun(runId) });
      return 0;
    }

    if (command === "runs:rerun") {
      const runId = findOptionValue(args, "--id");
      if (!runId) {
        throw new Error("Expected --id <run-id>");
      }

      const previousRun = await runStore.getRun(runId);
      const workers = await registry.listWorkers();
      writeJson({ run: await runStore.createRun(previousRun.spec, workers) });
      return 0;
    }

    if (command === "runs:execute") {
      const runId = findOptionValue(args, "--id");
      if (!runId) {
        throw new Error("Expected --id <run-id>");
      }

      writeJson({
        run: await runExecutor.executeRun(runId, {
          dryRun: hasFlag(args, "--dry-run"),
        }),
      });
      return 0;
    }

    if (command === "runs:logs") {
      const runId = findOptionValue(args, "--id");
      if (!runId) {
        throw new Error("Expected --id <run-id>");
      }

      writeJson({
        logs: await runStore.getRunLogs(runId, findOptionValue(args, "--slice") ?? undefined),
      });
      return 0;
    }

    if (command === "runs:status") {
      const runId = findOptionValue(args, "--id");
      if (!runId) {
        throw new Error("Expected --id <run-id>");
      }

      writeJson({ run: await runStore.getRun(runId) });
      return 0;
    }
  } catch (error: unknown) {
    writeError(error);
    return 1;
  }

  return 0;
}

const exitCode = await main();
if (exitCode !== 0) {
  process.exit(exitCode);
}
