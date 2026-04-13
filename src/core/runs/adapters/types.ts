import type { QuestSliceSpec } from "../../planning/spec-schema";
import type { RegisteredWorker } from "../../workers/schema";
import type { QuestRunDocument, QuestRunSliceState } from "../schema";

export type RunnerExecutionResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
  summary: string;
};

export type RunnerExecutionContext = {
  cwd: string;
  phase: "build" | "test";
  run: QuestRunDocument;
  signal?: AbortSignal | undefined;
  slice: QuestSliceSpec;
  sliceState: QuestRunSliceState;
  worker: RegisteredWorker;
};

export interface RunnerAdapter {
  readonly name: string;
  supports(worker: RegisteredWorker): boolean;
  execute(context: RunnerExecutionContext): Promise<RunnerExecutionResult>;
}
