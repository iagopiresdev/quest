import { z } from "zod";

export const observableRunEventTypeSchema = z.enum([
  "run_created",
  "run_blocked",
  "run_started",
  "run_completed",
  "run_failed",
  "run_aborted",
  "run_integration_started",
  "run_integration_checks_started",
  "run_integration_checks_completed",
  "run_integration_checks_failed",
  "run_integrated",
  "run_feature_doc_written",
  "run_workspace_cleaned",
  "slice_started",
  "slice_integrated",
  "slice_testing_started",
  "slice_testing_completed",
  "slice_testing_failed",
  "slice_completed",
  "slice_failed",
  "slice_aborted",
]);
export type ObservableRunEventType = z.infer<typeof observableRunEventTypeSchema>;

export const observableCalibrationEventTypeSchema = z.enum(["worker_calibration_recorded"]);
export type ObservableCalibrationEventType = z.infer<typeof observableCalibrationEventTypeSchema>;

export const observableEventTypeSchema = z.union([
  observableRunEventTypeSchema,
  observableCalibrationEventTypeSchema,
]);
export type ObservableEventType = z.infer<typeof observableEventTypeSchema>;
