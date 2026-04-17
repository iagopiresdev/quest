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

async function promptRuntimeArgs(): Promise<string[]> {
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
): Promise<SetupWizardWorkerPlan> {
  let sectionDetail = "Pick a solo operator that can clear encounters and trials.";
  if (role === "builder") {
    sectionDetail = "Pick the party member that owns encounters.";
  } else if (role === "tester") {
    sectionDetail = "Pick the party member that owns trials.";
  }

  note(sectionDetail, renderRoleStationTitle(role));

  const name = await askText(`${role} name`, defaultWorkerName(backend, role));
  const profile = await askText(`${role} profile`, defaults.profile ?? defaultProfile(backend));
  const args = ["--name", name, "--profile", profile, "--role", role];

  const archetypes = listSetupArchetypesForRole(role);
  const defaultArchetype = defaultSetupArchetype(role);
  const archetypeId = await askSelect(
    `${role} archetype`,
    archetypes.map((archetype) => archetype.id),
    defaultArchetype.id,
  );
  const archetype =
    archetypes.find((candidate) => candidate.id === archetypeId) ?? defaultArchetype;

  if (backend === "hermes") {
    const baseUrl = await askText(
      "Hermes base URL",
      defaults.baseUrl ?? "http://127.0.0.1:8000/v1",
    );
    args.push("--base-url", baseUrl);
  }

  if (backend === "openclaw") {
    const agentId = await askText("OpenClaw agent id", defaults.agentId ?? "main");
    args.push("--agent-id", agentId);
    const gatewayUrl = await askText("Gateway URL", defaults.baseUrl ?? "");
    if (gatewayUrl.length > 0) {
      args.push("--gateway-url", gatewayUrl);
    }
  }

  args.push(...(await promptRuntimeArgs()));
  return {
    archetypeLabel: archetype.label,
    args,
    backend,
    update: archetype.update,
  };
}

async function promptTelegramSinkPlan(defaults: SetupWizardDefaults): Promise<SetupWizardSinkPlan> {
  const detectedToken = defaults.sinkDefaults?.openClawTelegramBotToken;
  const detectedChatId = defaults.sinkDefaults?.openClawTelegramChatId;
  const chatId = await askText("Telegram chat id", detectedChatId ?? "");
  const authModes = detectedToken
    ? (["openclaw-import", "env", "secret-store"] as const)
    : (["env", "secret-store"] as const);
  const authMode = await askSelect(
    detectedToken ? "Telegram bot token source" : "Telegram bot token source",
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
    const secretRef = await askText("Telegram bot token secret ref", "telegram.bot-token");
    return {
      args: ["--chat-id", chatId, "--bot-token-secret-ref", secretRef, ...parseModeArgs],
      kind: "telegram",
    };
  }

  const botTokenEnv = await askText(
    "Telegram bot token env",
    defaults.sinkDefaults?.telegramBotTokenEnv ?? "TELEGRAM_BOT_TOKEN",
  );
  return {
    args: ["--chat-id", chatId, "--bot-token-env", botTokenEnv, ...parseModeArgs],
    kind: "telegram",
  };
}

async function promptSinkPlan(defaults: SetupWizardDefaults): Promise<SetupWizardSinkPlan> {
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
    return null;
  }

  if (sinkKind === "webhook") {
    const url = await askText("Webhook URL", "http://127.0.0.1:3000/quest");
    return { args: ["--url", url], kind: "webhook" };
  }

  if (sinkKind === "telegram") {
    return await promptTelegramSinkPlan(defaults);
  }

  if (sinkKind === "slack") {
    const authMode = await askSelect(
      "Slack webhook source",
      ["direct", "env", "secret-store"] as const,
      "direct",
    );
    if (authMode === "env") {
      const urlEnv = await askText(
        "Slack webhook env",
        defaults.sinkDefaults?.slackWebhookEnv ?? "SLACK_WEBHOOK_URL",
      );
      return { args: ["--url-env", urlEnv], kind: "slack" };
    }
    if (authMode === "secret-store") {
      const secretRef = await askText("Slack webhook secret ref", "slack.webhook");
      return { args: ["--secret-ref", secretRef], kind: "slack" };
    }

    const webhookUrl = await askText("Slack webhook URL", "");
    return { args: ["--url", webhookUrl], kind: "slack" };
  }

  if (sinkKind === "openclaw") {
    const agentId = await askText(
      "OpenClaw sink agent id",
      defaults.sinkDefaults?.openClawAgentId ?? "main",
    );
    const sessionId = await askText("OpenClaw sink session id", "quest-observability");
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

  const issueId = await askText("Linear issue id", "");
  const authMode = await askSelect(
    "Linear API key source",
    ["env", "secret-store"] as const,
    "env",
  );
  if (authMode === "secret-store") {
    const secretRef = await askText("Linear API key secret ref", "linear.api-key");
    return { args: ["--issue-id", issueId, "--api-key-secret-ref", secretRef], kind: "linear" };
  }

  const apiKeyEnv = await askText(
    "Linear API key env",
    defaults.sinkDefaults?.linearApiKeyEnv ?? "LINEAR_API_KEY",
  );
  return { args: ["--issue-id", issueId, "--api-key-env", apiKeyEnv], kind: "linear" };
}

async function promptTesterSelectionStrategy(
  fallback: TesterSelectionStrategy,
): Promise<TesterSelectionStrategy> {
  note(
    "Choose whether the planner values the strongest tester overall or the cheapest eligible tester.",
    "Trials",
  );
  return await askSelect("Tester routing", ["balanced", "prefer-cheapest"] as const, fallback, {
    balanced: "Picks the highest-ranked eligible tester",
    "prefer-cheapest": "Biases toward the lowest cpu/memory/gpu cost",
  });
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
  // Stamp the QUEST wordmark above the clack pipeline so `quest setup` opens with the same
  // banner as `quest help`. We call the banner with forceInteractive=true because the wizard
  // itself is always interactive (clack wouldn't have been invoked otherwise), and the ambient
  // isTTY check is unreliable under compiled binaries + ttyd emulation.
  process.stdout.write(renderQuestBannerBlock(72, true));
  intro("Setup");
  if (context.defaults.importSummary) {
    note(context.defaults.importSummary, "Imported defaults");
  }

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
  const partyMode = (await askSelect("Party mode", ["hybrid", "split"] as const, "hybrid", {
    hybrid: "One worker handles encounters and trials",
    split: "Dedicated builder + dedicated tester",
  })) as SetupWizardPartyMode;
  const testerSelectionStrategy = await promptTesterSelectionStrategy(
    context.defaults.testerSelectionStrategy,
  );

  const workerPlans: SetupWizardWorkerPlan[] = [];
  if (partyMode === "hybrid") {
    workerPlans.push(await promptWorkerPlan(backend, "hybrid", context.defaults));
  } else {
    workerPlans.push(await promptWorkerPlan(backend, "builder", context.defaults));
    workerPlans.push(await promptWorkerPlan(backend, "tester", context.defaults));
  }

  note("Choose where quest events should be delivered.", "Observability");
  const sinkPlan = await promptSinkPlan(context.defaults);

  note("Decide whether to calibrate the new party now.", "Training Grounds");
  const runCalibration = await askConfirm(
    "Send new party members to the Training Grounds now?",
    true,
  );
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
  note(renderSummaryNote(partyMode, result), "Setup Summary");
  outro("Party ready. Run `quest party dispatch` when you're good to go.");
  return result;
}
