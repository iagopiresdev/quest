import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  select,
  text,
} from "@clack/prompts";
import type { TesterSelectionStrategy } from "../settings";
import { renderQuestBannerBlock } from "../ui/help";
import type { WorkerUpdate } from "../workers/management";
import { slugifyWorkerId } from "../workers/presets";
import type { WorkerRole } from "../workers/schema";
import {
  defaultSetupArchetype,
  getSetupArchetype,
  listSetupArchetypesForRole,
  type SetupWizardArchetypeId,
} from "./presets";
import {
  harnessHint,
  harnessLabel,
  isSetupWizardHarness,
  listModelsForHarness,
  openClawAgentForModel,
  type SetupWizardHarness,
  type SetupWizardHarnessChoice,
  type SetupWizardHarnessDefaults,
} from "./wizard-options";
import { renderWizardProgress, type WizardProgress } from "./wizard-progress";

export type { SetupWizardHarness, SetupWizardHarnessDefaults } from "./wizard-options";
export type SetupWizardSinkKind = "linear" | "none" | "openclaw" | "slack" | "telegram" | "webhook";

export type SetupWizardWorkerPlan = {
  args: string[];
  archetypeLabel: string;
  backend: SetupWizardHarness;
  update: WorkerUpdate;
};

export type SetupWizardSinkPlan = {
  args: string[];
  kind: Exclude<SetupWizardSinkKind, "none">;
} | null;

export type SetupWizardResult = {
  calibrateWorkerIds: string[];
  settingsUpdate: { planner: { testerSelectionStrategy: TesterSelectionStrategy } };
  sinkPlan: SetupWizardSinkPlan;
  workerPlans: SetupWizardWorkerPlan[];
};

type SetupWizardDefaults = {
  backend: SetupWizardHarness;
  harnessDefaults?: Partial<Record<SetupWizardHarness, SetupWizardHarnessDefaults>>;
  sinkDefaults?: {
    linearApiKeyEnv?: string;
    openClawAgentId?: string;
    openClawGatewayUrl?: string;
    openClawTelegramBotToken?: string;
    openClawTelegramChatId?: string;
    slackWebhookEnv?: string;
    telegramBotTokenEnv?: string;
  };
  testerSelectionStrategy: TesterSelectionStrategy;
};

type SetupWizardPromptContext = {
  defaults: SetupWizardDefaults;
  loadHarnessDefaults?: (
    harnesses: SetupWizardHarness[],
  ) =>
    | Partial<Record<SetupWizardHarness, SetupWizardHarnessDefaults>>
    | Promise<Partial<Record<SetupWizardHarness, SetupWizardHarnessDefaults>>>;
};

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

function page(progress: WizardProgress, section: string): void {
  process.stdout.write("\u001B[2J\u001B[H");
  process.stdout.write(renderQuestBannerBlock(72, true));
  const progressBlock = renderWizardProgress(progress);
  if (progressBlock) {
    note(progressBlock, "Progress");
  }
  intro(section);
}

async function askText(message: string, initial: string, placeholder?: string): Promise<string> {
  const answer = await text({
    initialValue: initial,
    message,
    placeholder: placeholder ?? initial,
  });
  const value = unwrap(answer).trim();
  return value.length > 0 ? value : initial;
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
  labels?: Partial<Record<TValue, string>>,
): Promise<TValue> {
  const options = choices.map((value) => {
    const option: { hint?: string; label: string; value: TValue } = {
      label: labels?.[value] ?? value,
      value,
    };
    if (hints?.[value] !== undefined) {
      option.hint = hints[value];
    }
    return option;
  });
  const answer = await select<TValue>({
    initialValue: initial,
    message,
    options: options as Parameters<typeof select<TValue>>[0]["options"],
  });
  return unwrap(answer);
}

function renderRoleClass(role: WorkerRole): string {
  if (role === "builder") return "Battle Engineer";
  if (role === "tester") return "Trial Judge";
  return "Adventurer";
}

