import type {
  ObservableCalibrationEvent,
  ObservableDaemonEvent,
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

function formatDaemonMessage(event: ObservableDaemonEvent): string {
  const lines = ["quest-runner daemon", `event: ${event.eventType}`, `party: ${event.partyName}`];
  if (event.specFile) {
    lines.push(`spec: ${event.specFile}`);
  }
  if (event.runId) {
    lines.push(`run: ${event.runId}`);
  }
  if (event.reason) {
    lines.push(`reason: ${event.reason}`);
  }
  if (event.error) {
    lines.push(`error: ${event.error}`);
  }
  return lines.join("\n");
}

export function formatSinkTextMessage(event: ObservableEvent): string {
  switch (event.kind) {
    case "run":
      return formatRunMessage(event);
    case "worker_calibration":
      return formatCalibrationMessage(event);
    case "daemon":
      return formatDaemonMessage(event);
  }
}
