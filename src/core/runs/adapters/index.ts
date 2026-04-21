import { QuestDomainError } from "../../errors";
import type { RegisteredWorker } from "../../workers/schema";
import { AcpRunnerAdapter } from "./acp";
import { CodexCliRunnerAdapter } from "./codex-cli";
import { DryRunRunnerAdapter } from "./dry-run";
import { HermesApiRunnerAdapter } from "./hermes-api";
import { LocalCommandRunnerAdapter } from "./local-command";
import { OpenClawCliRunnerAdapter } from "./openclaw-cli";
import type { RunnerAdapter } from "./types";

export type { RunnerAdapter, RunnerExecutionContext, RunnerExecutionResult } from "./types";
export {
  AcpRunnerAdapter,
  CodexCliRunnerAdapter,
  DryRunRunnerAdapter,
  HermesApiRunnerAdapter,
  LocalCommandRunnerAdapter,
  OpenClawCliRunnerAdapter,
};

export class RunnerRegistry {
  constructor(private readonly adapters: RunnerAdapter[]) {}

  resolve(worker: RegisteredWorker, options: { forceDryRun?: boolean } = {}): RunnerAdapter {
    if (options.forceDryRun) {
      const dryRun = this.adapters.find((adapter) => adapter.name === "dry-run");
      if (!dryRun) {
        throw new QuestDomainError({
          code: "quest_unavailable",
          details: { adapter: "dry-run" },
          message: "Dry-run adapter is not configured",
          statusCode: 1,
        });
      }

      return dryRun;
    }

    const adapter = this.adapters.find(
      (candidate) => candidate.name === worker.backend.adapter && candidate.supports(worker),
    );
    if (!adapter) {
      throw new QuestDomainError({
        code: "quest_unavailable",
        details: { adapter: worker.backend.adapter, workerId: worker.id },
        message: `No runner adapter is available for worker ${worker.id}`,
        statusCode: 1,
      });
    }

    return adapter;
  }
}
