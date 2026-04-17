// Categorized help for the `quest` CLI.
//
// The flat usage dump (one line per every command × flag) is still available under `quest --help`
// for operators who want the machine-readable version. This module renders a curated, grouped
// view that looks closer to a well-produced CLI reference: section headers, inline comments per
// command, color-accented flag names, and omission of the state-root / workspaces-root / registry
// boilerplate that applies to almost every command.

import { colorize, isInteractiveOutput } from "./terminal";

type HelpEntry = {
  // Short prose shown on the line above the command (rendered as a comment).
  comment: string;
  // The canonical invocation, colored at render time. Keep it to the meaningful flags.
  invocation: string;
};

type HelpSection = {
  entries: HelpEntry[];
  title: string;
};

const HELP_SECTIONS: HelpSection[] = [
  {
    entries: [
      {
        comment: "Bootstrap workers, defaults, and your first sink",
        invocation: "quest setup",
      },
      {
        comment: "Non-interactive bootstrap for scripts and agents",
        invocation: "quest setup --yes --backend <codex|hermes|openclaw>",
      },
      {
        comment: "Probe binaries, backends, sinks, and state roots",
        invocation: "quest doctor [--test-sinks]",
      },
    ],
    title: "INSTALL",
  },
  {
    entries: [
      {
        comment: "Register a new party tied to a source repo and target ref",
        invocation: "quest party create --name <party> --source-repo <path> --target-ref <ref>",
      },
      {
        comment: "Pause new dispatch for one party (in-flight work finishes)",
        invocation: "quest party bonfire --name <party> [--reason <text>]",
      },
      {
        comment: "Resume dispatch after a bonfire",
        invocation: "quest party resume --name <party>",
      },
      {
        comment: "Inspect party state and queue depths",
        invocation: "quest party status [--name <party>]",
      },
      {
        comment: "List all parties",
        invocation: "quest party list",
      },
    ],
    title: "PARTY LIFECYCLE",
  },
  {
    entries: [
      {
        comment: "Plan a run from a spec (JSON or YAML) without executing",
        invocation: "quest run --file <spec> [--source-repo <path>] [--worker-id <id>]",
      },
      {
        comment: "Execute a planned run; optionally integrate and land in one pass",
        invocation: "quest runs execute --id <run> [--auto-integrate] [--land]",
      },
      {
        comment: "Merge a completed run back into the source repo",
        invocation: "quest runs integrate --id <run>",
      },
      {
        comment: "Land an integrated run (commit to target ref)",
        invocation: "quest runs land --id <run>",
      },
      {
        comment: "Refresh an integration workspace against a drifted base",
        invocation: "quest runs refresh-base --id <run>",
      },
      {
        comment: "Re-run a past run reusing its spec and source repo",
        invocation: "quest runs rerun --id <run>",
      },
    ],
    title: "QUEST LIFECYCLE",
  },
  {
    entries: [
      {
        comment: "List runs, live-tail status, inspect slice state",
        invocation: "quest runs list / runs status --id <run> / runs watch",
      },
      {
        comment: "Cancel, rescue, or babysit stuck runs",
        invocation: "quest runs cancel --id <run> / runs rescue / runs babysit",
      },
      {
        comment: "Re-dispatch a single slice",
        invocation: "quest runs slices retry --id <run> --slice <slice>",
      },
      {
        comment: "Reassign a slice to a different worker",
        invocation: "quest runs slices reassign --id <run> --slice <slice> --worker-id <id>",
      },
      {
        comment: "Quarantine schema-invalid runs under workspaces/.quarantine",
        invocation: "quest runs quarantine --id <run>",
      },
      {
        comment: "Remove workspaces for terminal runs; --dry-run previews",
        invocation: "quest workspaces prune [--dry-run] [--warning-threshold-bytes <n>]",
      },
    ],
    title: "RUN OPERATIONS",
  },
  {
    entries: [
      {
        comment: "Register or update a sink (webhook / telegram / slack / linear / openclaw)",
        invocation: "quest observability <kind> upsert --id <sink> ...",
      },
      {
        comment: "List configured sinks and event filters",
        invocation: "quest observability sinks list",
      },
      {
        comment: "Send a synthetic probe through a sink to validate wiring",
        invocation: "quest observability sinks test [--id <sink>]",
      },
      {
        comment: "Inspect recent deliveries and retry failures",
        invocation: "quest observability deliveries list / deliveries retry",
      },
      {
        comment: "Replay run events through the sink pipeline",
        invocation: "quest observability events list --run-id <run>",
      },
    ],
    title: "OBSERVABILITY",
  },
  {
    entries: [
      {
        comment: "Run the dispatcher loop (long-lived supervisor)",
        invocation: "quest daemon start / daemon stop / daemon status",
      },
      {
        comment: "Single-shot tick for canaries and scripted checks",
        invocation: "quest daemon tick",
      },
    ],
    title: "DAEMON",
  },
  {
    entries: [
      {
        comment: "Add / update / list workers behind a chosen backend",
        invocation: "quest workers add <codex|hermes|openclaw> / workers upsert --stdin",
      },
      {
        comment: "Send a worker to the training grounds calibration suite",
        invocation: "quest workers calibrate --id <worker>",
      },
      {
        comment: "Inspect, enable, disable, or review history",
        invocation: "quest workers inspect --id <worker> / workers update --id <worker>",
      },
    ],
    title: "WORKERS",
  },
  {
    entries: [
      {
        comment: "Manage macOS Keychain-backed secrets for sinks and workers",
        invocation: "quest secrets set --name <name> --stdin / secrets delete / secrets status",
      },
    ],
    title: "SECRETS",
  },
];