async function promptHarnesses(defaults: SetupWizardDefaults): Promise<SetupWizardHarness[]> {
  const choices: SetupWizardHarnessChoice[] = [
    "codex",
    "claude-code",
    "opencode",
    "openclaw",
    "hermes",
  ];
  const answer = await multiselect<SetupWizardHarnessChoice>({
    initialValues: [defaults.backend],
    message: "Pick one or more -- you can register workers from each.",
    options: choices.map((value) => ({
      disabled: value === "claude-code" || value === "opencode" ? true : undefined,
      hint: harnessHint(value),
      label: harnessLabel(value),
      value,
    })) as Parameters<typeof multiselect<SetupWizardHarnessChoice>>[0]["options"],
    required: true,
  });
  const harnesses = unwrap(answer).filter(isSetupWizardHarness);
  if (harnesses.length === 0) {
    bail();
  }
  return harnesses;
}

async function resolveHarnessDefaults(
  context: SetupWizardPromptContext,
  harnesses: SetupWizardHarness[],
): Promise<Partial<Record<SetupWizardHarness, SetupWizardHarnessDefaults>>> {
  const defaults = { ...(context.defaults.harnessDefaults ?? {}) };
  const missing = harnesses.filter((harness) => defaults[harness] === undefined);
  if (missing.length > 0 && context.loadHarnessDefaults) {
    Object.assign(defaults, await context.loadHarnessDefaults(missing));
  }
  return defaults;
}

function importedArgs(
  harness: SetupWizardHarness,
  defaults: SetupWizardHarnessDefaults,
  model?: string,
): string[] {
  const args: string[] = [];
  if (defaults.executable) args.push("--executable", defaults.executable);
  if (harness === "codex") {
    if (defaults.authMode) args.push("--auth-mode", defaults.authMode);
    if (defaults.envVar) args.push("--env-var", defaults.envVar);
  }
  if (harness === "hermes" && defaults.baseUrl) args.push("--base-url", defaults.baseUrl);
  if (harness === "openclaw") {
    const agentId = model ? openClawAgentForModel(defaults, model) : defaults.agentId;
    if (agentId) args.push("--agent-id", agentId);
    if (defaults.baseUrl) args.push("--gateway-url", defaults.baseUrl);
  }
  return args;
}

async function promptFreshArgs(
  harness: SetupWizardHarness,
  defaults: SetupWizardHarnessDefaults | undefined,
  progress: WizardProgress,
): Promise<string[]> {
  if (harness === "codex") {
    page(progress, "Codex credentials");
    const mode = await askSelect(
      "Codex auth source",
      ["native-login", "env-var", "secret-store"] as const,
      "native-login",
    );
    if (mode === "env-var") {
      page(progress, "Codex credentials");
      const envVar = await askText("OpenAI API key env", defaults?.envVar ?? "OPENAI_API_KEY");
      return ["--no-import-existing", "--auth-mode", "env-var", "--env-var", envVar];
    }
    if (mode === "secret-store") {
      page(progress, "Codex credentials");
      const secretRef = await askText("OpenAI API key secret ref", "openai.api-key");
      return ["--no-import-existing", "--auth-mode", "secret-store", "--secret-ref", secretRef];
    }
    return ["--no-import-existing", "--auth-mode", "native-login"];
  }

  if (harness === "hermes") {
    page(progress, "Hermes credentials");
    const baseUrl = await askText(
      "Hermes base URL",
      defaults?.baseUrl ?? "http://127.0.0.1:8000/v1",
    );
    return ["--no-import-existing", "--base-url", baseUrl];
  }

  page(progress, "OpenClaw credentials");
  const agentId = await askText("OpenClaw agent id", defaults?.agentId ?? "main");
  page(progress, "OpenClaw credentials");
  const gatewayUrl = await askText("OpenClaw gateway URL", defaults?.baseUrl ?? "");
  const args = ["--no-import-existing", "--agent-id", agentId];
  if (gatewayUrl.length > 0) args.push("--gateway-url", gatewayUrl);
  return args;
}

