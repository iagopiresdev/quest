export type SetupWizardHarness = "codex" | "hermes" | "openclaw";
export type SetupWizardHarnessChoice = SetupWizardHarness | "claude-code" | "opencode";

export type SetupWizardHarnessDefaults = {
  agentId?: string;
  authMode?: "env-var" | "native-login";
  baseUrl?: string;
  envVar?: string;
  executable?: string;
  importSummary?: string;
  models?: string[];
  openClawAgents?: Array<{ id: string; model: string | null }>;
  profile?: string | null;
};

export const SETUP_WIZARD_CODEX_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
] as const;

export function isSetupWizardHarness(value: string): value is SetupWizardHarness {
  return value === "codex" || value === "hermes" || value === "openclaw";
}

export function harnessLabel(harness: SetupWizardHarnessChoice): string {
  if (harness === "codex") return "codex";
  if (harness === "claude-code") return "claude-code";
  if (harness === "opencode") return "opencode";
  if (harness === "openclaw") return "openclaw";
  return "hermes";
}

export function harnessHint(harness: SetupWizardHarnessChoice): string {
  if (harness === "codex") return "OpenAI Codex CLI";
  if (harness === "claude-code") return "Adapter coming soon";
  if (harness === "opencode") return "Adapter coming soon";
  if (harness === "openclaw") return "OpenClaw gateway agent";
  return "Self-hosted Hermes endpoint";
}

export function listModelsForHarness(
  harness: SetupWizardHarness,
  defaults?: SetupWizardHarnessDefaults,
): string[] {
  if (harness === "codex") {
    return [...SETUP_WIZARD_CODEX_MODELS];
  }

  const detectedModels = [
    ...(defaults?.models ?? []),
    ...(defaults?.openClawAgents?.map((agent) => agent.model).filter(isNonEmptyString) ?? []),
    ...(isNonEmptyString(defaults?.profile) ? [defaults.profile] : []),
  ];
  const uniqueModels = [...new Set(detectedModels)];
  if (uniqueModels.length > 0) {
    return uniqueModels;
  }

  return harness === "hermes" ? ["hermes"] : ["openai-codex/gpt-5.4"];
}

export function openClawAgentForModel(
  defaults: SetupWizardHarnessDefaults | undefined,
  model: string,
): string | undefined {
  return defaults?.openClawAgents?.find((agent) => agent.model === model)?.id ?? defaults?.agentId;
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
