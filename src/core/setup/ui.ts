import type { SetupWizardPartyMode } from "./presets";

type SetupWizardBackend = "codex" | "hermes" | "openclaw";
type SetupWizardWorkerPlan = {
  args: string[];
  archetypeLabel: string;
  backend: SetupWizardBackend;
};
type SetupWizardResult = {
  calibrateWorkerIds: string[];
  sinkPlan: { kind: string } | null;
  workerPlans: SetupWizardWorkerPlan[];
};

const ansi = {
  bold: "\u001B[1m",
  cyan: "\u001B[36m",
  dim: "\u001B[2m",
  green: "\u001B[32m",
  magenta: "\u001B[35m",
  reset: "\u001B[0m",
  yellow: "\u001B[33m",
} as const;

function isInteractiveOutput(): boolean {
  return process.stdout.isTTY === true;
}

function colorize(text: string, color: keyof typeof ansi): string {
  if (!isInteractiveOutput()) {
    return text;
  }

  return `${ansi[color]}${text}${ansi.reset}`;
}

function readPlanArg(plan: SetupWizardWorkerPlan, flag: string): string | null {
  const index = plan.args.indexOf(flag);
  if (index < 0) {
    return null;
  }

  return plan.args[index + 1] ?? null;
}

function summarizeWorkerPlan(plan: SetupWizardWorkerPlan): string {
  const role = readPlanArg(plan, "--role") ?? "hybrid";
  const name = readPlanArg(plan, "--name") ?? "Unnamed worker";
  const profile = readPlanArg(plan, "--profile") ?? "default";
  const archetype = plan.archetypeLabel ?? "Adventurer";
  return `  - ${name} (${role}) · ${plan.backend}:${profile} · ${archetype}`;
}

export async function writeSetupBanner(
  defaultBackend: SetupWizardBackend,
  importSummary?: string,
): Promise<void> {
  const lines = [
    colorize("Quest Runner Setup", "bold"),
    colorize("Build your first party, wire observability, and validate the install.", "dim"),
    "",
    `${colorize("Default backend", "cyan")}: ${defaultBackend}`,
    ...(importSummary ? [`${colorize("Imported defaults", "cyan")}: ${importSummary}`] : []),
  ];
  await Bun.write(Bun.stdout, `${lines.join("\n")}\n\n`);
}

export async function writeSetupSection(title: string, detail: string): Promise<void> {
  const lines = [colorize(title, "magenta"), colorize(detail, "dim")];
  await Bun.write(Bun.stdout, `${lines.join("\n")}\n`);
}

export async function writeSetupSummary(
  partyMode: SetupWizardPartyMode,
  result: SetupWizardResult,
): Promise<void> {
  const lines = [
    "",
    colorize("Setup Summary", "green"),
    `${colorize("Party mode", "cyan")}: ${partyMode}`,
    `${colorize("Workers", "cyan")}: ${result.workerPlans.length}`,
    ...result.workerPlans.map(summarizeWorkerPlan),
    `${colorize("Sink", "cyan")}: ${result.sinkPlan?.kind ?? "none"}`,
    `${colorize("Training Grounds", "cyan")}: ${
      result.calibrateWorkerIds.length > 0 ? result.calibrateWorkerIds.join(", ") : "skipped"
    }`,
    "",
  ];
  await Bun.write(Bun.stdout, `${lines.join("\n")}\n`);
}
