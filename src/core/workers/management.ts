import type { WorkerRuntimeConfig } from "./runtime";
import { type RegisteredWorker, registeredWorkerSchema } from "./schema";

export type WorkerUpdate = {
  approach?: string;
  backend?: {
    agentId?: string;
    baseUrl?: string;
    executable?: string;
    gatewayUrl?: string;
    local?: boolean;
    profile?: string;
    runtime?: WorkerRuntimeConfig;
    sessionId?: string;
    toolAllow?: string[];
    toolDeny?: string[];
  };
  enabled?: boolean;
  name?: string;
  personaPrompt?: string;
  resources?: Partial<RegisteredWorker["resources"]>;
  stats?: Partial<RegisteredWorker["stats"]>;
  tags?: string[];
  title?: string;
  trustRating?: number;
  voice?: string;
  workerClass?: string;
  xp?: number;
  level?: number;
};

export type WorkerStrength = {
  key: keyof RegisteredWorker["stats"];
  score: number;
};

export function topWorkerStrengths(worker: RegisteredWorker, limit = 3): WorkerStrength[] {
  return (Object.entries(worker.stats) as Array<[keyof RegisteredWorker["stats"], number]>)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([key, score]) => ({ key, score }));
}

export function getLatestCalibration(worker: RegisteredWorker) {
  return worker.calibration.history.at(-1) ?? null;
}

export function applyWorkerUpdate(
  worker: RegisteredWorker,
  update: WorkerUpdate,
): RegisteredWorker {
  const nextWorker: RegisteredWorker = {
    ...worker,
    backend: {
      ...worker.backend,
      ...(update.backend?.agentId ? { agentId: update.backend.agentId } : {}),
      ...(update.backend?.baseUrl ? { baseUrl: update.backend.baseUrl } : {}),
      ...(update.backend?.executable ? { executable: update.backend.executable } : {}),
      ...(update.backend?.gatewayUrl ? { gatewayUrl: update.backend.gatewayUrl } : {}),
      ...(update.backend?.local !== undefined ? { local: update.backend.local } : {}),
      ...(update.backend?.profile ? { profile: update.backend.profile } : {}),
      ...(update.backend?.runtime ? { runtime: update.backend.runtime } : {}),
      ...(update.backend?.sessionId ? { sessionId: update.backend.sessionId } : {}),
      ...(update.backend?.toolAllow || update.backend?.toolDeny
        ? {
            toolPolicy: {
              allow: update.backend.toolAllow ?? worker.backend.toolPolicy.allow,
              deny: update.backend.toolDeny ?? worker.backend.toolPolicy.deny,
            },
          }
        : {}),
    },
    ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
    ...(update.name ? { name: update.name } : {}),
    persona: {
      ...worker.persona,
      ...(update.approach ? { approach: update.approach } : {}),
      ...(update.personaPrompt ? { prompt: update.personaPrompt } : {}),
      ...(update.voice ? { voice: update.voice } : {}),
    },
    progression: {
      ...worker.progression,
      ...(update.level !== undefined ? { level: update.level } : {}),
      ...(update.xp !== undefined ? { xp: update.xp } : {}),
    },
    resources: {
      ...worker.resources,
      ...update.resources,
    },
    stats: {
      ...worker.stats,
      ...update.stats,
    },
    ...(update.tags ? { tags: update.tags } : {}),
    ...(update.title ? { title: update.title } : {}),
    trust: {
      ...worker.trust,
      ...(update.trustRating !== undefined ? { rating: update.trustRating } : {}),
    },
    ...(update.workerClass ? { class: update.workerClass } : {}),
  };

  return registeredWorkerSchema.parse(nextWorker);
}
