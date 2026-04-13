import { z } from "zod";
import { parseOpenClawJsonOutput } from "../runs/adapters/openclaw-shared";
import { runSubprocess } from "../runs/process";
import { buildProcessEnv } from "../runs/process-env";

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
  const versionResult = await runSubprocess({
    cmd: [executable, "--version"],
    cwd: Bun.env.PWD ?? ".",
    env: buildProcessEnv(),
    timeoutMs: 30_000,
  });
  const loginResult = await runSubprocess({
    cmd: [executable, "login", "status"],
    cwd: Bun.env.PWD ?? ".",
    env: buildProcessEnv(),
    timeoutMs: 30_000,
  });

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
  const statusResult = await runSubprocess({
    cmd: [executable, "status", "--json"],
    cwd: Bun.env.PWD ?? ".",
    env,
    timeoutMs: 30_000,
  });
  const agentsListResult = await runSubprocess({
    cmd: [executable, "agents", "list", "--json"],
    cwd: Bun.env.PWD ?? ".",
    env,
    timeoutMs: 30_000,
  });

  const statusPayload =
    statusResult.exitCode === 0
      ? (parseOpenClawJsonOutput(statusResult.stdout, statusResult.stderr) as {
          gateway?: { reachable?: boolean; url?: string };
        })
      : null;
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
    ok: statusResult.exitCode === 0 && statusPayload?.gateway?.reachable === true,
    profile: selectedAgent?.model ?? (selectedAgent ? `openclaw/${selectedAgent.id}` : null),
  };
}