async function promptHarnessImports(
  harnesses: SetupWizardHarness[],
  defaultsByHarness: Partial<Record<SetupWizardHarness, SetupWizardHarnessDefaults>>,
  progress: WizardProgress,
): Promise<Map<SetupWizardHarness, string[]>> {
  const argsByHarness = new Map<SetupWizardHarness, string[]>();
  for (const harness of harnesses) {
    const defaults = defaultsByHarness[harness];
    if (!defaults?.importSummary) {
      argsByHarness.set(harness, await promptFreshArgs(harness, defaults, progress));
      continue;
    }

    page(progress, `Import ${harnessLabel(harness)}`);
    const accept = await askConfirm(`Use detected ${harnessLabel(harness)} login?`, true);
    if (accept) {
      progress.imports = [...(progress.imports ?? []), harness];
      argsByHarness.set(harness, importedArgs(harness, defaults));
    } else {
      argsByHarness.set(harness, await promptFreshArgs(harness, defaults, progress));
    }
  }
  return argsByHarness;
}

function uniqueWorkerId(
  harness: SetupWizardHarness,
  role: WorkerRole,
  name: string,
  progress: WizardProgress,
): string {
  const baseId = slugifyWorkerId(`${harness}-${role}-${name}`, `${harness}-${role}-worker`);
  const existingIds = new Set(progress.workers.map((worker) => worker.id));
  if (!existingIds.has(baseId)) return baseId;
  for (let index = 2; ; index += 1) {
    const candidate = `${baseId}-${index}`;
    if (!existingIds.has(candidate)) return candidate;
  }
}

async function promptWorkerForModel(
  harness: SetupWizardHarness,
  model: string,
  defaults: SetupWizardHarnessDefaults | undefined,
  baseArgs: string[],
  progress: WizardProgress,
): Promise<SetupWizardWorkerPlan> {
  const section = `Register ${harness}:${model}`;
  page(progress, section);
  const name = await askText("Name", model);

  page(progress, section);
  const role = await askSelect("Role", ["builder", "tester", "hybrid"] as const, "hybrid", {
    builder: "Owns encounters and writes code",
    hybrid: "Runs both encounters and trials",
    tester: "Owns trials and checks work",
  });

  page(progress, section);
  const archetypes = listSetupArchetypesForRole(role);
  const initialArchetype = defaultSetupArchetype(role).id;
  const archetypeId = await askSelect(
    "Archetype",
    archetypes.map((archetype) => archetype.id),
    initialArchetype,
    Object.fromEntries(archetypes.map((archetype) => [archetype.id, archetype.description])),
    Object.fromEntries(archetypes.map((archetype) => [archetype.id, archetype.label])),
  );
  const archetype = getSetupArchetype(archetypeId as SetupWizardArchetypeId);
  const id = uniqueWorkerId(harness, role, name, progress);
  const args = ["--name", name, "--profile", model, "--role", role, "--id", id, ...baseArgs];

  if (harness === "openclaw" && !args.includes("--agent-id")) {
    const agentId = openClawAgentForModel(defaults, model);
    if (agentId) args.push("--agent-id", agentId);
  }

  progress.workers.push({
    archetype: archetype.label,
    harness,
    id,
    model,
    name,
    role: renderRoleClass(role),
  });

  return { archetypeLabel: archetype.label, args, backend: harness, update: archetype.update };
}

async function promptWorkersForHarness(
  harness: SetupWizardHarness,
  defaults: SetupWizardHarnessDefaults | undefined,
  baseArgs: string[],
  progress: WizardProgress,
): Promise<SetupWizardWorkerPlan[]> {
  const models = listModelsForHarness(harness, defaults);
  const done = `__done_${harness}__`;
  const plans: SetupWizardWorkerPlan[] = [];

  for (;;) {
    page(progress, `${harnessLabel(harness)} models`);
    const choices = [...models, done];
    const labels = Object.fromEntries(choices.map((choice) => [choice, choice]));
    labels[done] = `Done with ${harnessLabel(harness)}`;
    const hints = Object.fromEntries(
      models.map((model) => {
        const registered = progress.workers.filter(
          (worker) => worker.harness === harness && worker.model === model,
        );
        return [
          model,
          registered.length > 0
            ? `Already registered as ${registered.map((worker) => worker.name).join(", ")}`
            : "Register a new worker that runs on this model",
        ];
      }),
    );
    hints[done] =
      plans.length > 0 ? "Move on to the next step" : "Register at least one worker first";
    const choice = await askSelect(
      "Pick a model to register",
      choices,
      models[0] ?? done,
      hints,
      labels,
    );
    if (choice === done) {
      if (plans.length > 0) return plans;
      continue;
    }
    plans.push(await promptWorkerForModel(harness, choice, defaults, baseArgs, progress));
  }
}

