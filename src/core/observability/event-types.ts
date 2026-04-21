import { z } from "zod";

import { questRunEventTypeValues } from "../runs/schema";

export const observableRunEventTypeSchema = z.enum(questRunEventTypeValues);
export type ObservableRunEventType = z.infer<typeof observableRunEventTypeSchema>;

export const observableCalibrationEventTypeSchema = z.enum(["worker_calibration_recorded"]);
export type ObservableCalibrationEventType = z.infer<typeof observableCalibrationEventTypeSchema>;

export const observableDaemonEventTypeSchema = z.enum([
  "daemon_dispatched",
  "daemon_landed",
  "daemon_failed",
  "daemon_budget_exhausted",
  "daemon_recovered",
  "daemon_party_created",
  "daemon_party_resting",
  "daemon_party_resumed",
]);
export type ObservableDaemonEventType = z.infer<typeof observableDaemonEventTypeSchema>;

export const observableEventTypeSchema = z.union([
  observableRunEventTypeSchema,
  observableCalibrationEventTypeSchema,
  observableDaemonEventTypeSchema,
]);
export type ObservableEventType = z.infer<typeof observableEventTypeSchema>;
