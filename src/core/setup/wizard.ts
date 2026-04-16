import { createInterface } from "node:readline/promises";
import type { TesterSelectionStrategy } from "../settings";
import type { WorkerUpdate } from "../workers/management";
import {
  defaultSetupArchetype,
  listSetupArchetypesForRole,
  type SetupWizardPartyMode,
} from "./presets";
import { writeSetupBanner, writeSetupSection, writeSetupSummary } from "./ui";

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

async function promptWithDefault(
  cli: ReturnType<typeof createInterface>,
  question: string,
  fallback: string,
): Promise<string> {
  const answer = (await cli.question(`${question} [${fallback}]: `)).trim();
  return answer.length > 0 ? answer : fallback;
}

async function confirmWithDefault(
  cli: ReturnType<typeof createInterface>,
  question: string,
  fallback: boolean,
): Promise<boolean> {
  const suffix = fallback ? "Y/n" : "y/N";
  const answer = (await cli.question(`${question} [${suffix}]: `)).trim().toLowerCase();
  if (answer.length === 0) {
    return fallback;
  }

  return answer === "y" || answer === "yes";
}

async function chooseOne<TChoice extends string>(
  cli: ReturnType<typeof createInterface>,
  question: string,
  choices: readonly TChoice[],
  fallback: TChoice,
): Promise<TChoice> {
  const renderedChoices = choices.join("/");
  const answer = (
    await cli.question(`${question} [${fallback}] (${renderedChoices}): `)
  ).trim() as TChoice;
  return choices.includes(answer) ? answer : fallback;
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

async function promptRuntimeArgs(cli: ReturnType<typeof createInterface>): Promise<string[]> {
  const advanced = await confirmWithDefault(cli, "Open advanced runtime settings?", false);
  if (!advanced) {
    return [];
  }

  const args: string[] = [];
  const reasoning = await chooseOne(
    cli,
    "Reasoning effort",
    ["none", "minimal", "low", "medium", "high", "xhigh"] as const,
    "medium",
  );
  if (reasoning !== "medium") {
    args.push("--reasoning-effort", reasoning);
  }

  const maxOutputTokens = await promptWithDefault(cli, "Max output tokens", "");
  if (maxOutputTokens.length > 0) {
    args.push("--max-output-tokens", maxOutputTokens);
  }

  const contextWindow = await promptWithDefault(cli, "Context window", "");
  if (contextWindow.length > 0) {
    args.push("--context-window", contextWindow);
  }

  const temperature = await promptWithDefault(cli, "Temperature", "");
  if (temperature.length > 0) {
    args.push("--temperature", temperature);
  }

  const topP = await promptWithDefault(cli, "Top P", "");
  if (topP.length > 0) {
    args.push("--top-p", topP);
  }

  return args;
}

async function promptWorkerPlan(
  cli: ReturnType<typeof createInterface>,
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

  await writeSetupSection(renderRoleStationTitle(role), sectionDetail);
  const name = await promptWithDefault(cli, `${role} name`, defaultWorkerName(backend, role));
  const profile = await promptWithDefault(
    cli,
    `${role} profile`,
    defaults.profile ?? defaultProfile(backend),
  );
  const args = ["--name", name, "--profile", profile, "--role", role];
  const archetypes = listSetupArchetypesForRole(role);
  const defaultArchetype = defaultSetupArchetype(role);
  const archetypeId = await chooseOne(
    cli,
    `${role} archetype`,
    archetypes.map((archetype) => archetype.id),
    defaultArchetype.id,
  );
  const archetype =
    archetypes.find((candidate) => candidate.id === archetypeId) ?? defaultArchetype;

  if (backend === "hermes") {
    const baseUrl = await promptWithDefault(
      cli,
      "Hermes base URL",
      defaults.baseUrl ?? "http://127.0.0.1:8000/v1",
    );
    args.push("--base-url", baseUrl);
  }

  if (backend === "openclaw") {
    const agentId = await promptWithDefault(cli, "OpenClaw agent id", defaults.agentId ?? "main");
    args.push("--agent-id", agentId);
    const gatewayUrl = await promptWithDefault(cli, "Gateway URL", defaults.baseUrl ?? "");
    if (gatewayUrl.length > 0) {
      args.push("--gateway-url", gatewayUrl);
    }
  }

  args.push(...(await promptRuntimeArgs(cli)));
  return {
    archetypeLabel: archetype.label,
    args,
    backend,
    update: archetype.update,
  };
}

async function promptTelegramSinkPlan(
  cli: ReturnType<typeof createInterface>,
  defaults: SetupWizardDefaults,
): Promise<SetupWizardSinkPlan> {
  const detectedToken = defaults.sinkDefaults?.openClawTelegramBotToken;
  const detectedChatId = defaults.sinkDefaults?.openClawTelegramChatId;
  const chatId = await promptWithDefault(cli, "Telegram chat id", detectedChatId ?? "");
  const authModes = detectedToken
    ? (["openclaw-import", "env", "secret-store"] as const)
    : (["env", "secret-store"] as const);
  const authMode = await chooseOne(
    cli,
    detectedToken
      ? "Telegram bot token source (openclaw-import pulls from ~/.openclaw/openclaw.json)"
      : "Telegram bot token source",
    authModes,
    detectedToken ? "openclaw-import" : "env",
  );
  const useRpgCards = await confirmWithDefault(
    cli,
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
    const secretRef = await promptWithDefault(
      cli,
      "Telegram bot token secret ref",
      "telegram.bot-token",
    );
    return {
      args: ["--chat-id", chatId, "--bot-token-secret-ref", secretRef, ...parseModeArgs],
      kind: "telegram",
    };
  }

  const botTokenEnv = await promptWithDefault(
    cli,
    "Telegram bot token env",
    defaults.sinkDefaults?.telegramBotTokenEnv ?? "TELEGRAM_BOT_TOKEN",
  );
  return {
    args: ["--chat-id", chatId, "--bot-token-env", botTokenEnv, ...parseModeArgs],
    kind: "telegram",
  };
}

async function promptSinkPlan(
  cli: ReturnType<typeof createInterface>,
  defaults: SetupWizardDefaults,
): Promise<SetupWizardSinkPlan> {
  const sinkKind = await chooseOne(
    cli,
    "Observability sink",
    ["none", "webhook", "telegram", "slack", "linear", "openclaw"] as const,
    "none",
  );
  if (sinkKind === "none") {
    return null;
  }

  if (sinkKind === "webhook") {
    const url = await promptWithDefault(cli, "Webhook URL", "http://127.0.0.1:3000/quest");
    return { args: ["--url", url], kind: "webhook" };
  }

  if (sinkKind === "telegram") {
    return await promptTelegramSinkPlan(cli, defaults);
  }

  if (sinkKind === "slack") {
    const authMode = await chooseOne(
      cli,
      "Slack webhook source",
      ["direct", "env", "secret-store"] as const,
      "direct",
    );
    if (authMode === "env") {
      const urlEnv = await promptWithDefault(
        cli,
        "Slack webhook env",
        defaults.sinkDefaults?.slackWebhookEnv ?? "SLACK_WEBHOOK_URL",
      );
      return { args: ["--url-env", urlEnv], kind: "slack" };
    }
    if (authMode === "secret-store") {
      const secretRef = await promptWithDefault(cli, "Slack webhook secret ref", "slack.webhook");
      return { args: ["--secret-ref", secretRef], kind: "slack" };
    }

    const webhookUrl = await promptWithDefault(cli, "Slack webhook URL", "");
    return { args: ["--url", webhookUrl], kind: "slack" };
  }

  if (sinkKind === "openclaw") {
    const agentId = await promptWithDefault(
      cli,
      "OpenClaw sink agent id",
      defaults.sinkDefaults?.openClawAgentId ?? "main",
    );
    const sessionId = await promptWithDefault(
      cli,
      "OpenClaw sink session id",
      "quest-observability",
    );
    const gatewayUrl = await promptWithDefault(
      cli,
      "OpenClaw sink gateway URL",
      defaults.sinkDefaults?.openClawGatewayUrl ?? "",
    );
    const args = ["--agent-id", agentId, "--session-id", sessionId];
    if (gatewayUrl.length > 0) {
      args.push("--gateway-url", gatewayUrl);
    }
    return { args, kind: "openclaw" };
  }

  const issueId = await promptWithDefault(cli, "Linear issue id", "");
  const authMode = await chooseOne(
    cli,
    "Linear API key source",
    ["env", "secret-store"] as const,
    "env",
  );
  if (authMode === "secret-store") {
    const secretRef = await promptWithDefault(cli, "Linear API key secret ref", "linear.api-key");
    return { args: ["--issue-id", issueId, "--api-key-secret-ref", secretRef], kind: "linear" };
  }

  const apiKeyEnv = await promptWithDefault(
    cli,
    "Linear API key env",
    defaults.sinkDefaults?.linearApiKeyEnv ?? "LINEAR_API_KEY",
  );
  return { args: ["--issue-id", issueId, "--api-key-env", apiKeyEnv], kind: "linear" };
}

async function promptTesterSelectionStrategy(
  cli: ReturnType<typeof createInterface>,
  fallback: TesterSelectionStrategy,
): Promise<TesterSelectionStrategy> {
  await writeSetupSection(
    "Trials",
    "Choose whether the planner values the strongest tester overall or the cheapest eligible tester.",
  );
  return await chooseOne(cli, "Tester routing", ["balanced", "prefer-cheapest"] as const, fallback);
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

export async function runSetupWizard(
  context: SetupWizardPromptContext,
): Promise<SetupWizardResult> {
  const cli = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    await writeSetupBanner(context.defaults.backend, context.defaults.importSummary);
    const backend = await chooseOne(
      cli,
      "Backend",
      ["codex", "hermes", "openclaw"] as const,
      context.defaults.backend,
    );
    const partyMode = (await chooseOne(
      cli,
      "Party mode",
      ["hybrid", "split"] as const,
      "hybrid",
    )) as SetupWizardPartyMode;
    const testerSelectionStrategy = await promptTesterSelectionStrategy(
      cli,
      context.defaults.testerSelectionStrategy,
    );

    const workerPlans: SetupWizardWorkerPlan[] = [];
    if (partyMode === "hybrid") {
      workerPlans.push(await promptWorkerPlan(cli, backend, "hybrid", context.defaults));
    } else {
      workerPlans.push(await promptWorkerPlan(cli, backend, "builder", context.defaults));
      workerPlans.push(await promptWorkerPlan(cli, backend, "tester", context.defaults));
    }

    await writeSetupSection("Observability", "Choose where quest events should be delivered.");
    const sinkPlan = await promptSinkPlan(cli, context.defaults);

    await writeSetupSection("Training Grounds", "Decide whether to calibrate the new party now.");
    const runCalibration = await confirmWithDefault(
      cli,
      "Send new party members to the Training Grounds now?",
      true,
    );
    const result = {
      calibrateWorkerIds: runCalibration ? deriveCalibrationIds(workerPlans) : [],
      settingsUpdate: {
        planner: {
          testerSelectionStrategy,
        },
      },
      sinkPlan,
      workerPlans,
    };
    await writeSetupSummary(partyMode, result);
    return result;
  } finally {
    cli.close();
  }
}