const FOOTER_LINES = [
  "Flags `--json` / `--pretty` are global: JSON is the default when piped; pretty renders in a TTY.",
  "Full flag reference: quest --help       Per-command details: quest <command> --help",
];

function sectionHeader(title: string, width: number): string {
  const prefix = "──";
  const separator = "─".repeat(Math.max(3, width - title.length - prefix.length - 3));
  return colorize(`${prefix} ${title} ${separator}`, "cyan");
}

function colorizeInvocation(invocation: string): string {
  if (!isInteractiveOutput()) {
    return invocation;
  }
  // Split on whitespace so we can color the binary name, subcommand tokens, and flags
  // independently. Angle-bracket placeholders get a yellow accent so operators can spot required
  // values at a glance.
  const tokens = invocation.split(/(\s+)/);
  return tokens
    .map((token) => {
      if (token === "quest") {
        return colorize(token, "bold");
      }
      if (token.startsWith("--")) {
        return colorize(token, "magenta");
      }
      if (token.startsWith("<") && token.endsWith(">")) {
        return colorize(token, "yellow");
      }
      return token;
    })
    .join("");
}

// ANSI Shadow style wordmark. Rendered in magenta with the sword accent in yellow so the banner
// reads as a logo without overwhelming the categorized help. Pipes get the plain one-liner
// instead so downstream tools never see box-drawing characters.
const LOGO = [
  " ██████╗  ██╗   ██╗███████╗███████╗████████╗",
  "██╔═══██╗ ██║   ██║██╔════╝██╔════╝╚══██╔══╝",
  "██║   ██║ ██║   ██║█████╗  ███████╗   ██║   ",
  "██║▄▄ ██║ ██║   ██║██╔══╝  ╚════██║   ██║   ",
  "╚██████╔╝ ╚██████╔╝███████╗███████║   ██║   ",
  " ╚══▀▀═╝   ╚═════╝ ╚══════╝╚══════╝   ╚═╝   ",
];

export function renderCategorizedHelp(): string {
  const width = 72;
  const lines: string[] = [];
  if (isInteractiveOutput()) {
    for (const row of LOGO) {
      lines.push(colorize(row, "magenta"));
    }
    lines.push(
      `${colorize("⚔⚔⚔", "yellow")}  ${colorize(
        "orchestrate coding agents into planned runs",
        "dim",
      )}\n`,
    );
  } else {
    lines.push(
      `${colorize("quest", "bold")}  ${colorize("orchestrate coding agents into planned runs", "dim")}`,
      "",
    );
  }

  for (const section of HELP_SECTIONS) {
    lines.push(sectionHeader(section.title, width));
    lines.push("");
    for (const entry of section.entries) {
      lines.push(`  ${colorize(`# ${entry.comment}`, "dim")}`);
      lines.push(`  ${colorizeInvocation(entry.invocation)}`);
      lines.push("");
    }
  }

  lines.push(colorize("──", "cyan"));
  for (const line of FOOTER_LINES) {
    lines.push(colorize(line, "dim"));
  }
  return lines.join("\n") + "\n";
}