async function promptTelegramSinkPlan(
  defaults: SetupWizardDefaults,
  progress: WizardProgress,
): Promise<SetupWizardSinkPlan> {
  const detectedToken = defaults.sinkDefaults?.openClawTelegramBotToken;
  const detectedChatId = defaults.sinkDefaults?.openClawTelegramChatId;
  page(progress, "Telegram sink");
  const chatId = await askText("Telegram chat id", detectedChatId ?? "");
  page(progress, "Telegram sink");
  const authModes = detectedToken
    ? (["openclaw-import", "env", "secret-store"] as const)
    : (["env", "secret-store"] as const);
  const authMode = await askSelect(
    "Telegram bot token source",
    authModes,
    detectedToken ? "openclaw-import" : "env",
  );
  page(progress, "Telegram sink");
  const useCards = await askConfirm("Render events as RPG flavor cards?", true);
  const parseModeArgs = useCards ? ["--parse-mode", "HTML"] : [];

  if (authMode === "openclaw-import" && detectedToken) {
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
    page(progress, "Telegram sink");
    const secretRef = await askText("Telegram bot token secret ref", "telegram.bot-token");
    return {
      args: ["--chat-id", chatId, "--bot-token-secret-ref", secretRef, ...parseModeArgs],
      kind: "telegram",
    };
  }
  page(progress, "Telegram sink");
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
  page(progress, "Observability");
  const sinkKind = await askSelect(
    "Observability sink",
    ["none", "webhook", "telegram", "slack", "linear", "openclaw"] as const,
    "none",
    {
      linear: "Issue tracker cards",
      none: "Skip observability",
      openclaw: "Pipe events into OpenClaw",
      slack: "Post to a Slack webhook",
      telegram: "Post Telegram cards",
      webhook: "POST JSON events to HTTP",
    },
  );
  progress.sink = sinkKind;
  if (sinkKind === "none") return null;
  if (sinkKind === "webhook") return await promptWebhookSink(progress);
  if (sinkKind === "telegram") return await promptTelegramSinkPlan(defaults, progress);
  if (sinkKind === "slack") return await promptSlackSink(defaults, progress);
  if (sinkKind === "openclaw") return await promptOpenClawSink(defaults, progress);
  return await promptLinearSink(defaults, progress);
}

async function promptWebhookSink(progress: WizardProgress): Promise<SetupWizardSinkPlan> {
  page(progress, "Webhook sink");
  return {
    args: ["--url", await askText("Webhook URL", "http://127.0.0.1:3000/quest")],
    kind: "webhook",
  };
}

async function promptSlackSink(
  defaults: SetupWizardDefaults,
  progress: WizardProgress,
): Promise<SetupWizardSinkPlan> {
  page(progress, "Slack sink");
  const mode = await askSelect(
    "Slack webhook source",
    ["direct", "env", "secret-store"] as const,
    "direct",
  );
  page(progress, "Slack sink");
  if (mode === "env")
    return {
      args: [
        "--url-env",
        await askText(
          "Slack webhook env",
          defaults.sinkDefaults?.slackWebhookEnv ?? "SLACK_WEBHOOK_URL",
        ),
      ],
      kind: "slack",
    };
  if (mode === "secret-store")
    return {
      args: ["--secret-ref", await askText("Slack webhook secret ref", "slack.webhook")],
      kind: "slack",
    };
  return { args: ["--url", await askText("Slack webhook URL", "")], kind: "slack" };
}

async function promptOpenClawSink(
  defaults: SetupWizardDefaults,
  progress: WizardProgress,
): Promise<SetupWizardSinkPlan> {
  page(progress, "OpenClaw sink");
  const agentId = await askText(
    "OpenClaw sink agent id",
    defaults.sinkDefaults?.openClawAgentId ?? "main",
  );
  page(progress, "OpenClaw sink");
  const sessionId = await askText("OpenClaw sink session id", "quest-observability");
  page(progress, "OpenClaw sink");
  const gatewayUrl = await askText(
    "OpenClaw sink gateway URL",
    defaults.sinkDefaults?.openClawGatewayUrl ?? "",
  );
  const args = ["--agent-id", agentId, "--session-id", sessionId];
  if (gatewayUrl.length > 0) args.push("--gateway-url", gatewayUrl);
  return { args, kind: "openclaw" };
}

