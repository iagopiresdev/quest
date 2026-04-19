// Categorized help for the `quest` CLI.
//
// The flat usage dump (one line per every command × flag) is still available under `quest --help`
// for operators who want the machine-readable version. This module renders a curated, grouped
// view that looks closer to a well-produced CLI reference: section headers, inline comments per
// command, color-accented flag names, and omission of the state-root / workspaces-root / registry
// boilerplate that applies to almost every command.

import {
  colorize,
  colorizeRgb,
  interpolateRgb,
  isInteractiveOutput,
  type RgbColor,
} from "./terminal";

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
        invocation: "quest setup --yes --backend <codex|hermes|openclaw|standalone>",
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

// ANSI Shadow wordmark with a vertical gradient. 6-row box-drawing block letters that read
// like an engraved title when centered inside the banner. Sword-blade palette: amber top (hot
// tempered steel) through crimson (cooling blade) to deep violet (shadow at the grip). Pipes
// and non-TTY callers fall through to the plain one-liner.
const LOGO_ROWS = [
  " ██████╗  ██╗   ██╗███████╗███████╗████████╗",
  "██╔═══██╗ ██║   ██║██╔════╝██╔════╝╚══██╔══╝",
  "██║   ██║ ██║   ██║█████╗  ███████╗   ██║   ",
  "██║▄▄ ██║ ██║   ██║██╔══╝  ╚════██║   ██║   ",
  "╚██████╔╝ ╚██████╔╝███████╗███████║   ██║   ",
  " ╚══▀▀═╝   ╚═════╝ ╚══════╝╚══════╝   ╚═╝   ",
];

// Display width of the widest logo row (all rows are identical width). Hardcoded so we avoid
// Unicode-aware width measurement on every render.
const LOGO_WIDTH = 44;

const GRADIENT_TOP: RgbColor = [245, 158, 66]; // amber / hot blade
const GRADIENT_MID: RgbColor = [220, 60, 100]; // crimson / cooling steel
const GRADIENT_BOT: RgbColor = [118, 75, 190]; // deep violet / shadow

// Cached tagline rendered below the logo. The three-beat cadence maps to Quest Runner's core
// primitives: a party of workers, a spec that becomes a quest, and landing work back on main.
const TAGLINE = "pick a party. draft a quest. clear the board.";

function gradientForRow(rowIndex: number, totalRows: number): RgbColor {
  const ratio = totalRows <= 1 ? 0 : rowIndex / (totalRows - 1);
  if (ratio < 0.5) {
    return interpolateRgb(GRADIENT_TOP, GRADIENT_MID, ratio * 2);
  }
  return interpolateRgb(GRADIENT_MID, GRADIENT_BOT, (ratio - 0.5) * 2);
}

function renderLogoBlock(): string[] {
  return LOGO_ROWS.map((row, index) => colorizeRgb(row, gradientForRow(index, LOGO_ROWS.length)));
}

// Exported so interactive entry points (setup wizard, doctor, party create) can open with the
// same QUEST wordmark + tagline block that `quest help` renders. Non-TTY callers get a plain
// one-liner so CI logs and pipes stay clean. Interactive entry points that know they are in a
// TTY (because clack would not otherwise be invoked) can pass `forceInteractive=true` to bypass
// the ambient `isTTY` check, which is unreliable under compiled binaries + VHS ttyd emulation.
export function renderQuestBannerBlock(width = 72, forceInteractive = false): string {
  const lines: string[] = [];
  if (!forceInteractive && !isInteractiveOutput()) {
    return `${colorize("quest", "bold")}  ${colorize(TAGLINE, "dim")}\n`;
  }
  const logoRows = renderLogoBlock();
  const leftPad = Math.max(0, Math.floor((width - LOGO_WIDTH) / 2));
  const logoPad = " ".repeat(leftPad);
  const rule = colorize(
    "╾━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╼",
    "dim",
  );
  lines.push(rule, "");
  for (const row of logoRows) {
    lines.push(`${logoPad}${row}`);
  }
  lines.push("");
  const bullet = colorize("•", "yellow");
  const taglinePad = " ".repeat(Math.max(0, Math.floor((width - (TAGLINE.length + 2)) / 2)));
  lines.push(`${taglinePad}${bullet} ${colorize(TAGLINE, "dim")}`);
  lines.push("", rule, "");
  return `${lines.join("\n")}\n`;
}

export function renderCategorizedHelp(): string {
  const width = 72;
  const lines: string[] = [];
  lines.push(renderQuestBannerBlock(width).trimEnd(), "");

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
  return `${lines.join("\n")}\n`;
}
