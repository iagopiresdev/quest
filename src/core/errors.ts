export const QUEST_ERROR_CODES = [
  "invalid_worker_registry",
  "invalid_worker_definition",
  "invalid_observability_config",
  "invalid_quest_party_state",
  "invalid_quest_settings",
  "quest_acceptance_check_failed",
  "quest_feature_doc_failed",
  "quest_integration_failed",
  "invalid_quest_run",
  "invalid_quest_spec",
  "quest_dependency_cycle",
  "quest_command_failed",
  "quest_run_not_landable",
  "quest_run_not_integratable",
  "quest_run_invalid_execute_options",
  "quest_run_not_cleanupable",
  "quest_source_repo_dirty",
  "quest_source_repo_invalid",
  "quest_run_not_executable",
  "quest_run_not_found",
  "quest_run_not_abortable",
  "quest_run_not_steerable",
  "quest_run_not_rerunnable",
  "quest_party_resting",
  "quest_unavailable",
  "quest_subprocess_aborted",
  "quest_subprocess_timed_out",
  "quest_unknown_dependency",
  "quest_workspace_materialization_failed",
  "quest_workspace_prepare_failed",
  "quest_worker_not_found",
  "quest_slice_not_steerable",
  "quest_daemon_already_running",
  "quest_daemon_not_running",
  "quest_daemon_party_exists",
  "quest_daemon_party_not_found",
  "quest_daemon_party_resting",
  "invalid_quest_daemon_config",
  "invalid_quest_daemon_state",
  "quest_observability_sink_not_found",
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
