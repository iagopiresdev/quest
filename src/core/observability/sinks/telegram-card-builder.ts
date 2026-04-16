// Telegram HTML cards for Quest Runner observability events.
//
// Card builder: emoji + bold title, separator, structured fields with
// emoji prefixes, optional blockquote for error detail, and a local clock footer. HTML
// parse mode keeps the payload small (no MarkdownV2 escape landmines) while still giving us bold
// titles and inline <code> for spec/run IDs.
//
// This is Telegram-only. Slack, Linear, webhook, OpenClaw keep the plain-text formatter in
// message-format.ts so payloads stay portable.

import type {
  ObservableCalibrationEvent,
  ObservableDaemonEvent,
  ObservableEvent,
  ObservableRunEvent,
} from "../observable-events";

const SEPARATOR = "━━━━━━━━━━━━━━━━";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatClock(tz = "America/Sao_Paulo"): string {
  return new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    timeZone: tz,
  });
}

function daemonHeader(eventType: ObservableDaemonEvent["eventType"]): string {
  switch (eventType) {
    case "daemon_dispatched":
      return "🎯 <b>Quest Dispatched</b>";
    case "daemon_landed":
      return "✅ <b>Quest Landed</b>";
    case "daemon_failed":
      return "❌ <b>Quest Failed</b>";
    case "daemon_budget_exhausted":
      return "⏸️ <b>Budget Exhausted</b>";
    case "daemon_recovered":
      return "🩹 <b>Daemon Recovered</b>";
    case "daemon_party_created":
      return "🎉 <b>Party Created</b>";
    case "daemon_party_resting":
      return "🔥 <b>Party Resting</b>";
    case "daemon_party_resumed":
      return "⚡ <b>Party Resumed</b>";
  }
}

function runHeader(eventType: ObservableRunEvent["eventType"]): string {
  switch (eventType) {
    case "run_created":
      return "📝 <b>Run Created</b>";
    case "run_blocked":
      return "🚧 <b>Run Blocked</b>";
    case "run_started":
      return "🏗️ <b>Run Started</b>";
    case "run_completed":
      return "✅ <b>Run Completed</b>";
    case "run_failed":
      return "❌ <b>Run Failed</b>";
    case "run_aborted":
      return "🛑 <b>Run Aborted</b>";
    case "run_integration_started":
      return "🔗 <b>Integration Started</b>";
    case "run_integration_checks_started":
      return "🧪 <b>Integration Checks</b>";
    case "run_integration_checks_completed":
      return "✅ <b>Integration Checks Passed</b>";
    case "run_integration_checks_failed":
      return "❌ <b>Integration Checks Failed</b>";
    case "run_integrated":
      return "🔀 <b>Run Integrated</b>";
    case "run_feature_doc_written":
      return "📚 <b>Feature Doc Written</b>";
    case "run_workspace_cleaned":
      return "🧹 <b>Workspace Cleaned</b>";
    case "slice_started":
      return "▶️ <b>Slice Started</b>";
    case "slice_integrated":
      return "🔀 <b>Slice Integrated</b>";
    case "slice_testing_started":
      return "🧪 <b>Slice Testing</b>";
    case "slice_testing_completed":
      return "✅ <b>Slice Tests Passed</b>";
    case "slice_testing_failed":
      return "❌ <b>Slice Tests Failed</b>";
    case "slice_completed":
      return "✅ <b>Slice Completed</b>";
    case "slice_failed":
      return "❌ <b>Slice Failed</b>";
    case "slice_aborted":
      return "🛑 <b>Slice Aborted</b>";
  }
}

function formatDaemonCard(event: ObservableDaemonEvent): string {
  const lines = [daemonHeader(event.eventType), SEPARATOR];
  const partyLabel = event.partyName === "*" ? "(all parties)" : escapeHtml(event.partyName);
  lines.push(`🎭 ${partyLabel}`);
  if (event.specFile) {
    lines.push(`📋 <code>${escapeHtml(event.specFile)}</code>`);
  }
  if (event.runId) {
    lines.push(`🧵 <code>${escapeHtml(event.runId)}</code>`);
  }
  if (event.reason) {
    lines.push(`💬 ${escapeHtml(event.reason)}`);
  }
  if (event.error) {
    lines.push(`<blockquote>${escapeHtml(event.error.slice(0, 300))}</blockquote>`);
  }
  lines.push(`🕐 ${formatClock()}`);
  return lines.join("\n");
}

function formatRunCard(event: ObservableRunEvent): string {
  const lines = [runHeader(event.eventType), SEPARATOR];
  lines.push(`📦 ${escapeHtml(event.title)}`);
  lines.push(`🧵 <code>${escapeHtml(event.runId)}</code>`);
  lines.push(`📊 ${escapeHtml(event.runStatus)} · ${escapeHtml(event.workspace)}`);
  lines.push(`🕐 ${formatClock()}`);
  return lines.join("\n");
}

function formatCalibrationCard(event: ObservableCalibrationEvent): string {
  const statusIcon = event.status === "passed" ? "✅" : "❌";
  const lines = [
    `${statusIcon} <b>Calibration ${event.status}</b>`,
    SEPARATOR,
    `👤 ${escapeHtml(event.workerName)} · <code>${escapeHtml(event.workerId)}</code>`,
    `📚 ${escapeHtml(event.suiteId)}`,
    `💯 ${event.score} · +${event.xpAwarded} XP`,
    `🕐 ${formatClock()}`,
  ];
  return lines.join("\n");
}

export function formatTelegramCard(event: ObservableEvent): string {
  switch (event.kind) {
    case "run":
      return formatRunCard(event);
    case "worker_calibration":
      return formatCalibrationCard(event);
    case "daemon":
      return formatDaemonCard(event);
  }
}
