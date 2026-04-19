import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import type { TesterSelectionStrategy } from "../settings";
import { renderQuestBannerBlock } from "../ui/help";
import { colorize } from "../ui/terminal";
import type { WorkerUpdate } from "../workers/management";
import { slugifyWorkerId } from "../workers/presets";
import { defaultSetupArchetype, type SetupWizardPartyMode } from "./presets";

// Harness = the runtime CLI/agent that actually executes a worker. The wizard treats this as a
// presentation concept; the existing worker schema and adapter registry already model it via
// `worker.backend.adapter`. Renamed from "Backend" because operators recognise this as the
// industry term used by Anthropic + OpenAI for agent runtimes.
export type SetupWizardHarness = "codex" | "hermes" | "openclaw" | "standalone";
export type SetupWizardHarnessChoice = SetupWizardHarness | "claude-code" | "opencode";
// Backwards-compatible alias for callers that still spell it "backend" in their type imports
// (e.g. cli.ts::buildSetupWizardDefaults). Internal call sites should prefer SetupWizardHarness.
export type SetupWizardBackend = SetupWizardHarness;
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
  backend: SetupWizardHarness;
  baseUrl?: string;
  envVar?: string;
  harnessDefaults?: Partial<Record<SetupWizardHarness, SetupWizardHarnessDefaults>>;
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

export type SetupWizardHarnessDefaults = {
  agentId?: string;
  baseUrl?: string;
  envVar?: string;
  executable?: string;
  importSummary?: string;
  profile?: string;
};

type SetupWizardPromptContext = {
  defaults: SetupWizardDefaults;
  loadHarnessDefaults?: (
    harnesses: SetupWizardHarness[],
  ) =>
    | Partial<Record<SetupWizardHarness, SetupWizardHarnessDefaults>>
    | Promise<Partial<Record<SetupWizardHarness, SetupWizardHarnessDefaults>>>;
};

