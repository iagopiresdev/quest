import type {
  ObservableCalibrationEvent,
  ObservableEvent,
  ObservableRunEvent,
} from "../observable-events";

function formatRunMessage(event: ObservableRunEvent): string {
  return [
    "quest-runner event",
    `event: ${event.eventType}`,
    `run: ${event.runId}`,
    `title: ${event.title}`,
    `status: ${event.runStatus}`,
    `workspace: ${event.workspace}`,
  ].join("\n");
}

function formatCalibrationMessage(event: ObservableCalibrationEvent): string {
  return [
    "quest-runner calibration",
    `event: ${event.eventType}`,
    `worker: ${event.workerName} (${event.workerId})`,
    `suite: ${event.suiteId}`,
    `status: ${event.status}`,
    `score: ${event.score}`,
    `xp: ${event.xpAwarded}`,
    `run: ${event.runId}`,
  ].join("\n");
}

export function formatSinkTextMessage(event: ObservableEvent): string {
  return event.kind === "run" ? formatRunMessage(event) : formatCalibrationMessage(event);
}
