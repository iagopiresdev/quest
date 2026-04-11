import type { RunnerAdapter, RunnerExecutionContext, RunnerExecutionResult } from "./types";

export class DryRunRunnerAdapter implements RunnerAdapter {
  readonly name = "dry-run";

  supports(): boolean {
    return true;
  }

  async execute(context: RunnerExecutionContext): Promise<RunnerExecutionResult> {
    return {
      exitCode: 0,
      stderr: "",
      stdout: "",
      summary: `Dry run completed slice ${context.slice.id} with worker ${context.worker.id}`,
    };
  }
}
