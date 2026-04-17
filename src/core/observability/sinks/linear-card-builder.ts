// Linear markdown cards for Quest Runner observability events.
//
// Linear issue comments render GitHub-flavored Markdown. Unlike Telegram (tight HTML cards
// optimized for mobile), Linear comments are read on desktop alongside the full issue thread,
// so we lean into richer structure: H2 headings, italicized flavor tag, a bulleted fact list,
// fenced code blocks for errors, and a small italic footer with a local clock.
//
// The RPG flavor (⚔️ Quest Accepted, 💀 Party Wiped, etc.) matches the Telegram card builder
// one-for-one so the two sinks feel like the same product, not two different notification
// voices.
//
// Linear's GraphQL `commentCreate` accepts Markdown in the `body` field directly. No escaping
// is required beyond standard Markdown literals because Linear doesn't apply HTML parsing to
// the comment body.

import type {
  ObservableCalibrationEvent,
  ObservableDaemonEvent,
  ObservableEvent,
  ObservableRunEvent,
} from "../observable-events";

type RpgCopy = { header: string; flavor: string };

function formatClock(tz = "America/Sao_Paulo"): string {
  return new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    timeZone: tz,
  });
}

function daemonCopy(eventType: ObservableDaemonEvent["eventType"]): RpgCopy {
  switch (eventType) {
    case "daemon_dispatched":
      return { flavor: "The party sets forth.", header: "⚔️ Quest Accepted" };
    case "daemon_landed":
      return { flavor: "Victory. The spoils are claimed.", header: "🏆 Quest Cleared" };
    case "daemon_failed":
      return { flavor: "You died.", header: "💀 Party Wiped" };
    case "daemon_budget_exhausted":
      return {
        flavor: "Mana runs dry. Rest before pressing on.",
        header: "🌙 Out of Stamina",
      };
    case "daemon_recovered":
      return {
        flavor: "Saved at the last moment by the keeper's hand.",
        header: "✨ Party Revived",
      };
    case "daemon_party_created":
      return { flavor: "A new fellowship forms.", header: "🛡️ Party Assembled" };
    case "daemon_party_resting":
      return {
        flavor: "Embers crackle. The world pauses.",
        header: "🔥 Resting at Bonfire",
      };
    case "daemon_party_resumed":
      return {
        flavor: "Steel sharpened. The quest continues.",
        header: "⚔️ Bonfire Departed",
      };
  }
}

function runCopy(eventType: ObservableRunEvent["eventType"]): string {
  switch (eventType) {
    case "run_created":
      return "📜 Quest Scribed";
    case "run_blocked":
      return "🚫 Quest Halted";
    case "run_started":
      return "⚔️ Quest Begun";
    case "run_completed":
      return "🏆 Quest Cleared";
    case "run_failed":
      return "💀 Quest Lost";
    case "run_aborted":
      return "🏳️ Quest Abandoned";
    case "run_integration_started":
      return "🧵 Weaving the Branches";
    case "run_integration_checks_started":
      return "🔮 Trials Begin";
    case "run_integration_checks_completed":
      return "✨ Trials Endured";
    case "run_integration_checks_failed":
      return "💥 Trials Broke You";
    case "run_integrated":
      return "🔀 Quest Sealed";
    case "run_feature_doc_written":
      return "📚 Lore Inscribed";
    case "run_workspace_cleaned":
      return "🧹 Camp Struck";
    case "slice_started":
      return "⚔️ Encounter Engaged";
    case "slice_integrated":
      return "🔀 Encounter Sealed";
    case "slice_testing_started":
      return "🔮 Trial by Fire";
    case "slice_testing_completed":
      return "✨ Trial Endured";
    case "slice_testing_failed":
      return "💥 Trial Failed";
    case "slice_completed":
      return "🏹 Encounter Cleared";
    case "slice_failed":
      return "🗡️ Encounter Lost";
    case "slice_aborted":
      return "🏳️ Encounter Abandoned";
  }
}

// Backticks inside inline code spans would break Linear's markdown rendering. Spec filenames
// and run IDs never legitimately contain backticks, but belt-and-suspenders: strip if seen.
function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "")}\``;
}

function formatDaemonCard(event: ObservableDaemonEvent): string {
  const { flavor, header } = daemonCopy(event.eventType);
  const partyLabel = event.partyName === "*" ? "all parties" : event.partyName;
  const facts: string[] = [`- **Party:** ${partyLabel}`];
  if (event.specFile) {
    facts.push(`- **Spec:** ${inlineCode(event.specFile)}`);
  }
  if (event.runId) {
    facts.push(`- **Run:** ${inlineCode(event.runId)}`);
  }
  if (event.trackerIssueId) {
    facts.push(`- **Tracker:** ${inlineCode(event.trackerIssueId)}`);
  }
  if (event.reason) {
    facts.push(`- **Reason:** ${event.reason}`);
  }
  const sections: string[] = [`## ${header}`, `_${flavor}_`, "---", facts.join("\n")];
  if (event.error) {
    sections.push(`**Error:**\n\n\`\`\`\n${event.error.slice(0, 2000)}\n\`\`\``);
  }
  sections.push(`_⌛ ${formatClock()}_`);
  return sections.join("\n\n");
}

function formatRunCard(event: ObservableRunEvent): string {
  const header = runCopy(event.eventType);
  const facts = [
    `- **Title:** ${event.title}`,
    `- **Run:** ${inlineCode(event.runId)}`,
    `- **Status:** ${event.runStatus}`,
    `- **Workspace:** ${event.workspace}`,
  ];
  return [`## ${header}`, "---", facts.join("\n"), `_⌛ ${formatClock()}_`].join("\n\n");
}

function formatCalibrationCard(event: ObservableCalibrationEvent): string {
  const header = event.status === "passed" ? "🌟 Training Mastered" : "🛡️ Training Failed";
  const facts = [
    `- **Worker:** ${event.workerName} (${inlineCode(event.workerId)})`,
    `- **Suite:** ${event.suiteId}`,
    `- **Score:** ${event.score}`,
    `- **XP Awarded:** +${event.xpAwarded}`,
    `- **Run:** ${inlineCode(event.runId)}`,
  ];
  return [`## ${header}`, "---", facts.join("\n"), `_⌛ ${formatClock()}_`].join("\n\n");
}

export function formatLinearCard(event: ObservableEvent): string {
  switch (event.kind) {
    case "run":
      return formatRunCard(event);
    case "worker_calibration":
      return formatCalibrationCard(event);
    case "daemon":
      return formatDaemonCard(event);
  }
}