async function promptLinearSink(
  defaults: SetupWizardDefaults,
  progress: WizardProgress,
): Promise<SetupWizardSinkPlan> {
  page(progress, "Linear sink");
  const issueId = await askText("Linear issue id", "");
  page(progress, "Linear sink");
  const mode = await askSelect("Linear API key source", ["env", "secret-store"] as const, "env");
  page(progress, "Linear sink");
  if (mode === "secret-store")
    return {
      args: [
        "--issue-id",
        issueId,
        "--api-key-secret-ref",
        await askText("Linear API key secret ref", "linear.api-key"),
      ],
      kind: "linear",
    };
  return {
    args: [
      "--issue-id",
      issueId,
      "--api-key-env",
      await askText(
        "Linear API key env",
        defaults.sinkDefaults?.linearApiKeyEnv ?? "LINEAR_API_KEY",
      ),
    ],
    kind: "linear",
  };
}

function deriveCalibrationIds(workerPlans: SetupWizardWorkerPlan[]): string[] {
  return workerPlans.map(
    (plan) =>
      readPlanArg(plan, "--id") ?? slugifyWorkerId(readPlanArg(plan, "--name") ?? plan.backend),
  );
}

function readPlanArg(plan: SetupWizardWorkerPlan, flag: string): string | null {
  const index = plan.args.indexOf(flag);
  return index >= 0 ? (plan.args[index + 1] ?? null) : null;
}

function renderSummaryNote(result: SetupWizardResult): string {
  const workerLines = result.workerPlans.map((plan) => {
    const role = readPlanArg(plan, "--role") ?? "hybrid";
    const name = readPlanArg(plan, "--name") ?? "Unnamed party member";
    const profile = readPlanArg(plan, "--profile") ?? "default";
    return `- ${name} (${renderRoleClass(role as WorkerRole)}) - ${plan.backend}:${profile}`;
  });
  const calibration =
    result.calibrateWorkerIds.length > 0 ? result.calibrateWorkerIds.join(", ") : "skipped";
  return [
    `Roster (${result.workerPlans.length}):`,
    ...workerLines,
    `Sink: ${result.sinkPlan?.kind ?? "none"}`,
    `Training Grounds: ${calibration}`,
  ].join("\n");
}

export async function runSetupWizard(
  context: SetupWizardPromptContext,
): Promise<SetupWizardResult> {
  const progress: WizardProgress = { workers: [] };
  page(progress, "Harnesses");
  const harnesses = await promptHarnesses(context.defaults);
  progress.harnesses = harnesses;

  const defaultsByHarness = await resolveHarnessDefaults(context, harnesses);
  const argsByHarness = await promptHarnessImports(harnesses, defaultsByHarness, progress);
  const workerPlans: SetupWizardWorkerPlan[] = [];
  for (const harness of harnesses) {
    workerPlans.push(
      ...(await promptWorkersForHarness(
        harness,
        defaultsByHarness[harness],
        argsByHarness.get(harness) ?? [],
        progress,
      )),
    );
  }

  const sinkPlan = await promptSinkPlan(context.defaults, progress);
  page(progress, "Training Grounds");
  const runCalibration = await askConfirm(
    "Send new party members to the Training Grounds now?",
    true,
  );
  progress.trainingGrounds = runCalibration ? "yes" : "no";
  const result: SetupWizardResult = {
    calibrateWorkerIds: runCalibration ? deriveCalibrationIds(workerPlans) : [],
    settingsUpdate: {
      planner: { testerSelectionStrategy: context.defaults.testerSelectionStrategy },
    },
    sinkPlan,
    workerPlans,
  };

  process.stdout.write("\u001B[2J\u001B[H");
  process.stdout.write(renderQuestBannerBlock(72, true));
  intro("Setup complete");
  note(renderSummaryNote(result), "Setup Summary");
  outro("Party ready. Run `quest party dispatch` when you're good to go.");
  return result;
}
