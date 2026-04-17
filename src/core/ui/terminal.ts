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

// 24-bit truecolor escape for gradient banners. Every modern terminal supports this (iTerm2,
// Terminal.app on 15.3+, WezTerm, Alacritty, Warp, VS Code integrated). For operators stuck on an
// old terminal without truecolor support, the plain-text fallback still kicks in via the
// `isInteractiveOutput()` gate on the caller side.
export type RgbColor = readonly [number, number, number];

export function colorizeRgb(text: string, color: RgbColor): string {
  if (!isInteractiveOutput()) {
    return text;
  }
  const [r, g, b] = color;
  return `\u001B[38;2;${r};${g};${b}m${text}${ansi.reset}`;
}

export function interpolateRgb(from: RgbColor, to: RgbColor, t: number): RgbColor {
  const clamp = Math.min(1, Math.max(0, t));
  return [
    Math.round(from[0] + (to[0] - from[0]) * clamp),
    Math.round(from[1] + (to[1] - from[1]) * clamp),
    Math.round(from[2] + (to[2] - from[2]) * clamp),
  ];
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
