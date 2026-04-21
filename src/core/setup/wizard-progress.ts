import { colorize } from "../ui/terminal";
import type { SetupWizardHarness } from "./wizard-options";

export type WizardProgress = {
  harnesses?: SetupWizardHarness[];
  imports?: string[];
  sink?: string;
  trainingGrounds?: "yes" | "no";
  workers: Array<{
    archetype: string;
    harness: string;
    id: string;
    model: string;
    name: string;
    role: string;
  }>;
};

export function renderWizardProgress(progress: WizardProgress): string | null {
  const steps = [
    progress.harnesses !== undefined && progress.harnesses.length > 0,
    progress.workers.length > 0,
    progress.sink !== undefined,
    progress.trainingGrounds !== undefined,
  ];
  const doneCount = steps.filter(Boolean).length;
  const rows = [
    `Progress ${renderProgressBar(doneCount, steps.length)} ${doneCount}/${steps.length}`,
    "",
    "Core",
    renderRow(steps[0] ?? false, "Harnesses", progress.harnesses?.join(", ") ?? ""),
  ];

  if (progress.imports && progress.imports.length > 0) {
    rows.push(renderRow(true, "Detected", progress.imports.join(", ")));
  }

  if (progress.workers.length > 0) {
    rows.push("", "Roster");
    rows.push(
      ...progress.workers.map((worker) =>
        renderRow(true, worker.role, `${worker.name} (${worker.harness}:${worker.model})`),
      ),
    );
  }

  rows.push(
    "",
    "Observability",
    renderRow(progress.sink !== undefined, "Sink", progress.sink ?? ""),
  );
  rows.push(
    "",
    "Training",
    renderRow(
      progress.trainingGrounds !== undefined,
      "Calibration",
      progress.trainingGrounds ?? "",
    ),
  );
  return rows.join("\n");
}

function renderProgressBar(doneCount: number, total: number): string {
  const width = 20;
  const filled = Math.round((doneCount / total) * width);
  return `${colorize("#".repeat(filled), "green")}${colorize("-".repeat(width - filled), "dim")}`;
}

function renderRow(done: boolean, label: string, value: string): string {
  const marker = done ? colorize("[x]", "green") : colorize("[ ]", "dim");
  const shownValue = done ? value : colorize("-", "dim");
  return `  ${marker} ${label.padEnd(16, " ")}${shownValue}`;
}
