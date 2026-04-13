import { createInterface } from "node:readline/promises";

export type SetupWizardBackend = "codex" | "hermes" | "openclaw";
export type SetupWizardSinkKind = "linear" | "none" | "slack" | "telegram" | "webhook";

export type SetupWizardWorkerPlan = {
  args: string[];
  backend: SetupWizardBackend;
};

export type SetupWizardSinkPlan = {
  args: string[];
  kind: Exclude<SetupWizardSinkKind, "none">;
} | null;

export type SetupWizardResult = {
  calibrateWorkerIds: string[];
  sinkPlan: SetupWizardSinkPlan;
  workerPlans: SetupWizardWorkerPlan[];
};

type SetupWizardDefaults = {
  backend: SetupWizardBackend;
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
    return "openclaw/main";
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
): Promise<SetupWizardWorkerPlan> {
  const name = await promptWithDefault(cli, `${role} name`, defaultWorkerName(backend, role));
  const profile = await promptWithDefault(cli, `${role} profile`, defaultProfile(backend));
  const args = ["--name", name, "--profile", profile, "--role", role];

  if (backend === "hermes") {
    const baseUrl = await promptWithDefault(cli, "Hermes base URL", "http://127.0.0.1:8000/v1");
    args.push("--base-url", baseUrl);
  }

  if (backend === "openclaw") {
    const agentId = await promptWithDefault(cli, "OpenClaw agent id", "main");
    args.push("--agent-id", agentId);
    if (await confirmWithDefault(cli, "Use local gateway mode?", false)) {
      args.push("--local");
    }
    const gatewayUrl = await promptWithDefault(cli, "Gateway URL", "");
    if (gatewayUrl.length > 0) {
      args.push("--gateway-url", gatewayUrl);
    }
  }

  args.push(...(await promptRuntimeArgs(cli)));
  return { args, backend };
}

async function promptSinkPlan(
  cli: ReturnType<typeof createInterface>,
): Promise<SetupWizardSinkPlan> {
  const sinkKind = await chooseOne(
    cli,
    "Observability sink",
    ["none", "webhook", "telegram", "slack", "linear"] as const,
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
    const chatId = await promptWithDefault(cli, "Telegram chat id", "");
    const authMode = await chooseOne(
      cli,
      "Telegram bot token source",
      ["env", "secret-store"] as const,
      "env",
    );
    if (authMode === "secret-store") {
      const secretRef = await promptWithDefault(
        cli,
        "Telegram bot token secret ref",
        "telegram.bot-token",
      );
      return {
        args: ["--chat-id", chatId, "--bot-token-secret-ref", secretRef],
        kind: "telegram",
      };
    }

    const botTokenEnv = await promptWithDefault(
      cli,
      "Telegram bot token env",
      "TELEGRAM_BOT_TOKEN",
    );
    return { args: ["--chat-id", chatId, "--bot-token-env", botTokenEnv], kind: "telegram" };
  }

  if (sinkKind === "slack") {
    const authMode = await chooseOne(
      cli,
      "Slack webhook source",
      ["direct", "env", "secret-store"] as const,
      "direct",
    );
    if (authMode === "env") {
      const urlEnv = await promptWithDefault(cli, "Slack webhook env", "SLACK_WEBHOOK_URL");
      return { args: ["--url-env", urlEnv], kind: "slack" };
    }
    if (authMode === "secret-store") {
      const secretRef = await promptWithDefault(cli, "Slack webhook secret ref", "slack.webhook");
      return { args: ["--secret-ref", secretRef], kind: "slack" };
    }

    const webhookUrl = await promptWithDefault(cli, "Slack webhook URL", "");
    return { args: ["--url", webhookUrl], kind: "slack" };
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

  const apiKeyEnv = await promptWithDefault(cli, "Linear API key env", "LINEAR_API_KEY");
  return { args: ["--issue-id", issueId, "--api-key-env", apiKeyEnv], kind: "linear" };
}

export async function runSetupWizard(
  context: SetupWizardPromptContext,
): Promise<SetupWizardResult> {
  const cli = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    void Bun.write(
      Bun.stdout,
      [
        "Quest Runner Setup Wizard",
        "",
        "Briefing",
        "  Build your first party, wire one sink, and optionally send the party to the Training Grounds.",
        "",
      ].join("\n"),
    );

    const backend = await chooseOne(
      cli,
      "Backend",
      ["codex", "hermes", "openclaw"] as const,
      context.defaults.backend,
    );
    const partyMode = await chooseOne(cli, "Party mode", ["hybrid", "split"] as const, "hybrid");

    const workerPlans: SetupWizardWorkerPlan[] = [];
    if (partyMode === "hybrid") {
      workerPlans.push(await promptWorkerPlan(cli, backend, "hybrid"));
    } else {
      workerPlans.push(await promptWorkerPlan(cli, backend, "builder"));
      workerPlans.push(await promptWorkerPlan(cli, backend, "tester"));
    }

    const sinkPlan = await promptSinkPlan(cli);
    const runCalibration = await confirmWithDefault(
      cli,
      "Send new party members to the Training Grounds now?",
      true,
    );

    return {
      calibrateWorkerIds: runCalibration
        ? workerPlans.map((plan) => {
            const nameIndex = plan.args.indexOf("--name");
            const name = nameIndex >= 0 ? (plan.args[nameIndex + 1] ?? plan.backend) : plan.backend;
            return name
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "");
          })
        : [],
      sinkPlan,
      workerPlans,
    };
  } finally {
    cli.close();
  }
}
