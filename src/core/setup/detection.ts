import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { QuestDomainError } from "../errors";
import {
  assertOpenClawResponseSucceeded,
  parseOpenClawJsonOutput,
} from "../runs/adapters/openclaw-shared";
import { runSubprocess } from "../runs/process";
import { buildProcessEnv } from "../runs/process-env";

function resolveHomeDirectory(): string {
  // Prefer the HOME env var so tests can point detection at a throwaway directory. Production
  // code-paths still fall back to `os.homedir()` when HOME is unset.
  return Bun.env.HOME?.trim() || homedir();
}

const hermesModelsResponseSchema = z.union([
  z.object({
    data: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
          })
          .strict(),
      )
      .default([]),
  }),
  z.array(
    z
      .object({
        id: z.string().trim().min(1),
      })
      .strict(),
  ),
]);

const openClawAgentsResponseSchema = z.array(
  z
    .object({
      id: z.string().trim().min(1),
      model: z.string().trim().min(1).nullable().optional(),
      workspace: z.string().trim().min(1).optional(),
    })
    .passthrough(),
);

export type DetectedCodexSetup = {
  authMode: "env-var" | "native-login";
  envVar?: string;
  executable: string;
  loginOk: boolean;
  version: string | null;
};

export type DetectedHermesSetup = {
  baseUrl: string;
  models: string[];
  ok: boolean;
  profile: string | null;
};

export type DetectedOpenClawAgent = {
  id: string;
  model: string | null;
};

export type DetectedOpenClawSetup = {
  agentId: string | null;
  agents: DetectedOpenClawAgent[];
  executable: string;
  gatewayReachable: boolean;
  gatewayUrl: string | null;
  ok: boolean;
  profile: string | null;
};

export type OpenClawModelProbeResult = {
  agentId: string;
  model: string;
};

export type DetectedSinkSetup = {
  linearApiKeyEnv: string | null;
  // When the local OpenClaw config exposes a Telegram bot token, command-first setup can import it
  // into the quest secret store so operators avoid double-configuring the same credential.
  openClawTelegramBotToken: string | null;
  openClawTelegramChatId: string | null;
  slackWebhookEnv: string | null;
  telegramBotTokenEnv: string | null;
};

function resolveExecutableCandidate(
  explicit: string | undefined,
  envVar: string | undefined,
  binary: string,
): string {
  const configured = explicit?.trim() || envVar?.trim();
  if (configured) {
    return configured;
  }

  return Bun.which(binary) ?? binary;
}

export async function detectCodexSetup(explicitExecutable?: string): Promise<DetectedCodexSetup> {
  const executable = resolveExecutableCandidate(
    explicitExecutable,
    Bun.env.QUEST_RUNNER_CODEX_EXECUTABLE,
    "codex",
  );
  const [versionResult, loginResult] = await Promise.all([
    runSubprocess({
      cmd: [executable, "--version"],
      cwd: Bun.env.PWD ?? ".",
      env: buildProcessEnv(),
      timeoutMs: 30_000,
    }),
    runSubprocess({
      cmd: [executable, "login", "status"],
      cwd: Bun.env.PWD ?? ".",
      env: buildProcessEnv(),
      timeoutMs: 30_000,
    }),
  ]);

  const openAiEnv = Bun.env.OPENAI_API_KEY?.trim();
  const useEnvVar = loginResult.exitCode !== 0 && !!openAiEnv;
  const authMode: DetectedCodexSetup["authMode"] =
    loginResult.exitCode === 0 || !useEnvVar ? "native-login" : "env-var";
  return {
    ...(useEnvVar ? { envVar: "OPENAI_API_KEY" } : {}),
    authMode,
    executable,
    loginOk: loginResult.exitCode === 0,
    version: versionResult.exitCode === 0 ? versionResult.stdout.trim() || null : null,
  };
}

