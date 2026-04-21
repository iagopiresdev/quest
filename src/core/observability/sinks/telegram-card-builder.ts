// Telegram HTML cards for Quest observability events.
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

type DaemonFlavor = { header: string; flavor: string };

function daemonFlavor(eventType: ObservableDaemonEvent["eventType"]): DaemonFlavor {
  switch (eventType) {
    case "daemon_dispatched":
      return {
        flavor: "The party sets forth.",
        header: "⚔️ <b>Quest Accepted</b>",
      };
    case "daemon_landed":
      return {
        flavor: "Victory. The spoils are claimed.",
        header: "🏆 <b>Quest Cleared</b>",
      };
    case "daemon_failed":
      return {
        flavor: "You died.",
        header: "💀 <b>Party Wiped</b>",
      };
    case "daemon_budget_exhausted":
      return {
        flavor: "Mana runs dry. Rest before pressing on.",
        header: "🌙 <b>Out of Stamina</b>",
      };
    case "daemon_recovered":
      return {
        flavor: "Saved at the last moment by the keeper's hand.",
        header: "✨ <b>Party Revived</b>",
      };
    case "daemon_party_created":
      return {
        flavor: "A new fellowship forms.",
        header: "🛡️ <b>Party Assembled</b>",
      };
    case "daemon_party_resting":
      return {
        flavor: "Embers crackle. The world pauses.",
        header: "🔥 <b>Resting at Bonfire</b>",
      };
    case "daemon_party_resumed":
      return {
        flavor: "Steel sharpened. The quest continues.",
        header: "⚔️ <b>Bonfire Departed</b>",
      };
  }
}

function runHeader(eventType: ObservableRunEvent["eventType"]): string {
  switch (eventType) {
    case "run_created":
      return "📜 <b>Quest Scribed</b>";
    case "run_blocked":
      return "🚫 <b>Quest Halted</b>";
    case "run_started":
      return "⚔️ <b>Quest Begun</b>";
    case "run_paused":
      return "⏸️ <b>Quest Paused</b>";
    case "run_resumed":
      return "▶️ <b>Quest Resumed</b>";
    case "run_orphaned":
      return "🧭 <b>Quest Orphaned</b>";
    case "run_cancel_requested":
      return "🛑 <b>Retreat Called</b>";
    case "run_completed":
      return "🏆 <b>Quest Cleared</b>";
    case "run_failed":
      return "💀 <b>Quest Lost</b>";
    case "run_aborted":
      return "🏳️ <b>Quest Abandoned</b>";
    case "run_integration_started":
      return "🧵 <b>Weaving the Branches</b>";
    case "run_integration_failed":
      return "💥 <b>Weaving Failed</b>";
    case "run_integration_checks_started":
      return "🔮 <b>Trials Begin</b>";
    case "run_integration_checks_completed":
      return "✨ <b>Trials Endured</b>";
    case "run_integration_checks_failed":
      return "💥 <b>Trials Broke You</b>";
    case "run_integrated":
      return "🔀 <b>Quest Sealed</b>";
    case "run_landing_started":
      return "📦 <b>Turn-in Started</b>";
    case "run_landed":
      return "✅ <b>Turn-in Complete</b>";
    case "run_base_refreshed":
      return "🔄 <b>Base Refreshed</b>";
    case "run_rescue_status_updated":
      return "🛟 <b>Rescue Updated</b>";
    case "run_feature_doc_written":
      return "📚 <b>Lore Inscribed</b>";
    case "run_workspace_cleaned":
      return "🧹 <b>Camp Struck</b>";
    case "slice_started":
      return "⚔️ <b>Encounter Engaged</b>";
    case "slice_integrated":
      return "🔀 <b>Encounter Sealed</b>";
    case "slice_testing_started":
      return "🔮 <b>Trial by Fire</b>";
    case "slice_testing_completed":
      return "✨ <b>Trial Endured</b>";
    case "slice_testing_failed":
      return "💥 <b>Trial Failed</b>";
    case "slice_completed":
      return "🏹 <b>Encounter Cleared</b>";
    case "slice_skipped":
      return "⏭️ <b>Encounter Skipped</b>";
    case "slice_reassigned":
      return "🔁 <b>Encounter Reassigned</b>";
    case "slice_retry_queued":
      return "🔄 <b>Encounter Retried</b>";
    case "slice_failed":
      return "🗡️ <b>Encounter Lost</b>";
    case "slice_aborted":
      return "🏳️ <b>Encounter Abandoned</b>";
  }
}

function formatDaemonCard(event: ObservableDaemonEvent): string {
  const { flavor, header } = daemonFlavor(event.eventType);
  const partyLabel = event.partyName === "*" ? "all parties" : escapeHtml(event.partyName);
  const lines = [header, `<i>${flavor}</i>`, SEPARATOR, `🛡️ ${partyLabel}`];
  if (event.specFile) {
    lines.push(`📜 <code>${escapeHtml(event.specFile)}</code>`);
  }
  if (event.runId) {
    lines.push(`🧭 <code>${escapeHtml(event.runId)}</code>`);
  }
  if (event.reason) {
    lines.push(`📝 ${escapeHtml(event.reason)}`);
  }
  if (event.error) {
    lines.push(`<blockquote>${escapeHtml(event.error.slice(0, 300))}</blockquote>`);
  }
  lines.push(`⌛ ${formatClock()}`);
  return lines.join("\n");
}

function formatRunCard(event: ObservableRunEvent): string {
  const lines = [
    runHeader(event.eventType),
    SEPARATOR,
    `📖 ${escapeHtml(event.title)}`,
    `🧭 <code>${escapeHtml(event.runId)}</code>`,
    `📍 ${escapeHtml(event.runStatus)} · ${escapeHtml(event.workspace)}`,
    `⌛ ${formatClock()}`,
  ];
  return lines.join("\n");
}

function formatCalibrationCard(event: ObservableCalibrationEvent): string {
  const header =
    event.status === "passed" ? "🌟 <b>Training Mastered</b>" : "🛡️ <b>Training Failed</b>";
  const lines = [
    header,
    SEPARATOR,
    `🧙 ${escapeHtml(event.workerName)} · <code>${escapeHtml(event.workerId)}</code>`,
    `📜 ${escapeHtml(event.suiteId)}`,
    `💯 ${event.score} · ⭐ +${event.xpAwarded} XP`,
    `⌛ ${formatClock()}`,
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