// Live breadcrumb state the wizard mutates as prompts are answered. Each rendered page shows
// whatever is currently in here, so the operator always sees what they already picked and can
// reason about what is still to come.
type WizardProgress = {
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

async function withSpinner<T>(message: string, task: () => Promise<T> | T): Promise<T> {
  const s = spinner();
  s.start(message);
  try {
    const result = await task();
    s.stop(message.replace("...", " done"));
    return result;
  } catch (error: unknown) {
    s.stop(`${colorize("✗", "red")} failed`);
    throw error;
  }
}

// Clear screen + move cursor home, then redraw the QUEST banner and a breadcrumb block
// summarizing completed steps. Called before every prompt to enforce "page per step" — operator
// sees one decision at a time with a persistent header + progress panel.
function page(progress: WizardProgress, section: string): void {
  process.stdout.write("\u001B[2J\u001B[H");
  process.stdout.write(renderQuestBannerBlock(72, true));
  const breadcrumb = renderBreadcrumb(progress);
  if (breadcrumb) {
    note(breadcrumb, "Progress");
  }
  intro(section);
}

// Render the progress panel as a tabular quest sheet: section headers, aligned columns, filled
// (✓) markers for completed decisions, hollow (◯) markers for pending. Lands inside a clack
// note() box so every page opens with a readable snapshot of everything the operator has
// decided so far.
function renderBreadcrumb(progress: WizardProgress): string | null {
  const labelWidth = 16;
  const pad = (label: string): string => label.padEnd(labelWidth, " ");
  const row = (done: boolean, label: string, value: string): string => {
    const marker = done ? colorize("✓", "green") : colorize("◯", "dim");
    const shownValue = done ? value : colorize("—", "dim");
    return `  ${marker} ${pad(label)}${shownValue}`;
  };

  // Progress bar using block characters
  const steps = [
    { done: progress.harnesses !== undefined && progress.harnesses.length > 0, label: "Harness" },
    { done: progress.workers.length > 0, label: "Roster" },
    { done: progress.sink !== undefined, label: "Sink" },
    { done: progress.trainingGrounds !== undefined, label: "Train" },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const barWidth = 20;
  const filled = Math.round((doneCount / steps.length) * barWidth);
  const bar =
    colorize("█".repeat(filled), "green") + colorize("░".repeat(barWidth - filled), "dim");
  const progressLine = `${bar} ${doneCount}/${steps.length}`;

  const sections: Array<{ rows: string[]; title: string }> = [];

  const coreRows: string[] = [];
  coreRows.push(
    row(
      progress.harnesses !== undefined && progress.harnesses.length > 0,
      "Harnesses",
      progress.harnesses?.join(", ") ?? "",
    ),
  );
  if (progress.imports && progress.imports.length > 0) {
    coreRows.push(row(true, "Imported", progress.imports.join(", ")));
  }
  sections.push({ rows: coreRows, title: "Core" });

  if (progress.workers.length > 0) {
    const workerRows = progress.workers.map((worker) =>
      row(true, worker.role, `${worker.name} (${worker.harness}:${worker.model})`),
    );
    sections.push({ rows: workerRows, title: "Roster" });
  }

  sections.push({
    rows: [row(progress.sink !== undefined, "Sink", progress.sink ?? "")],
    title: "Observability",
  });

  sections.push({
    rows: [
      row(progress.trainingGrounds !== undefined, "Calibration", progress.trainingGrounds ?? ""),
    ],
    title: "Training",
  });

  const blocks: string[] = [progressLine, ""];
  for (const section of sections) {
    blocks.push(section.title);
    blocks.push(...section.rows);
    blocks.push("");
  }
  while (blocks.length > 0 && blocks[blocks.length - 1] === "") {
    blocks.pop();
  }
  return blocks.length > 0 ? blocks.join("\n") : null;
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

// Map internal role to its operator-facing class label. Per docs/design-system.mdx the internal
// model stays plain (worker/builder/tester) but presentation always uses the RPG aliases.
function renderRoleClass(role: "builder" | "tester" | "hybrid"): string {
  if (role === "builder") {
    return "Battle Engineer";
  }
  if (role === "tester") {
    return "Trial Judge";
  }
  return "Adventurer";
}

// Per-harness model catalog. Closed-API harnesses (codex, claude-code) hardcode the menu;
// self-hosted / locally-detected harnesses (hermes, openclaw) substitute their own catalog at
// detection time. The wizard treats this as a presentation hint — it stamps the chosen model
// into `--profile` on the worker plan, where the adapter consumes it.
const HARNESS_MODEL_CATALOG: Record<SetupWizardHarness, readonly string[]> = {
  codex: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.3-codex", "gpt-5.3-codex-spark"],
  hermes: [],
  openclaw: [],
  standalone: [],
};

function defaultsForHarness(
  defaults: SetupWizardDefaults,
  harness: SetupWizardHarness,
): SetupWizardHarnessDefaults {
  const legacyDefaults =
    defaults.backend === harness
      ? {
          ...(defaults.agentId ? { agentId: defaults.agentId } : {}),
          ...(defaults.baseUrl ? { baseUrl: defaults.baseUrl } : {}),
          ...(defaults.envVar ? { envVar: defaults.envVar } : {}),
          ...(defaults.importSummary ? { importSummary: defaults.importSummary } : {}),
          ...(defaults.profile ? { profile: defaults.profile } : {}),
        }
      : {};
  return { ...legacyDefaults, ...(defaults.harnessDefaults?.[harness] ?? {}) };
}

function mergeHarnessDefaults(
  defaults: SetupWizardDefaults,
  updates: Partial<Record<SetupWizardHarness, SetupWizardHarnessDefaults>>,
): SetupWizardDefaults {
  const harnessDefaults: Partial<Record<SetupWizardHarness, SetupWizardHarnessDefaults>> = {
    ...(defaults.harnessDefaults ?? {}),
  };
  for (const harness of Object.keys(updates) as SetupWizardHarness[]) {
    harnessDefaults[harness] = {
      ...(harnessDefaults[harness] ?? {}),
      ...(updates[harness] ?? {}),
    };
  }
  return { ...defaults, harnessDefaults };
}

// Detected harness defaults the wizard pulls from `context.defaults`. cli.ts populates these
// after running detection.ts probes; the wizard then asks per-harness whether to import.
type HarnessImportOffer = {
  // Short blurb shown next to the import confirm prompt (e.g. "Codex login active via /opt/...").
  description: string;
  // The flag we add to the worker plan when import is accepted. For hermes/openclaw this is
  // typically `--base-url` / `--gateway-url` / `--agent-id`; for codex it's a marker.
  importMarker: () => string[];
};

function buildHarnessImportOffer(
  harness: SetupWizardHarness,
  defaults: SetupWizardDefaults,
): HarnessImportOffer | null {
  const harnessDefaults = defaultsForHarness(defaults, harness);
  if (!harnessDefaults.importSummary) {
    return null;
  }
  if (harness === "codex") {
    return {
      description: harnessDefaults.importSummary,
      importMarker: () => {
        const args = harnessDefaults.envVar
          ? ["--auth-mode", "env-var", "--env-var", harnessDefaults.envVar]
          : ["--auth-mode", "native-login"];
        if (harnessDefaults.executable) {
          args.push("--executable", harnessDefaults.executable);
        }
        return args;
      },
    };
  }
  if (harness === "hermes" && harnessDefaults.baseUrl) {
    return {
      description: harnessDefaults.importSummary,
      importMarker: () => ["--base-url", harnessDefaults.baseUrl ?? "http://127.0.0.1:8000/v1"],
    };
  }
  if (harness === "openclaw" && (harnessDefaults.agentId || harnessDefaults.baseUrl)) {
    return {
      description: harnessDefaults.importSummary,
      importMarker: () => {
        const args: string[] = [];
        if (harnessDefaults.agentId) {
          args.push("--agent-id", harnessDefaults.agentId);
        }
        if (harnessDefaults.baseUrl) {
          args.push("--gateway-url", harnessDefaults.baseUrl);
        }
        if (harnessDefaults.executable) {
          args.push("--executable", harnessDefaults.executable);
        }
        return args;
      },
    };
  }
  return null;
}

function harnessLabel(harness: SetupWizardHarnessChoice): string {
  if (harness === "claude-code") {
    return "claude-code";
  }
  if (harness === "opencode") {
    return "opencode";
  }
  if (harness === "standalone") {
    return "standalone";
  }
  return harness;
}

function harnessHint(harness: SetupWizardHarnessChoice): string {
  if (harness === "codex") {
    return "OpenAI Codex CLI";
  }
  if (harness === "claude-code") {
    return "Anthropic Claude Code CLI (adapter coming soon)";
  }
  if (harness === "opencode") {
    return "OpenCode CLI (adapter coming soon)";
  }
  if (harness === "openclaw") {
    return "OpenClaw gateway agent";
  }
  if (harness === "standalone") {
    return "Standalone local command";
  }
  return "Self-hosted Hermes endpoint";
}

// Multi-select list of all harnesses, with claude-code and opencode disabled until adapters land.
async function promptHarnesses(defaults: SetupWizardDefaults): Promise<SetupWizardHarness[]> {
  const allChoices: SetupWizardHarnessChoice[] = [
    "codex",
    "standalone",
    "claude-code",
    "opencode",
    "openclaw",
    "hermes",
  ];
  const options = allChoices.map((value) => {
    const disabled = value === "claude-code" || value === "opencode";
    return {
      hint: harnessHint(value),
      label: harnessLabel(value),
      value,
      ...(disabled ? { disabled: true as const } : {}),
    };
  });
  const initialValues: SetupWizardHarness[] = [defaults.backend];
  const answer = await multiselect<SetupWizardHarnessChoice>({
    initialValues,
    message: "Pick one or more harnesses (you can register workers from each)",
    options: options as Parameters<typeof multiselect<SetupWizardHarnessChoice>>[0]["options"],
    required: true,
  });
  const picked = unwrap(answer).filter(
    (value): value is SetupWizardHarness =>
      value === "codex" || value === "hermes" || value === "openclaw" || value === "standalone",
  );
  if (picked.length === 0) {
    bail();
  }
  return picked;
}

// For each chosen harness, if creds were detected, ask whether to import them. Records the
// imported list in the breadcrumb so subsequent pages show what was carried over.
async function promptHarnessImports(
  harnesses: SetupWizardHarness[],
  defaults: SetupWizardDefaults,
  progress: WizardProgress,
): Promise<Map<SetupWizardHarness, string[]>> {
  const importedArgs = new Map<SetupWizardHarness, string[]>();
  for (const harness of harnesses) {
    const offer = buildHarnessImportOffer(harness, defaults);
    if (!offer) {
      continue;
    }
    page(progress, `Import ${harnessLabel(harness)}`);
    note(offer.description, "Detected");
    const accept = await askConfirm(`Import detected ${harnessLabel(harness)} credentials?`, true);
    if (accept) {
      importedArgs.set(harness, offer.importMarker());
      progress.imports = [...(progress.imports ?? []), harness];
    } else {
      importedArgs.set(harness, ["--no-import-existing"]);
    }
  }
  return importedArgs;
}

// Probe the harness for available models. Closed-API harnesses use HARNESS_MODEL_CATALOG;
// hermes / openclaw fall back to a detected `defaults.profile` because we don't yet probe their
// model catalog from the wizard. Operators with custom Hermes models can free-text the model
// name on the worker page.
function listModelsForHarness(
  harness: SetupWizardHarness,
  defaults: SetupWizardDefaults,
): string[] {
  const catalog = HARNESS_MODEL_CATALOG[harness];
  if (catalog.length > 0) {
    return [...catalog];
  }
  const harnessDefaults = defaultsForHarness(defaults, harness);
  if (harnessDefaults.profile) {
    return [harnessDefaults.profile];
  }
  if (harness === "hermes") {
    return ["hermes"];
  }
  return ["openai-codex/gpt-5.4"];
}

function uniqueWorkerId(
  harness: SetupWizardHarness,
  role: "builder" | "tester" | "hybrid",
  name: string,
  progress: WizardProgress,
): string {
  const baseId = slugifyWorkerId(`${harness}-${role}-${name}`, `${harness}-${role}-worker`);
  const existingIds = new Set(progress.workers.map((worker) => worker.id));
  if (!existingIds.has(baseId)) {
    return baseId;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${baseId}-${suffix}`;
    if (!existingIds.has(candidate)) {
      return candidate;
    }
  }
}

// Per-worker registration page. Lands once the operator has picked a model from the harness's
// model list. Asks name → role → archetype, plus harness-specific bits (Hermes base URL,
// OpenClaw agent id) when the import offer didn't already cover them.
async function promptWorkerForModel(
  harness: SetupWizardHarness,
  model: string,
  defaults: SetupWizardDefaults,
  importedArgs: string[],
  progress: WizardProgress,
): Promise<SetupWizardWorkerPlan> {
  const sectionTitle =
    harness === "standalone" ? "Register standalone" : `Register ${harness}:${model}`;

  page(progress, sectionTitle);
  const role = await askSelect("Role", ["builder", "tester", "hybrid"] as const, "hybrid", {
    builder: "Owns encounters (writes code)",
    hybrid: "Runs both encounters and trials",
    tester: "Owns trials (runs acceptance checks)",
  });
  const roleClass = renderRoleClass(role);

  page(progress, sectionTitle);
  // Default name is just the model id. The role class already shows up in the roster column,
  // and the archetype is invisible machinery derived from role, so prefixing the default with
  // either would repeat the same word up to three times per worker in the breadcrumb/summary.
  const defaultName = harness === "standalone" ? "Standalone Worker" : model;
  const name = await askText("Name", defaultName);

  // Archetype is derived from role to keep the wizard short. Power users can edit the worker
  // JSON post-setup to swap to a different archetype within the same role bucket
  // (`listSetupArchetypesForRole(role)` enumerates the alternatives).
  const archetype = defaultSetupArchetype(role);
  const id = uniqueWorkerId(harness, role, name, progress);

  const args: string[] = [
    "--id",
    id,
    "--name",
    name,
    "--profile",
    model,
    "--role",
    role,
    ...importedArgs,
  ];
  const harnessDefaults = defaultsForHarness(defaults, harness);

  if (harness === "hermes" && !args.includes("--base-url")) {
    page(progress, sectionTitle);
    const baseUrl = await askText(
      "Hermes base URL",
      harnessDefaults.baseUrl ?? "http://127.0.0.1:8000/v1",
    );
    args.push("--base-url", baseUrl);
  }
  if (harness === "openclaw" && !args.includes("--agent-id")) {
    page(progress, sectionTitle);
    const agentId = await askText("OpenClaw agent id", harnessDefaults.agentId ?? "main");
    args.push("--agent-id", agentId);
  }
  if (harness === "standalone") {
    page(progress, sectionTitle);
    const command = await askText("Command", "bun ./worker.ts");
    args.push("--command", command);
  }

  progress.workers.push({
    archetype: archetype.label,
    harness,
    id,
    model,
    name,
    role: roleClass,
  });

  return {
    archetypeLabel: archetype.label,
    args,
    backend: harness,
    update: archetype.update,
  };
}

// Worker registration for one harness. Model-based harnesses use a multiselect so the operator
// can choose all models in one pass. Standalone registers one local-command worker.
async function promptWorkersForHarness(
  harness: SetupWizardHarness,
  defaults: SetupWizardDefaults,
  importedArgs: string[],
  progress: WizardProgress,
): Promise<SetupWizardWorkerPlan[]> {
  if (harness === "standalone") {
    return [await promptWorkerForModel(harness, "standalone", defaults, importedArgs, progress)];
  }

  const models = listModelsForHarness(harness, defaults);
  const workers: SetupWizardWorkerPlan[] = [];
  page(progress, `${harnessLabel(harness)} models`);
  const selectedModels = unwrap(
    await multiselect<string>({
      initialValues: models[0] ? [models[0]] : [],
      message: `Pick one or more ${harnessLabel(harness)} models to register`,
      options: models.map((model) => ({
        hint: "Register a worker that runs on this model",
        label: model,
        value: model,
      })),
      required: true,
    }),
  );
  for (const model of selectedModels) {
    workers.push(await promptWorkerForModel(harness, model, defaults, importedArgs, progress));
  }
  return workers;
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

  page(progress, "Telegram sink");
  const useRpgCards = await askConfirm(
    "Render events as RPG flavor cards (HTML parse mode)?",
    true,
  );
  const parseModeArgs = useRpgCards ? ["--parse-mode", "HTML"] : [];

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
      linear: "Issue tracker — cards move through workflow",
      none: "Skip observability",
      openclaw: "Pipe events into the OpenClaw gateway",
      slack: "Post to a Slack channel webhook",
      telegram: "RPG cards (⚔️ Quest Accepted, 💀 Party Wiped)",
      webhook: "POST JSON events to an HTTP endpoint",
    },
  );
  if (sinkKind === "none") {
    progress.sink = "none";
    return null;
  }
  progress.sink = sinkKind;

  if (sinkKind === "webhook") {
    page(progress, "Webhook sink");
    const url = await askText("Webhook URL", "http://127.0.0.1:3000/quest");
    return { args: ["--url", url], kind: "webhook" };
  }

  if (sinkKind === "telegram") {
    return await promptTelegramSinkPlan(defaults, progress);
  }

  if (sinkKind === "slack") {
    page(progress, "Slack sink");
    const authMode = await askSelect(
      "Slack webhook source",
      ["direct", "env", "secret-store"] as const,
      "direct",
    );
    if (authMode === "env") {
      page(progress, "Slack sink");
      const urlEnv = await askText(
        "Slack webhook env",
        defaults.sinkDefaults?.slackWebhookEnv ?? "SLACK_WEBHOOK_URL",
      );
      return { args: ["--url-env", urlEnv], kind: "slack" };
    }
    if (authMode === "secret-store") {
      page(progress, "Slack sink");
      const secretRef = await askText("Slack webhook secret ref", "slack.webhook");
      return { args: ["--secret-ref", secretRef], kind: "slack" };
    }
    page(progress, "Slack sink");
    const webhookUrl = await askText("Slack webhook URL", "");
    return { args: ["--url", webhookUrl], kind: "slack" };
  }

  if (sinkKind === "openclaw") {
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
    if (gatewayUrl.length > 0) {
      args.push("--gateway-url", gatewayUrl);
    }
    return { args, kind: "openclaw" };
  }

  page(progress, "Linear sink");
  const issueId = await askText("Linear issue id", "");
  page(progress, "Linear sink");
  const authMode = await askSelect(
    "Linear API key source",
    ["env", "secret-store"] as const,
    "env",
  );
  if (authMode === "secret-store") {
    page(progress, "Linear sink");
    const secretRef = await askText("Linear API key secret ref", "linear.api-key");
    return { args: ["--issue-id", issueId, "--api-key-secret-ref", secretRef], kind: "linear" };
  }
  page(progress, "Linear sink");
  const apiKeyEnv = await askText(
    "Linear API key env",
    defaults.sinkDefaults?.linearApiKeyEnv ?? "LINEAR_API_KEY",
  );
  return { args: ["--issue-id", issueId, "--api-key-env", apiKeyEnv], kind: "linear" };
}

function deriveCalibrationIds(workerPlans: SetupWizardWorkerPlan[]): string[] {
  return workerPlans.map((plan) => {
    const id = readPlanArg(plan, "--id");
    if (id) {
      return id;
    }
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

function renderSummaryNote(result: SetupWizardResult): string {
  const workerLines = result.workerPlans.map((plan) => {
    const role = readPlanArg(plan, "--role") ?? "hybrid";
    const roleClass = renderRoleClass(role as "builder" | "tester" | "hybrid");
    const name = readPlanArg(plan, "--name") ?? "Unnamed party member";
    const profile = readPlanArg(plan, "--profile") ?? "default";
    return `• ${name} (${roleClass}) · ${plan.backend}:${profile}`;
  });
  const calibration =
    result.calibrateWorkerIds.length > 0 ? result.calibrateWorkerIds.join(", ") : "skipped";
  const lines = [
    `Roster (${result.workerPlans.length}):`,
    ...workerLines,
    `Sink: ${result.sinkPlan?.kind ?? "none"}`,
    `Training Grounds: ${calibration}`,
  ];
  return lines.join("\n");
}

// `partyMode` exists only for backwards compatibility — internal code still references it via
// SetupWizardPartyMode. The new wizard does not ask the operator; we infer it from the roster
// (single hybrid → "hybrid", anything else → "split").
function inferPartyMode(plans: SetupWizardWorkerPlan[]): SetupWizardPartyMode {
  if (plans.length === 1) {
    const role = readPlanArg(plans[0] as SetupWizardWorkerPlan, "--role");
    if (role === "hybrid") {
      return "hybrid";
    }
  }
  return "split";
}

export async function runSetupWizard(
  context: SetupWizardPromptContext,
): Promise<SetupWizardResult> {
  const progress: WizardProgress = { workers: [] };
  let defaults = context.defaults;

  // Page 1: Harness multiselect
  page(progress, "Harnesses");
  const harnesses = await promptHarnesses(defaults);
  progress.harnesses = harnesses;
  if (context.loadHarnessDefaults) {
    const harnessesNeedingDefaults = harnesses.filter(
      (harness) => harness !== "standalone" && !defaultsForHarness(defaults, harness).importSummary,
    );
    if (harnessesNeedingDefaults.length > 0) {
      const loadedDefaults = await withSpinner("Checking selected harness credentials...", () =>
        context.loadHarnessDefaults?.(harnessesNeedingDefaults),
      );
      defaults = mergeHarnessDefaults(defaults, loadedDefaults ?? {});
    }
  }

  // Page 2..N: Per-harness import confirm
  const importedArgsByHarness = await promptHarnessImports(harnesses, defaults, progress);

  // Page N+1..M: Worker registration loop, per harness
  const workerPlans: SetupWizardWorkerPlan[] = [];
  for (const harness of harnesses) {
    const importedArgs = importedArgsByHarness.get(harness) ?? [];
    workerPlans.push(...(await promptWorkersForHarness(harness, defaults, importedArgs, progress)));
  }

  // Page M+1: Observability sink
  const sinkPlan = await promptSinkPlan(defaults, progress);

  // Page M+2: Training Grounds
  page(progress, "Training Grounds");
  const runCalibration = await askConfirm(
    "Send new party members to the Training Grounds now?",
    true,
  );
  progress.trainingGrounds = runCalibration ? "yes" : "no";

  const result: SetupWizardResult = {
    calibrateWorkerIds: runCalibration ? deriveCalibrationIds(workerPlans) : [],
    settingsUpdate: {
      planner: {
        // Trial routing prompt was dropped — operators rarely have multiple testers and the
        // default 'balanced' is a safe choice for the common case. Power users can override
        // post-setup via `quest settings set planner.testerSelectionStrategy prefer-cheapest`.
        testerSelectionStrategy: defaults.testerSelectionStrategy,
      },
    },
    sinkPlan,
    workerPlans,
  };
  // `partyMode` returned to callers solely for back-compat; cli.ts no longer consumes it but
  // older builds + the on-disk settings schema still reference it. Inferred from the roster.
  void inferPartyMode(workerPlans);

  process.stdout.write("\u001B[2J\u001B[H");
  process.stdout.write(renderQuestBannerBlock(72, true));
  intro("Setup complete");
  note(renderSummaryNote(result), "Setup Summary");
  outro("Party ready. Run `quest party dispatch` when you're good to go.");
  return result;
}
