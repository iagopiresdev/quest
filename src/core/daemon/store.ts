import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { QuestDomainError } from "../errors";
import {
  ensureDirectory,
  readJsonFileOrDefault,
  resolveQuestStateRoot,
  writeJsonFileAtomically,
} from "../storage";
import {
  defaultQuestDaemonConfig,
  defaultQuestDaemonState,
  type QuestDaemonConfig,
  type QuestDaemonProcess,
  type QuestDaemonState,
  type QuestParty,
  questDaemonConfigSchema,
  questDaemonStateSchema,
  questPartySchema,
} from "./schema";

export type QuestPartyDirectories = {
  done: string;
  failed: string;
  inbox: string;
  partyRoot: string;
  running: string;
};

function compareParties(left: QuestParty, right: QuestParty): number {
  return left.name.localeCompare(right.name);
}

export class QuestDaemonStore {
  private readonly configPath: string;
  private readonly partiesRoot: string;
  private readonly statePath: string;

  constructor(private readonly stateRoot: string = resolveQuestStateRoot()) {
    this.partiesRoot = join(this.stateRoot, "parties");
    this.statePath = join(this.stateRoot, "daemon-state.json");
    this.configPath = join(this.stateRoot, "daemon-config.json");
  }

  getStateRoot(): string {
    return this.stateRoot;
  }

  getStatePath(): string {
    return this.statePath;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getPartiesRoot(): string {
    return this.partiesRoot;
  }

  resolvePartyDirectories(name: string): QuestPartyDirectories {
    const partyRoot = join(this.partiesRoot, name);
    return {
      done: join(partyRoot, "done"),
      failed: join(partyRoot, "failed"),
      inbox: join(partyRoot, "inbox"),
      partyRoot,
      running: join(partyRoot, "running"),
    };
  }

  async ensurePartyDirectories(name: string): Promise<QuestPartyDirectories> {
    const paths = this.resolvePartyDirectories(name);
    await Promise.all([
      ensureDirectory(this.partiesRoot),
      ensureDirectory(paths.partyRoot),
      ensureDirectory(paths.inbox),
      ensureDirectory(paths.running),
      ensureDirectory(paths.done),
      ensureDirectory(paths.failed),
    ]);
    return paths;
  }

  async readState(): Promise<QuestDaemonState> {
    const raw = await readJsonFileOrDefault<QuestDaemonState | null>(this.statePath, null, {
      invalidJsonCode: "invalid_quest_daemon_state",
      invalidJsonMessage: `Invalid JSON in quest daemon state file: ${this.statePath}`,
    });
    if (raw === null) {
      return defaultQuestDaemonState();
    }

    const parsed = questDaemonStateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new QuestDomainError({
        code: "invalid_quest_daemon_state",
        details: parsed.error.flatten(),
        message: `Quest daemon state file ${this.statePath} is invalid`,
        statusCode: 1,
      });
    }

    return parsed.data;
  }

  async writeState(state: QuestDaemonState): Promise<QuestDaemonState> {
    const parsed = questDaemonStateSchema.parse({
      ...state,
      parties: [...state.parties].sort(compareParties),
      version: 1,
    });
    await ensureDirectory(this.stateRoot);
    await writeJsonFileAtomically(this.statePath, parsed);
    return parsed;
  }

  async readConfig(): Promise<QuestDaemonConfig> {
    const raw = await readJsonFileOrDefault<QuestDaemonConfig | null>(this.configPath, null, {
      invalidJsonCode: "invalid_quest_daemon_config",
      invalidJsonMessage: `Invalid JSON in quest daemon config file: ${this.configPath}`,
    });
    if (raw === null) {
      return defaultQuestDaemonConfig();
    }

    const parsed = questDaemonConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new QuestDomainError({
        code: "invalid_quest_daemon_config",
        details: parsed.error.flatten(),
        message: `Quest daemon config file ${this.configPath} is invalid`,
        statusCode: 1,
      });
    }