export async function detectHermesSetup(explicitBaseUrl?: string): Promise<DetectedHermesSetup> {
  const baseUrl =
    explicitBaseUrl?.trim() ||
    Bun.env.QUEST_RUNNER_HERMES_BASE_URL?.trim() ||
    "http://127.0.0.1:8000/v1";
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`);
    const body = await response.json();
    const parsed = hermesModelsResponseSchema.parse(body);
    const models = Array.isArray(parsed)
      ? parsed.map((entry) => entry.id)
      : parsed.data.map((entry) => entry.id);
    return {
      baseUrl,
      models,
      ok: response.ok,
      profile: models[0] ?? null,
    };
  } catch {
    return {
      baseUrl,
      models: [],
      ok: false,
      profile: null,
    };
  }
}

function chooseOpenClawAgent(
  agents: DetectedOpenClawAgent[],
  preferredAgentId?: string,
): DetectedOpenClawAgent | null {
  if (preferredAgentId) {
    return agents.find((agent) => agent.id === preferredAgentId) ?? null;
  }

  // Reuse a purpose-built Codex agent when present so setup imports the better default rather than
  // blindly pinning to a generic main agent that may use a weaker model.
  return agents.find((agent) => agent.id === "codex") ?? agents[0] ?? null;
}

async function runOpenClawStatusWithRetry(
  executable: string,
  env: Record<string, string>,
): Promise<{
  payload: { gateway?: { reachable?: boolean; url?: string } } | null;
  result: Awaited<ReturnType<typeof runSubprocess>>;
}> {
  const delaysMs = [0, 250, 750];
  let lastResult: Awaited<ReturnType<typeof runSubprocess>> | null = null;
  let lastPayload: { gateway?: { reachable?: boolean; url?: string } } | null = null;

  for (const delayMs of delaysMs) {
    if (delayMs > 0) {
      await Bun.sleep(delayMs);
    }

    const result = await runSubprocess({
      cmd: [executable, "status", "--json"],
      cwd: Bun.env.PWD ?? ".",
      env,
      timeoutMs: 30_000,
    });
    lastResult = result;
    lastPayload =
      result.exitCode === 0
        ? (parseOpenClawJsonOutput(result.stdout, result.stderr) as {
            gateway?: { reachable?: boolean; url?: string };
          })
        : null;

    if (lastPayload?.gateway?.reachable === true) {
      return { payload: lastPayload, result };
    }
  }

  if (!lastResult) {
    throw new QuestDomainError({
      code: "quest_runner_unavailable",
      message: "OpenClaw status could not be checked",
      statusCode: 1,
    });
  }

  return { payload: lastPayload, result: lastResult };
}

export async function detectOpenClawSetup(
  options: { agentId?: string; executable?: string; gatewayUrl?: string } = {},
): Promise<DetectedOpenClawSetup> {
  const executable = resolveExecutableCandidate(
    options.executable,
    Bun.env.QUEST_RUNNER_OPENCLAW_EXECUTABLE,
    "openclaw",
  );
  const env = buildProcessEnv(
    options.gatewayUrl?.trim() ? { OPENCLAW_GATEWAY_URL: options.gatewayUrl.trim() } : undefined,
  );
  const [statusCheck, agentsListResult] = await Promise.all([
    runOpenClawStatusWithRetry(executable, env),
    runSubprocess({
      cmd: [executable, "agents", "list", "--json"],
      cwd: Bun.env.PWD ?? ".",
      env,
      timeoutMs: 30_000,
    }),
  ]);

  const statusPayload = statusCheck.payload;
  const agentsPayload =
    agentsListResult.exitCode === 0
      ? openClawAgentsResponseSchema.parse(
          parseOpenClawJsonOutput(agentsListResult.stdout, agentsListResult.stderr),
        )
      : [];
  const agents = agentsPayload.map((agent) => ({
    id: agent.id,
    model: agent.model ?? null,
  }));
  const selectedAgent = chooseOpenClawAgent(agents, options.agentId);

  return {
    agentId: selectedAgent?.id ?? options.agentId ?? null,
    agents,
    executable,
    gatewayReachable: statusPayload?.gateway?.reachable === true,
    gatewayUrl: options.gatewayUrl?.trim() || statusPayload?.gateway?.url?.trim() || null,
    ok: statusCheck.result.exitCode === 0 && statusPayload?.gateway?.reachable === true,
    profile: selectedAgent?.model ?? (selectedAgent ? `openclaw/${selectedAgent.id}` : null),
  };
}

export async function probeOpenClawModelProfile(options: {
  agentId?: string | null;
  executable?: string | undefined;
  gatewayUrl?: string | null | undefined;
  profile: string;
  stateRoot: string;
}): Promise<OpenClawModelProbeResult | null> {
  const model = options.profile.trim();
  if (model.length === 0 || model.startsWith("openclaw/")) {
    return null;
  }

  const executable = resolveExecutableCandidate(
    options.executable,
    Bun.env.QUEST_RUNNER_OPENCLAW_EXECUTABLE,
    "openclaw",
  );
  const env = buildProcessEnv(
    options.gatewayUrl?.trim() ? { OPENCLAW_GATEWAY_URL: options.gatewayUrl.trim() } : undefined,
  );
  const agentId = `quest-probe-${randomUUID().slice(0, 8)}`;
  const agentDir = join(options.stateRoot, "openclaw-probes", agentId, "agent");
  const addCommand = [
    executable,
    "agents",
    "add",
    agentId,
    "--workspace",
    options.stateRoot,
    "--model",
    model,
    "--agent-dir",
    agentDir,
    "--non-interactive",
    "--json",
  ];

  const addResult = await runSubprocess({
    cmd: addCommand,
    cwd: Bun.env.PWD ?? ".",
    env,
    timeoutMs: 60_000,
  });
  if (addResult.exitCode !== 0) {
    throw new QuestDomainError({
      code: "quest_runner_unavailable",
      details: {
        agentId,
        model,
        stderr: addResult.stderr,
        stdout: addResult.stdout,
      },
      message: `OpenClaw could not create a model probe agent for ${model}`,
      statusCode: 1,
    });
  }

  const probeCommand = [
    executable,
    "agent",
    "--session-id",
    `${agentId}-session`,
    "--agent",
    agentId,
    "--message",
    "Reply with exactly OK.",
    "--json",
  ];
  try {
    const probeResult = await runSubprocess({
      cmd: probeCommand,
      cwd: options.stateRoot,
      env,
      timeoutMs: 120_000,
    });
    if (probeResult.exitCode !== 0) {
      throw new QuestDomainError({
        code: "quest_runner_command_failed",
        details: {
          command: probeCommand,
          exitCode: probeResult.exitCode,
          stderr: probeResult.stderr,
          stdout: probeResult.stdout,
        },
        message: `OpenClaw model probe failed for ${model}`,
        statusCode: 1,
      });
    }

    const responseBody = parseOpenClawJsonOutput(probeResult.stdout, probeResult.stderr);
    assertOpenClawResponseSucceeded(responseBody, {
      command: probeCommand,
      workerId: options.agentId ?? agentId,
    });
    return { agentId, model };
  } finally {
    await runSubprocess({
      cmd: [executable, "agents", "delete", agentId, "--json"],
      cwd: Bun.env.PWD ?? ".",
      env,
      timeoutMs: 30_000,
    });
  }
}

const openClawConfigTelegramSchema = z.object({
  channels: z
    .object({
      telegram: z
        .object({
          allowFrom: z.array(z.union([z.number(), z.string()])).optional(),
          botToken: z.string().trim().min(1).optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
});

async function detectOpenClawTelegramImport(): Promise<{
  botToken: string | null;
  chatId: string | null;
}> {
  const configPath = join(resolveHomeDirectory(), ".openclaw", "openclaw.json");
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = openClawConfigTelegramSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return { botToken: null, chatId: null };
    }
    const telegram = parsed.data.channels?.telegram;
    const botToken = telegram?.botToken?.trim() || null;
    const rawChatId = telegram?.allowFrom?.[0];
    const chatId = rawChatId !== undefined ? String(rawChatId) : null;
    return { botToken, chatId };
  } catch {
    return { botToken: null, chatId: null };
  }
}

export async function detectSinkSetup(): Promise<DetectedSinkSetup> {
  const openClawTelegram = await detectOpenClawTelegramImport();
  return {
    linearApiKeyEnv: Bun.env.LINEAR_API_KEY?.trim() ? "LINEAR_API_KEY" : null,
    openClawTelegramBotToken: openClawTelegram.botToken,
    openClawTelegramChatId: openClawTelegram.chatId,
    slackWebhookEnv: Bun.env.SLACK_WEBHOOK_URL?.trim() ? "SLACK_WEBHOOK_URL" : null,
    telegramBotTokenEnv: Bun.env.TELEGRAM_BOT_TOKEN?.trim() ? "TELEGRAM_BOT_TOKEN" : null,
  };
}
