import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

export function resolveQuestRunPath(
  runId: string,
  options: {
    explicitRunsRoot?: string;
    stateRoot?: string;
  } = {},
): string {
  return join(resolveQuestRunsRoot(options), `${runId}.json`);
}

export async function readJsonFileOrDefault<T>(path: string, fallback: T): Promise<T> {
  try {
    const content = await readFile(path, "utf8");
    return JSON.parse(content) as T;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return fallback;
    }

    if (error instanceof SyntaxError) {
      throw new QuestDomainError({
        code: "invalid_worker_registry",
        details: { path },
        message: `Invalid JSON in registry file: ${path}`,
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