    return parsed.data;
  }

  async writeConfig(input: Partial<QuestDaemonConfig>): Promise<QuestDaemonConfig> {
    const current = await this.readConfig();
    const parsed = questDaemonConfigSchema.parse({
      ...current,
      ...input,
    });
    await ensureDirectory(this.stateRoot);
    await writeJsonFileAtomically(this.configPath, parsed);
    return parsed;
  }

  async listParties(): Promise<QuestParty[]> {
    return (await this.readState()).parties;
  }

  async getParty(name: string): Promise<QuestParty> {
    const party = (await this.readState()).parties.find((candidate) => candidate.name === name);
    if (!party) {
      throw new QuestDomainError({
        code: "quest_daemon_party_not_found",
        details: { name },
        message: `Quest daemon party ${name} was not found`,
        statusCode: 1,
      });
    }

    return party;
  }

  async createParty(party: QuestParty): Promise<QuestParty> {
    const parsedParty = questPartySchema.parse(party);
    const state = await this.readState();
    if (state.parties.some((candidate) => candidate.name === parsedParty.name)) {
      throw new QuestDomainError({
        code: "quest_daemon_party_exists",
        details: { name: parsedParty.name },
        message: `Quest daemon party ${parsedParty.name} already exists`,
        statusCode: 1,
      });
    }

    await this.ensurePartyDirectories(parsedParty.name);
    state.parties = [...state.parties, parsedParty].sort(compareParties);
    state.activeRunIds[parsedParty.name] ??= [];
    state.completedSpecTimestamps[parsedParty.name] ??= [];
    state.lastErrorByParty[parsedParty.name] ??= null;
    await this.writeState(state);
    return parsedParty;
  }

  async removeParty(name: string): Promise<QuestParty> {
    const state = await this.readState();
    const party = state.parties.find((candidate) => candidate.name === name);
    if (!party) {
      throw new QuestDomainError({
        code: "quest_daemon_party_not_found",
        details: { name },
        message: `Quest daemon party ${name} was not found`,
        statusCode: 1,
      });
    }

    state.parties = state.parties.filter((candidate) => candidate.name !== name);
    delete state.activeRunIds[name];
    delete state.completedSpecTimestamps[name];
    delete state.cooldownUntil[name];
    delete state.lastErrorByParty[name];
    delete state.partyRestReasons[name];
    await this.writeState(state);
    return party;
  }

  async restParty(name: string, reason?: string | undefined): Promise<QuestParty> {
    const state = await this.readState();
    const party = state.parties.find((candidate) => candidate.name === name);
    if (!party) {
      throw new QuestDomainError({
        code: "quest_daemon_party_not_found",
        details: { name },
        message: `Quest daemon party ${name} was not found`,
        statusCode: 1,
      });
    }

    if (reason?.trim()) {
      state.partyRestReasons[name] = reason.trim();
    } else {
      delete state.partyRestReasons[name];
    }
    await this.writeState(state);
    return party;
  }

  async resumeParty(name: string): Promise<QuestParty> {
    const state = await this.readState();
    const party = state.parties.find((candidate) => candidate.name === name);
    if (!party) {
      throw new QuestDomainError({
        code: "quest_daemon_party_not_found",
        details: { name },
        message: `Quest daemon party ${name} was not found`,
        statusCode: 1,
      });
    }

    delete state.partyRestReasons[name];
    await this.writeState(state);
    return party;
  }

  async updateProcess(processState: QuestDaemonProcess | null): Promise<QuestDaemonState> {
    const state = await this.readState();
    if (processState) {
      state.process = processState;
    } else {
      delete state.process;
    }
    return await this.writeState(state);
  }

  async requestStop(): Promise<QuestDaemonState> {
    const state = await this.readState();
    if (!state.process) {
      throw new QuestDomainError({
        code: "quest_daemon_not_running",
        message: "Quest daemon is not running",
        statusCode: 1,
      });
    }

    state.process = {
      ...state.process,
      stopRequested: true,
    };
    return await this.writeState(state);
  }

  async listQueueDepths(name: string): Promise<Record<keyof QuestPartyDirectories, number> | null> {
    const fileCounts = async (path: string): Promise<number> => {
      try {
        return (await readdir(path)).filter((entry) => !entry.startsWith(".")).length;
      } catch {
        return 0;
      }
    };

    const directories = this.resolvePartyDirectories(name);
    return {
      done: await fileCounts(directories.done),
      failed: await fileCounts(directories.failed),
      inbox: await fileCounts(directories.inbox),
      partyRoot: 0,
      running: await fileCounts(directories.running),
    };
  }
}
