import type { ObservableEvent } from "./schema";

export function createSinkProbeEvent(label: string): ObservableEvent {
  const at = new Date().toISOString();
  return {
    details: {
      label,
      probe: true,
    },
    eventId: `run:quest-doctor-probe:${label}:${at}`,
    eventType: "run_completed",
    kind: "run",
    occurredAt: at,
    runId: "quest-doctor-probe",
    runStatus: "completed",
    sourceRepositoryPath: null,
    title: `Quest sink probe (${label})`,
    trackerIssueId: null,
    workspace: "doctor",
  };
}
