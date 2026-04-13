import type { SecretStore } from "../../secret-store";
import type { RegisteredWorker } from "../../workers/schema";
import { runSubprocess } from "../process";
import { buildProcessEnv } from "../process-env";
import type { QuestRunDocument } from "../schema";
import { resolveAuthEnv } from "./shared";

function sanitizeOpenClawIdPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildQuestSessionId(
  runId: string,
  sliceId: string,
  phase: "build" | "test",
): string {
  const parts = [runId, sliceId, phase]
    .map((part) => sanitizeOpenClawIdPart(part))
    .filter((part) => part.length > 0);
  return `quest-${parts.join("-")}`.slice(0, 160);
}

export function buildQuestAgentId(runId: string, sliceId: string, phase: "build" | "test"): string {
  const parts = [runId, sliceId, phase]
    .map((part) => sanitizeOpenClawIdPart(part))
    .filter((part) => part.length > 0);
  return `quest-${parts.join("-")}`.slice(0, 80);
}

type OpenClawCleanupWarning = {
  agentId: string;
  message: string;
  workerId: string;
};

async function deleteOpenClawAgent(
  run: QuestRunDocument,
  worker: RegisteredWorker,
  agentId: string,
  secretStore: SecretStore,
): Promise<OpenClawCleanupWarning | null> {
  const executable = worker.backend.executable ?? "openclaw";
  const authEnv = await resolveAuthEnv(worker, secretStore);
  const env = buildProcessEnv({
    ...worker.backend.env,
    ...authEnv,
    ...(worker.backend.gatewayUrl ? { OPENCLAW_GATEWAY_URL: worker.backend.gatewayUrl } : {}),
    QUEST_RUN_ID: run.id,
  });
  const result = await runSubprocess({
    cmd: [executable, "agents", "delete", agentId, "--force", "--json"],
    cwd: Bun.env.PWD ?? ".",
    env,
    timeoutMs: 60_000,
  });

  if (result.exitCode === 0) {
    return null;
  }

  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (output.includes("not found") || output.includes("missing")) {
    return null;
  }

  return {
    agentId,
    message:
      result.stderr.trim() ||
      result.stdout.trim() ||
      `OpenClaw returned exit code ${result.exitCode} while deleting ${agentId}`,
    workerId: worker.id,
  };
}

function collectOpenClawCleanupTargets(
  run: QuestRunDocument,
  workerMap: Map<string, RegisteredWorker>,
): Array<{ agentId: string; worker: RegisteredWorker }> {
  const targets = new Map<string, { agentId: string; worker: RegisteredWorker }>();

  for (const slice of run.slices) {
    if (slice.startedAt && slice.assignedWorkerId) {
      const worker = workerMap.get(slice.assignedWorkerId);
      if (worker?.backend.adapter === "openclaw-cli") {
        const agentId = buildQuestAgentId(run.id, slice.sliceId, "build");
        targets.set(`${worker.id}:${agentId}`, { agentId, worker });
      }
    }

    if (slice.lastTesterOutput && slice.assignedTesterWorkerId) {
      const worker = workerMap.get(slice.assignedTesterWorkerId);
      if (worker?.backend.adapter === "openclaw-cli") {
        const agentId = buildQuestAgentId(run.id, slice.sliceId, "test");
        targets.set(`${worker.id}:${agentId}`, { agentId, worker });
      }
    }
  }

  return [...targets.values()];
}

export async function cleanupRunOpenClawAgents(
  run: QuestRunDocument,
  workers: RegisteredWorker[],
  secretStore: SecretStore,
): Promise<OpenClawCleanupWarning[]> {
  const workerMap = new Map(workers.map((worker) => [worker.id, worker]));
  const targets = collectOpenClawCleanupTargets(run, workerMap);
  const warnings: OpenClawCleanupWarning[] = [];

  for (const target of targets) {
    const warning = await deleteOpenClawAgent(run, target.worker, target.agentId, secretStore);
    if (warning) {
      warnings.push(warning);
    }
  }

  return warnings;
}
