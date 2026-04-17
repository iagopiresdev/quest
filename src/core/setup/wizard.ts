import { cancel, confirm, intro, isCancel, note, outro, select, text } from "@clack/prompts";
import type { TesterSelectionStrategy } from "../settings";
import { renderQuestBannerBlock } from "../ui/help";
import type { WorkerUpdate } from "../workers/management";
import {
  defaultSetupArchetype,
  listSetupArchetypesForRole,
  type SetupWizardPartyMode,
} from "./presets";

export type SetupWizardBackend = "codex" | "hermes" | "openclaw";
export type SetupWizardSinkKind = "linear" | "none" | "openclaw" | "slack" | "telegram" | "webhook";

export type SetupWizardWorkerPlan = {
  args: string[];
  archetypeLabel: string;
  backend: SetupWizardBackend;
  update: WorkerUpdate;
};

export type SetupWizardSinkPlan = {
  args: string[];
  kind: Exclude<SetupWizardSinkKind, "none">;
} | null;

export type SetupWizardResult = {
  calibrateWorkerIds: string[];
  settingsUpdate: {
    planner: {
      testerSelectionStrategy: TesterSelectionStrategy;
    };
  };
  sinkPlan: SetupWizardSinkPlan;
  workerPlans: SetupWizardWorkerPlan[];
};

type SetupWizardDefaults = {
  agentId?: string;
  backend: SetupWizardBackend;
  baseUrl?: string;
  envVar?: string;
  importSummary?: string;
  profile?: string;
  sinkDefaults?: {
    linearApiKeyEnv?: string;
    openClawAgentId?: string;
    openClawGatewayUrl?: string;
    // Set when `~/.openclaw/openclaw.json` exposes a Telegram bot token. The wizard surfaces an
    // "import from OpenClaw" auth mode that copies the token into the quest secret store so the
    // operator does not have to re-enter it. The raw token value is kept local to the wizard and
    // never echoed back to the terminal.
    openClawTelegramBotToken?: string;
    openClawTelegramChatId?: string;
    slackWebhookEnv?: string;
    telegramBotTokenEnv?: string;
  };
  testerSelectionStrategy: TesterSelectionStrategy;
};

type SetupWizardPromptContext = {
  defaults: SetupWizardDefaults;
};

// Live breadcrumb state the wizard mutates as prompts are answered. Each rendered page shows
// whatever is currently in here, so the operator always sees what they already picked and can
// reason about what is still to come.
type WizardProgress = {
  backend?: SetupWizardBackend;
  partyMode?: SetupWizardPartyMode;
  sink?: string;
  testerRouting?: TesterSelectionStrategy;
  trainingGrounds?: "yes" | "no";
  workers: Array<{ archetype: string; name: string; profile: string; role: string }>;
};

// Clack returns `symbol('clack.cancel')` when the user hits Ctrl+C. We treat that as a fatal
// operator decision: emit the clack cancel banner and throw a stable sentinel the CLI entrypoint
// can catch to exit with a non-zero code without a stack trace.
export class SetupWizardCancelledError extends Error {
  constructor() {
    super("Setup wizard cancelled");
    this.name = "SetupWizardCancelledError";
  }
}

function bail(): never {
  cancel("Setup cancelled.");
  throw new SetupWizardCancelledError();
}

function unwrap<T>(value: T | symbol): T {
  if (isCancel(value)) {
    bail();
  }
  return value as T;
}

// Clear screen + move cursor home, then redraw the QUEST banner and a breadcrumb block
// summarizing completed steps. Called before every prompt to enforce "page per step" — operator
// sees one decision at a time with a persistent header + progress panel.
function page(progress: WizardProgress, section: string, importSummary?: string): void {
  process.stdout.write("\u001B[2J\u001B[H");
  process.stdout.write(renderQuestBannerBlock(72, true));
  const breadcrumb = renderBreadcrumb(progress, importSummary);
  if (breadcrumb) {
    note(breadcrumb, "Progress");
  }
  intro(section);
}

