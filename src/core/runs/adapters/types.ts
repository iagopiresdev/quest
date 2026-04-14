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
  idleTimeoutMs?: number | undefined;
  onSubprocessExit?: ((pid: number) => Promise<void> | void) | undefined;
  onSubprocessSpawn?: ((command: string[], pid: number) => Promise<void> | void) | undefined;
  phase: "build" | "test";
  run: QuestRunDocument;
  signal?: AbortSignal | undefined;
  slice: QuestSliceSpec;
  sliceState: QuestRunSliceState;
  timeoutMs?: number | undefined;
  worker: RegisteredWorker;
};

export interface RunnerAdapter {
  readonly name: string;
  supports(worker: RegisteredWorker): boolean;
  execute(context: RunnerExecutionContext): Promise<RunnerExecutionResult>;
}
