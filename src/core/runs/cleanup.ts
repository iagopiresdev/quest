import { readdir, stat } from "node:fs/promises";
import { QuestDomainError } from "../errors";
import { SecretStore } from "../secret-store";
import type { WorkerRegistry } from "../workers/registry";
import { cleanupRunOpenClawAgents } from "./adapters/openclaw-maintenance";
import { appendEvent } from "./lifecycle";
import type { QuestRunDocument } from "./schema";
import type { QuestRunListWarning, QuestRunStore } from "./store";
import { cleanupExecutionWorkspaces } from "./workspace-materializer";

export type QuestWorkspacePruneStatus =
  | "aborted"
  | "completed"
  | "failed"
  | "integrated"
  | "landed"
  | "orphaned"
  | "rescued";

export type QuestWorkspacePruneResult = {
  dryRun: boolean;
  pruned: Array<{
    runId: string;
    status: QuestWorkspacePruneStatus;
    workspaceRoot: string | null;
  }>;
  skipped: Array<{
    reason: string;
    runId: string;
    status: QuestWorkspacePruneStatus;
  }>;
  usage: {
    exceedsThreshold: boolean;
    thresholdBytes: number;
    workspaceBytes: number;
  };
  warnings: QuestRunListWarning[];
};

async function measureDirectoryBytes(path: string): Promise<number> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const entryPath = `${path}/${entry.name}`;
      if (entry.isDirectory()) {
        total += await measureDirectoryBytes(entryPath);
        continue;
      }

      if (entry.isFile()) {
        total += (await stat(entryPath)).size;
      }
    }

    return total;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return 0;
    }

    throw new QuestDomainError({
      code: "quest_storage_failure",
      details: { path, reason: error instanceof Error ? error.message : String(error) },
      message: `Failed to inspect quest workspace usage at ${path}`,
      statusCode: 1,
    });
  }
}

function requireCleanupableRun(run: QuestRunDocument): void {
  if (run.status === "running") {
    throw new QuestDomainError({
      code: "quest_run_not_cleanupable",
      details: { runId: run.id, status: run.status },
      message: `Quest run ${run.id} cannot be cleaned up while running`,
      statusCode: 1,
    });
  }

  if (
    run.sourceRepositoryPath &&
    run.status !== "aborted" &&
    !run.events.some((event) => event.type === "run_integration_checks_failed") &&
    !run.events.some((event) => event.type === "run_integrated")
  ) {
    // Aborted runs and failed boss fights already gave up their replay path, so keeping their
    // worktrees only leaves stale editor/indexer roots behind. Completed runs still need a real
    // turn-in before cleanup removes the integration path.
    throw new QuestDomainError({
      code: "quest_run_not_cleanupable",
      details: { runId: run.id, status: run.status },
      message: `Quest run ${run.id} cannot be cleaned before integration finishes`,
      statusCode: 1,
    });
  }
}

function classifyPruneStatus(run: QuestRunDocument): QuestWorkspacePruneStatus {
  if (run.integrationRescueStatus === "rescued") {
    return "rescued";
  }

  if (run.landedAt) {
    return "landed";
  }

  if (run.events.some((event) => event.type === "run_integrated")) {
    return "integrated";
  }

  if (run.status === "aborted") {
    return "aborted";
  }

  if (run.status === "completed") {
    return "completed";
  }

  if (run.status === "failed") {
    return "failed";
  }

  return "orphaned";
}

function resolvePruneReferenceTimestamp(run: QuestRunDocument): string {
  return run.landedAt ?? run.updatedAt;
}

export class QuestRunCleanup {
  constructor(
    private readonly runStore: QuestRunStore,
    private readonly workerRegistry?: WorkerRegistry,
    private readonly secretStore: SecretStore = new SecretStore(),
  ) {}

  async cleanupRun(runId: string): Promise<QuestRunDocument> {
    const run = await this.runStore.getRun(runId);
    requireCleanupableRun(run);
    await cleanupExecutionWorkspaces(run);
    const openClawCleanupWarnings =
      this.workerRegistry === undefined
        ? []
        : await cleanupRunOpenClawAgents(
            run,
            await this.workerRegistry.listWorkers(),
            this.secretStore,
          );
    appendEvent(run, "run_workspace_cleaned", {
      openClawCleanupWarnings,
      runId,
    });
    return await this.runStore.saveRun(run);
  }

  async pruneWorkspaces(
    options: {
      dryRun?: boolean | undefined;
      olderThanMs?: number | undefined;
      skipInvalidSchema?: boolean | undefined;
      statuses?: QuestWorkspacePruneStatus[] | undefined;
      warningThresholdBytes?: number | undefined;
    } = {},
  ): Promise<QuestWorkspacePruneResult> {
    const olderThanMs = options.olderThanMs ?? 72 * 60 * 60 * 1000;
    const statuses = new Set(options.statuses ?? ["landed", "completed", "aborted", "orphaned"]);
    const workspaceBytes = await measureDirectoryBytes(this.runStore.getWorkspacesRoot());
    const thresholdBytes = options.warningThresholdBytes ?? 2 * 1024 * 1024 * 1024;
    const listed = await this.runStore.listRunsWithWarnings(
      options.skipInvalidSchema === undefined
        ? {}
        : {
            skipInvalidSchema: options.skipInvalidSchema,
          },
    );
    const now = Date.now();
    const result: QuestWorkspacePruneResult = {
      dryRun: options.dryRun === true,
      pruned: [],
      skipped: [],
      usage: {
        exceedsThreshold: workspaceBytes >= thresholdBytes,
        thresholdBytes,
        workspaceBytes,
      },
      warnings: listed.warnings,
    };

    for (const summary of listed.runs) {
      const run = await this.runStore.getRun(summary.id);
      const status = classifyPruneStatus(run);
      if (!statuses.has(status)) {
        result.skipped.push({
          reason: "status_filtered",
          runId: run.id,
          status,
        });
        continue;
      }

      const referenceTimestamp = Date.parse(resolvePruneReferenceTimestamp(run));
      if (!Number.isFinite(referenceTimestamp) || now - referenceTimestamp < olderThanMs) {
        result.skipped.push({
          reason: "too_recent",
          runId: run.id,
          status,
        });
        continue;
      }

      try {
        if (options.dryRun) {
          result.pruned.push({
            runId: run.id,
            status,
            workspaceRoot: run.workspaceRoot ?? null,
          });
        } else {
          const cleaned = await this.cleanupRun(run.id);
          result.pruned.push({
            runId: cleaned.id,
            status,
            workspaceRoot: cleaned.workspaceRoot ?? null,
          });
        }
      } catch (error: unknown) {
        result.skipped.push({
          reason: error instanceof Error ? error.message : String(error),
          runId: run.id,
          status,
        });
      }
    }

    return result;
  }
}
