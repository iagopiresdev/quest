import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { QuestDomainError } from "./errors";

const DEFAULT_STATE_ROOT = join(homedir(), ".quest-runner");

export function resolveQuestStateRoot(explicitPath?: string): string {
  const configuredPath = explicitPath?.trim() || Bun.env.QUEST_RUNNER_STATE_ROOT?.trim();
  return configuredPath ? resolve(configuredPath) : DEFAULT_STATE_ROOT;
}

export function resolveWorkerRegistryPath(
  options: { explicitRegistryPath?: string; stateRoot?: string } = {},
): string {
  const configuredPath =
    options.explicitRegistryPath?.trim() || Bun.env.QUEST_RUNNER_WORKER_REGISTRY_PATH?.trim();
  if (configuredPath) {
    return resolve(configuredPath);
  }

  return join(resolveQuestStateRoot(options.stateRoot), "workers.json");
}

export function resolveQuestRunsRoot(
  options: { explicitRunsRoot?: string; stateRoot?: string } = {},
): string {
  const configuredPath = options.explicitRunsRoot?.trim() || Bun.env.QUEST_RUNNER_RUNS_ROOT?.trim();
  if (configuredPath) {
    return resolve(configuredPath);
  }

  return join(resolveQuestStateRoot(options.stateRoot), "runs");
}

export function resolveQuestWorkspacesRoot(
  options: { explicitWorkspacesRoot?: string; stateRoot?: string } = {},
): string {
  const configuredPath =
    options.explicitWorkspacesRoot?.trim() || Bun.env.QUEST_RUNNER_WORKSPACES_ROOT?.trim();
  if (configuredPath) {
    return resolve(configuredPath);
  }

  return join(resolveQuestStateRoot(options.stateRoot), "workspaces");
}

export function resolveQuestCalibrationsRoot(
  options: { explicitCalibrationsRoot?: string; stateRoot?: string } = {},
): string {
  const configuredPath =
    options.explicitCalibrationsRoot?.trim() || Bun.env.QUEST_RUNNER_CALIBRATIONS_ROOT?.trim();
  if (configuredPath) {
    return resolve(configuredPath);
  }

  return join(resolveQuestStateRoot(options.stateRoot), "calibrations");
}

export function resolveQuestObservabilityConfigPath(
  options: { explicitObservabilityConfigPath?: string; stateRoot?: string } = {},
): string {
  const configuredPath =
    options.explicitObservabilityConfigPath?.trim() ||
    Bun.env.QUEST_RUNNER_OBSERVABILITY_CONFIG_PATH?.trim();
  if (configuredPath) {
    return resolve(configuredPath);
  }

  return join(resolveQuestStateRoot(options.stateRoot), "observability", "config.json");
}

export function resolveQuestObservabilityDeliveriesPath(
  options: { explicitObservabilityDeliveriesPath?: string; stateRoot?: string } = {},
): string {
  const configuredPath =
    options.explicitObservabilityDeliveriesPath?.trim() ||
    Bun.env.QUEST_RUNNER_OBSERVABILITY_DELIVERIES_PATH?.trim();
  if (configuredPath) {
    return resolve(configuredPath);
  }

  return join(resolveQuestStateRoot(options.stateRoot), "observability", "deliveries.json");
}

export function resolveQuestRunPath(
  runId: string,
  options: {
    explicitRunsRoot?: string;
    stateRoot?: string;
  } = {},
): string {
  return join(resolveQuestRunsRoot(options), `${runId}.json`);
}

export function resolveQuestRunWorkspaceRoot(
  runId: string,
  options: {
    explicitWorkspacesRoot?: string;
    stateRoot?: string;
  } = {},
): string {
  return join(resolveQuestWorkspacesRoot(options), runId);
}

export function resolveQuestSliceWorkspacePath(
  runId: string,
  sliceId: string,
  options: {
    explicitWorkspacesRoot?: string;
    stateRoot?: string;
  } = {},
): string {
  return join(resolveQuestRunWorkspaceRoot(runId, options), "slices", sliceId);
}

export async function readJsonFileOrDefault<T>(
  path: string,
  fallback: T,
  options: {
    invalidJsonCode?:
      | "invalid_quest_run"
      | "invalid_worker_registry"
      | "invalid_observability_config";
    invalidJsonMessage?: string;
  } = {},
): Promise<T> {
  const file = Bun.file(path);

  try {
    if (!(await file.exists())) {
      return fallback;
    }

    const content = await file.text();
    return JSON.parse(content) as T;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new QuestDomainError({
        code: options.invalidJsonCode ?? "invalid_worker_registry",
        details: { path },
        message: options.invalidJsonMessage ?? `Invalid JSON in registry file: ${path}`,
        statusCode: 1,
      });
    }

    throw new QuestDomainError({
      code: "quest_storage_failure",
      details: { path, reason: error instanceof Error ? error.message : String(error) },
      message: `Failed to read quest state from ${path}`,
      statusCode: 1,
    });
  }
}

export async function writeJsonFileAtomically(path: string, payload: unknown): Promise<void> {
  const parentDir = dirname(path);
  const tempPath = `${path}.${crypto.randomUUID()}.tmp`;

  try {
    await mkdir(parentDir, { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  } catch (error: unknown) {
    throw new QuestDomainError({
      code: "quest_storage_failure",
      details: { path, reason: error instanceof Error ? error.message : String(error) },
      message: `Failed to write quest state to ${path}`,
      statusCode: 1,
    });
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
  } catch (error: unknown) {
    throw new QuestDomainError({
      code: "quest_storage_failure",
      details: { path, reason: error instanceof Error ? error.message : String(error) },
      message: `Failed to prepare quest directory at ${path}`,
      statusCode: 1,
    });
  }
}
