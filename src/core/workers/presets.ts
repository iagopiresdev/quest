import type { WorkerRuntimeConfig } from "./runtime";
import type { RegisteredWorker } from "./schema";

export type CodexWorkerPresetInput = {
  approach?: string | undefined;
  auth:
    | {
        mode: "env-var";
        envVar: string;
        targetEnvVar: string;
      }
    | {
        mode: "native-login";
        targetEnvVar: string;
      }
    | {
        mode: "secret-store";
        secretRef: string;
        targetEnvVar: string;
      };
  executable?: string | undefined;
  id?: string | undefined;
  name?: string | undefined;
  profile?: string | undefined;
  prompt?: string | undefined;
  runtime?: WorkerRuntimeConfig | undefined;
  tags?: string[] | undefined;
  title?: string | undefined;
  toolAllow?: string[] | undefined;
  toolDeny?: string[] | undefined;
  voice?: string | undefined;
  workerClass?: string | undefined;
};

export type HermesWorkerPresetInput = {
  approach?: string | undefined;
  auth?:
    | {
        mode: "env-var";
        envVar: string;
        targetEnvVar: string;
      }
    | {
        mode: "secret-store";
        secretRef: string;
        targetEnvVar: string;
      };
  baseUrl: string;
  id?: string | undefined;
  name?: string | undefined;
  profile?: string | undefined;
  prompt?: string | undefined;
  runtime?: WorkerRuntimeConfig | undefined;
  title?: string | undefined;
  voice?: string | undefined;
  workerClass?: string | undefined;
};

export type OpenClawWorkerPresetInput = {
  agentId?: string | undefined;
  approach?: string | undefined;
  auth?:
    | {
        mode: "env-var";
        envVar: string;
        targetEnvVar: string;
      }
    | {
        mode: "secret-store";
        secretRef: string;
        targetEnvVar: string;
      };
  executable?: string | undefined;
  gatewayUrl?: string | undefined;
  id?: string | undefined;
  local?: boolean | undefined;
  name?: string | undefined;
  profile?: string | undefined;
  prompt?: string | undefined;
  runtime?: WorkerRuntimeConfig | undefined;
  sessionId?: string | undefined;
  tags?: string[] | undefined;
  title?: string | undefined;
  voice?: string | undefined;
  workerClass?: string | undefined;
};

export function slugifyWorkerId(value: string, fallback = "worker"): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : fallback;
}

export function createCodexWorkerPreset(input: CodexWorkerPresetInput): RegisteredWorker {
  const name = input.name ?? "Codex Worker";
  return {
    backend: {
      adapter: "codex-cli",
      auth: input.auth,
      executable: input.executable,
      profile: input.profile ?? "gpt-5.4",
      ...(input.runtime ? { runtime: input.runtime } : {}),
      runner: "codex",
      toolPolicy: {
        allow: input.toolAllow ?? [],
        deny: input.toolDeny ?? [],
      },
    },
    calibration: {
      history: [],
    },
    class: input.workerClass ?? "engineer",
    enabled: true,
    id: input.id ?? slugifyWorkerId(name, "codex-worker"),
    name,
    persona: {
      approach: input.approach ?? "finish the change with minimal churn",
      prompt: input.prompt ?? "Keep diffs narrow and state residual risks briefly.",
      voice: input.voice ?? "terse",
    },
    progression: { level: 1, xp: 0 },
    resources: { cpuCost: 1, gpuCost: 0, maxParallel: 1, memoryCost: 1 },
    stats: {
      coding: 85,
      contextEndurance: 60,
      docs: 40,
      mergeSafety: 80,
      research: 40,
      speed: 60,
      testing: 70,
    },
    tags: input.tags && input.tags.length > 0 ? input.tags : ["codex"],
    title: input.title ?? "Battle Engineer",
    trust: { calibratedAt: new Date().toISOString(), rating: 0.8 },
  };
}

export function createHermesWorkerPreset(input: HermesWorkerPresetInput): RegisteredWorker {
  const name = input.name ?? "Hermes Worker";
  return {
    backend: {
      adapter: "hermes-api",
      auth: input.auth,
      baseUrl: input.baseUrl,
      profile: input.profile ?? "hermes",
      ...(input.runtime ? { runtime: input.runtime } : {}),
      runner: "hermes",
      toolPolicy: {
        allow: [],
        deny: [],
      },
    },
    calibration: {
      history: [],
    },
    class: input.workerClass ?? "sage",
    enabled: true,
    id: input.id ?? slugifyWorkerId(name, "hermes-worker"),
    name,
    persona: {
      approach: input.approach ?? "analyze carefully and return precise file updates",
      prompt: input.prompt ?? "Return only the exact file updates needed for the slice.",
      voice: input.voice ?? "precise",
    },
    progression: { level: 1, xp: 0 },
    resources: { cpuCost: 1, gpuCost: 1, maxParallel: 1, memoryCost: 2 },
    stats: {
      coding: 78,
      contextEndurance: 62,
      docs: 35,
      mergeSafety: 72,
      research: 48,
      speed: 55,
      testing: 82,
    },
    tags: ["hermes"],
    title: input.title ?? "Arcane Engineer",
    trust: { calibratedAt: new Date().toISOString(), rating: 0.75 },
  };
}

export function createOpenClawWorkerPreset(input: OpenClawWorkerPresetInput): RegisteredWorker {
  const name = input.name ?? "OpenClaw Worker";
  const agentId = input.agentId ?? "main";
  return {
    backend: {
      adapter: "openclaw-cli",
      ...(input.auth ? { auth: input.auth } : {}),
      agentId,
      ...(input.executable ? { executable: input.executable } : {}),
      ...(input.gatewayUrl ? { gatewayUrl: input.gatewayUrl } : {}),
      ...(input.local !== undefined ? { local: input.local } : {}),
      profile: input.profile ?? `openclaw/${agentId}`,
      ...(input.runtime ? { runtime: input.runtime } : {}),
      runner: "openclaw",
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      toolPolicy: {
        allow: [],
        deny: [],
      },
    },
    calibration: {
      history: [],
    },
    class: input.workerClass ?? "captain",
    enabled: true,
    id: input.id ?? slugifyWorkerId(name, "openclaw-worker"),
    name,
    persona: {
      approach:
        input.approach ?? "route the work through the configured OpenClaw agent with minimal churn",
      prompt: input.prompt ?? "Use the configured OpenClaw agent and keep the final report terse.",
      voice: input.voice ?? "steady",
    },
    progression: { level: 1, xp: 0 },
    resources: { cpuCost: 1, gpuCost: 0, maxParallel: 1, memoryCost: 1 },
    stats: {
      coding: 82,
      contextEndurance: 78,
      docs: 52,
      mergeSafety: 80,
      research: 58,
      speed: 54,
      testing: 70,
    },
    tags: input.tags && input.tags.length > 0 ? input.tags : ["openclaw"],
    title: input.title ?? "Guild Operator",
    trust: { calibratedAt: new Date().toISOString(), rating: 0.78 },
  };
}
