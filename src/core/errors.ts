export const QUEST_ERROR_CODES = [
  "invalid_worker_registry",
  "invalid_worker_definition",
  "quest_acceptance_check_failed",
  "invalid_quest_run",
  "invalid_quest_spec",
  "quest_dependency_cycle",
  "quest_runner_command_failed",
  "quest_run_not_cleanupable",
  "quest_source_repo_dirty",
  "quest_source_repo_invalid",
  "quest_run_not_executable",
  "quest_run_not_found",
  "quest_run_not_abortable",
  "quest_runner_unavailable",
  "quest_unknown_dependency",
  "quest_workspace_materialization_failed",
  "quest_worker_not_found",
  "quest_storage_failure",
] as const;

export type QuestErrorCode = (typeof QUEST_ERROR_CODES)[number];

export class QuestDomainError extends Error {
  readonly code: QuestErrorCode;
  readonly details?: unknown;
  readonly statusCode: number;

  constructor(options: {
    code: QuestErrorCode;
    details?: unknown;
    message: string;
    statusCode?: number;
  }) {
    super(options.message);
    this.name = "QuestDomainError";
    this.code = options.code;
    this.details = options.details;
    this.statusCode = options.statusCode ?? 400;
  }
}

export function isQuestDomainError(error: unknown): error is QuestDomainError {
  return error instanceof QuestDomainError;
}