function renderBreadcrumb(progress: WizardProgress, importSummary?: string): string | null {
  const lines: string[] = [];
  if (importSummary) {
    lines.push(`Imported: ${importSummary}`);
  }
  if (progress.backend) {
    lines.push(`Backend: ${progress.backend}`);
  }
  if (progress.partyMode) {
    lines.push(`Party mode: ${progress.partyMode}`);
  }
  if (progress.testerRouting) {
    lines.push(`Tester routing: ${progress.testerRouting}`);
  }
  for (const worker of progress.workers) {
    lines.push(`Worker ${worker.role}: ${worker.name} (${worker.profile}) · ${worker.archetype}`);
  }
  if (progress.sink) {
    lines.push(`Sink: ${progress.sink}`);
  }
  if (progress.trainingGrounds) {
    lines.push(`Training Grounds: ${progress.trainingGrounds}`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

async function askText(message: string, initial: string, placeholder?: string): Promise<string> {
  const answer = await text({
    initialValue: initial,
    message,
    placeholder: placeholder ?? initial,
  });
  return unwrap(answer).trim();
}

async function askConfirm(message: string, initial: boolean): Promise<boolean> {
  const answer = await confirm({ initialValue: initial, message });
  return unwrap(answer);
}

async function askSelect<TValue extends string>(
  message: string,
  choices: readonly TValue[],
  initial: TValue,
  hints?: Partial<Record<TValue, string>>,
): Promise<TValue> {
  const options = choices.map((value) => {
    const hint = hints?.[value];
    const entry: { hint?: string; label: string; value: TValue } = { label: value, value };
    if (hint !== undefined) {
      entry.hint = hint;
    }
    return entry;
  }) as ReadonlyArray<{ hint?: string; label: string; value: TValue }>;
  const answer = await select<TValue>({
    initialValue: initial,
    message,
    options: options as Parameters<typeof select<TValue>>[0]["options"],
  });
  return unwrap(answer);
}

function defaultProfile(backend: SetupWizardBackend): string {
  if (backend === "hermes") {
    return "hermes";
  }

  if (backend === "openclaw") {
    return "openai-codex/gpt-5.4";
  }

  return "gpt-5.4";
}

function defaultWorkerName(
  backend: SetupWizardBackend,
  role: "builder" | "tester" | "hybrid",
): string {
  let title = "Codex";
  if (backend === "hermes") {
    title = "Hermes";
  } else if (backend === "openclaw") {
    title = "OpenClaw";
  }
  if (role === "builder") {
    return `${title} Builder`;
  }
  if (role === "tester") {
    return `${title} Tester`;
  }
  return `${title} Adventurer`;
}

function renderRoleStationTitle(role: "builder" | "tester" | "hybrid"): string {
  if (role === "hybrid") {
    return "Party Selection";
  }

  return `${role.slice(0, 1).toUpperCase()}${role.slice(1)} Station`;
}

async function promptRuntimeArgs(
  progress: WizardProgress,
  importSummary: string | undefined,
): Promise<string[]> {
  page(progress, "Advanced runtime", importSummary);
  const advanced = await askConfirm("Open advanced runtime settings?", false);
  if (!advanced) {
    return [];
  }

  const args: string[] = [];
  const reasoning = await askSelect(
    "Reasoning effort",
    ["none", "minimal", "low", "medium", "high", "xhigh"] as const,
    "medium",
  );
  if (reasoning !== "medium") {
    args.push("--reasoning-effort", reasoning);
  }

  const maxOutputTokens = await askText("Max output tokens", "");
  if (maxOutputTokens.length > 0) {
    args.push("--max-output-tokens", maxOutputTokens);
  }

  const contextWindow = await askText("Context window", "");
  if (contextWindow.length > 0) {
    args.push("--context-window", contextWindow);
  }

  const temperature = await askText("Temperature", "");
  if (temperature.length > 0) {
    args.push("--temperature", temperature);
  }

  const topP = await askText("Top P", "");
  if (topP.length > 0) {
    args.push("--top-p", topP);
  }

  return args;
}

async function promptWorkerPlan(
  backend: SetupWizardBackend,
  role: "builder" | "tester" | "hybrid",
  defaults: SetupWizardDefaults,
  progress: WizardProgress,
): Promise<SetupWizardWorkerPlan> {
  const importSummary = defaults.importSummary;
  const sectionTitle = renderRoleStationTitle(role);
  page(progress, sectionTitle, importSummary);

  const name = await askText(`${role} name`, defaultWorkerName(backend, role));
  page(progress, sectionTitle, importSummary);
  const profile = await askText(`${role} profile`, defaults.profile ?? defaultProfile(backend));
  const args = ["--name", name, "--profile", profile, "--role", role];

  const archetypes = listSetupArchetypesForRole(role);
  const defaultArchetype = defaultSetupArchetype(role);
  page(progress, sectionTitle, importSummary);
  const archetypeId = await askSelect(
    `${role} archetype`,
    archetypes.map((archetype) => archetype.id),
    defaultArchetype.id,
  );
  const archetype =
    archetypes.find((candidate) => candidate.id === archetypeId) ?? defaultArchetype;

  if (backend === "hermes") {
    page(progress, sectionTitle, importSummary);
    const baseUrl = await askText(
      "Hermes base URL",
      defaults.baseUrl ?? "http://127.0.0.1:8000/v1",
    );
    args.push("--base-url", baseUrl);
  }

  if (backend === "openclaw") {
    page(progress, sectionTitle, importSummary);
    const agentId = await askText("OpenClaw agent id", defaults.agentId ?? "main");
    args.push("--agent-id", agentId);
    page(progress, sectionTitle, importSummary);
    const gatewayUrl = await askText("Gateway URL", defaults.baseUrl ?? "");
    if (gatewayUrl.length > 0) {
      args.push("--gateway-url", gatewayUrl);
    }
  }

  args.push(...(await promptRuntimeArgs(progress, importSummary)));

  const plan: SetupWizardWorkerPlan = {
    archetypeLabel: archetype.label,
    args,
    backend,
    update: archetype.update,
  };
  // Mutate the shared progress so subsequent pages show this worker in the breadcrumb.
  progress.workers.push({
    archetype: archetype.label,
    name,
    profile,
    role,
  });
  return plan;
}

async function promptTelegramSinkPlan(
  defaults: SetupWizardDefaults,
  progress: WizardProgress,
): Promise<SetupWizardSinkPlan> {
  const importSummary = defaults.importSummary;
  const detectedToken = defaults.sinkDefaults?.openClawTelegramBotToken;
  const detectedChatId = defaults.sinkDefaults?.openClawTelegramChatId;

  page(progress, "Telegram sink", importSummary);
  const chatId = await askText("Telegram chat id", detectedChatId ?? "");

  page(progress, "Telegram sink", importSummary);
  const authModes = detectedToken
    ? (["openclaw-import", "env", "secret-store"] as const)
    : (["env", "secret-store"] as const);
  const authMode = await askSelect(
    "Telegram bot token source",
    authModes,
    detectedToken ? "openclaw-import" : "env",
    detectedToken
      ? {
          env: "Read from an env var",
          "openclaw-import": "Pull from ~/.openclaw/openclaw.json",
          "secret-store": "Reference a quest secret store entry",
        }
      : {
          env: "Read from an env var",
          "secret-store": "Reference a quest secret store entry",
        },
  );

  page(progress, "Telegram sink", importSummary);
  const useRpgCards = await askConfirm(
    "Render events as RPG flavor cards (HTML parse mode)?",
    true,
  );
  const parseModeArgs = useRpgCards ? ["--parse-mode", "HTML"] : [];

  if (authMode === "openclaw-import" && detectedToken) {
    // The actual secret write happens in cli.ts::configureSetupSink so the wizard stays pure; we
    // thread the detected token through as a private sentinel arg.
    return {
      args: [
        "--chat-id",
        chatId,
        "--bot-token-secret-ref",
        "quest-telegram-bot-token",
        "--import-openclaw-bot-token",
        detectedToken,
        ...parseModeArgs,
      ],
      kind: "telegram",
    };
  }

  if (authMode === "secret-store") {
    page(progress, "Telegram sink", importSummary);
    const secretRef = await askText("Telegram bot token secret ref", "telegram.bot-token");
    return {
      args: ["--chat-id", chatId, "--bot-token-secret-ref", secretRef, ...parseModeArgs],
      kind: "telegram",
    };
  }

  page(progress, "Telegram sink", importSummary);
  const botTokenEnv = await askText(
    "Telegram bot token env",
    defaults.sinkDefaults?.telegramBotTokenEnv ?? "TELEGRAM_BOT_TOKEN",
  );
  return {
    args: ["--chat-id", chatId, "--bot-token-env", botTokenEnv, ...parseModeArgs],
    kind: "telegram",
  };
}

async function promptSinkPlan(
  defaults: SetupWizardDefaults,
  progress: WizardProgress,
): Promise<SetupWizardSinkPlan> {
  const importSummary = defaults.importSummary;
  page(progress, "Observability", importSummary);
  const sinkKind = await askSelect(
    "Observability sink",
    ["none", "webhook", "telegram", "slack", "linear", "openclaw"] as const,
    "none",
    {
      linear: "Issue tracker — cards move through workflow",
      none: "Skip observability",
      openclaw: "Pipe events into the OpenClaw gateway",
      slack: "Post to a Slack channel webhook",
      telegram: "Ping a Telegram chat with run updates",
      webhook: "POST events to a generic HTTP endpoint",
    },
  );
  if (sinkKind === "none") {
    progress.sink = "none";
    return null;
  }
  // Record the sink kind so subsequent sub-pages (auth modes, URLs, etc.) include it in the
  // breadcrumb.
  progress.sink = sinkKind;

  if (sinkKind === "webhook") {
    page(progress, "Webhook sink", importSummary);
    const url = await askText("Webhook URL", "http://127.0.0.1:3000/quest");
    return { args: ["--url", url], kind: "webhook" };
  }

  if (sinkKind === "telegram") {
    return await promptTelegramSinkPlan(defaults, progress);
  }

  if (sinkKind === "slack") {
    page(progress, "Slack sink", importSummary);
    const authMode = await askSelect(
      "Slack webhook source",
      ["direct", "env", "secret-store"] as const,
      "direct",
    );
    if (authMode === "env") {
      page(progress, "Slack sink", importSummary);
      const urlEnv = await askText(
        "Slack webhook env",
        defaults.sinkDefaults?.slackWebhookEnv ?? "SLACK_WEBHOOK_URL",
      );
      return { args: ["--url-env", urlEnv], kind: "slack" };
    }
    if (authMode === "secret-store") {
      page(progress, "Slack sink", importSummary);
      const secretRef = await askText("Slack webhook secret ref", "slack.webhook");
      return { args: ["--secret-ref", secretRef], kind: "slack" };
    }

    page(progress, "Slack sink", importSummary);
    const webhookUrl = await askText("Slack webhook URL", "");
    return { args: ["--url", webhookUrl], kind: "slack" };
  }

  if (sinkKind === "openclaw") {
    page(progress, "OpenClaw sink", importSummary);
    const agentId = await askText(
      "OpenClaw sink agent id",
      defaults.sinkDefaults?.openClawAgentId ?? "main",
    );
    page(progress, "OpenClaw sink", importSummary);
    const sessionId = await askText("OpenClaw sink session id", "quest-observability");
    page(progress, "OpenClaw sink", importSummary);
    const gatewayUrl = await askText(
      "OpenClaw sink gateway URL",
      defaults.sinkDefaults?.openClawGatewayUrl ?? "",
    );
    const args = ["--agent-id", agentId, "--session-id", sessionId];
    if (gatewayUrl.length > 0) {
      args.push("--gateway-url", gatewayUrl);
    }
    return { args, kind: "openclaw" };
  }

  page(progress, "Linear sink", importSummary);
  const issueId = await askText("Linear issue id", "");
  page(progress, "Linear sink", importSummary);
  const authMode = await askSelect(
    "Linear API key source",
    ["env", "secret-store"] as const,
    "env",
  );
  if (authMode === "secret-store") {
    page(progress, "Linear sink", importSummary);
    const secretRef = await askText("Linear API key secret ref", "linear.api-key");
    return { args: ["--issue-id", issueId, "--api-key-secret-ref", secretRef], kind: "linear" };
  }

  page(progress, "Linear sink", importSummary);
  const apiKeyEnv = await askText(
    "Linear API key env",
    defaults.sinkDefaults?.linearApiKeyEnv ?? "LINEAR_API_KEY",
  );
  return { args: ["--issue-id", issueId, "--api-key-env", apiKeyEnv], kind: "linear" };
}

function deriveCalibrationIds(workerPlans: SetupWizardWorkerPlan[]): string[] {
  return workerPlans.map((plan) => {
    const nameIndex = plan.args.indexOf("--name");
    const name = nameIndex >= 0 ? (plan.args[nameIndex + 1] ?? plan.backend) : plan.backend;
    return name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  });
}

function readPlanArg(plan: SetupWizardWorkerPlan, flag: string): string | null {
  const index = plan.args.indexOf(flag);
  if (index < 0) {
    return null;
  }
  return plan.args[index + 1] ?? null;
}

function renderSummaryNote(partyMode: SetupWizardPartyMode, result: SetupWizardResult): string {
  const workerLines = result.workerPlans.map((plan) => {
    const role = readPlanArg(plan, "--role") ?? "hybrid";
    const name = readPlanArg(plan, "--name") ?? "Unnamed worker";
    const profile = readPlanArg(plan, "--profile") ?? "default";
    return `• ${name} (${role}) · ${plan.backend}:${profile} · ${plan.archetypeLabel}`;
  });
  const calibration =
    result.calibrateWorkerIds.length > 0 ? result.calibrateWorkerIds.join(", ") : "skipped";
  const lines = [
    `Party mode: ${partyMode}`,
    `Workers (${result.workerPlans.length}):`,
    ...workerLines,
    `Tester routing: ${result.settingsUpdate.planner.testerSelectionStrategy}`,
    `Sink: ${result.sinkPlan?.kind ?? "none"}`,
    `Training Grounds: ${calibration}`,
  ];
  return lines.join("\n");
}

export async function runSetupWizard(
  context: SetupWizardPromptContext,
): Promise<SetupWizardResult> {
  const importSummary = context.defaults.importSummary;
  const progress: WizardProgress = { workers: [] };

  // Backend page
  page(progress, "Backend", importSummary);
  const backend = await askSelect(
    "Backend",
    ["codex", "hermes", "openclaw"] as const,
    context.defaults.backend,
    {
      codex: "OpenAI Codex CLI",
      hermes: "Self-hosted Hermes endpoint",
      openclaw: "OpenClaw gateway agent",
    },
  );
  progress.backend = backend;

  // Party mode page
  page(progress, "Party mode", importSummary);
  const partyMode = (await askSelect("Party mode", ["hybrid", "split"] as const, "hybrid", {
    hybrid: "One worker handles encounters and trials",
    split: "Dedicated builder + dedicated tester",
  })) as SetupWizardPartyMode;
  progress.partyMode = partyMode;

  // Tester routing page
  page(progress, "Trials", importSummary);
  const testerSelectionStrategy = await askSelect(
    "Tester routing",
    ["balanced", "prefer-cheapest"] as const,
    context.defaults.testerSelectionStrategy,
    {
      balanced: "Picks the highest-ranked eligible tester",
      "prefer-cheapest": "Biases toward the lowest cpu/memory/gpu cost",
    },
  );
  progress.testerRouting = testerSelectionStrategy;

  // Worker pages (one or two depending on party mode). `promptWorkerPlan` owns its own paging.
  const workerPlans: SetupWizardWorkerPlan[] = [];
  if (partyMode === "hybrid") {
    workerPlans.push(await promptWorkerPlan(backend, "hybrid", context.defaults, progress));
  } else {
    workerPlans.push(await promptWorkerPlan(backend, "builder", context.defaults, progress));
    workerPlans.push(await promptWorkerPlan(backend, "tester", context.defaults, progress));
  }

  const sinkPlan = await promptSinkPlan(context.defaults, progress);

  // Training Grounds page
  page(progress, "Training Grounds", importSummary);
  const runCalibration = await askConfirm(
    "Send new party members to the Training Grounds now?",
    true,
  );
  progress.trainingGrounds = runCalibration ? "yes" : "no";

  const result: SetupWizardResult = {
    calibrateWorkerIds: runCalibration ? deriveCalibrationIds(workerPlans) : [],
    settingsUpdate: {
      planner: {
        testerSelectionStrategy,
      },
    },
    sinkPlan,
    workerPlans,
  };

  // Final summary page — one last clear, banner on top, summary note, outro.
  process.stdout.write("\u001B[2J\u001B[H");
  process.stdout.write(renderQuestBannerBlock(72, true));
  intro("Setup complete");
  note(renderSummaryNote(partyMode, result), "Setup Summary");
  outro("Party ready. Run `quest party dispatch` when you're good to go.");
  return result;
}
