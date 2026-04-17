const ansi = {
  bold: "\u001B[1m",
  cyan: "\u001B[36m",
  dim: "\u001B[2m",
  green: "\u001B[32m",
  magenta: "\u001B[35m",
  red: "\u001B[31m",
  reset: "\u001B[0m",
  yellow: "\u001B[33m",
} as const;

export type TerminalColor = keyof typeof ansi;

export function isInteractiveOutput(): boolean {
  // QUEST_RUNNER_FORCE_INTERACTIVE lets operators (and screenshot scripts) render colors + logo
  // through pipes. Production callers still see the automatic TTY detection.
  return Bun.env.QUEST_RUNNER_FORCE_INTERACTIVE === "1" || process.stdout.isTTY === true;
}

export function colorize(text: string, color: TerminalColor): string {
  if (!isInteractiveOutput()) {
    return text;
  }

  return `${ansi[color]}${text}${ansi.reset}`;
}

export function formatPrettyStatus(status: "fail" | "info" | "ok" | "warn"): string {
  if (status === "ok") {
    return colorize("✓", "green");
  }

  if (status === "warn") {
    return colorize("!", "yellow");
  }

  if (status === "fail") {
    return colorize("✗", "red");
  }

  return colorize("•", "cyan");
}
