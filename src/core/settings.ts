import { z } from "zod";
import { QuestDomainError } from "./errors";
import {
  readJsonFileOrDefault,
  resolveQuestSettingsPath,
  writeJsonFileAtomically,
} from "./storage";

export const testerSelectionStrategySchema = z.enum(["balanced", "prefer-cheapest"]);
export type TesterSelectionStrategy = z.infer<typeof testerSelectionStrategySchema>;

export const questSettingsSchema = z
  .object({
    maintenance: z
      .object({
        workspaceWarningBytes: z
          .number()
          .int()
          .min(1)
          .default(2 * 1024 * 1024 * 1024),
      })
      .default({ workspaceWarningBytes: 2 * 1024 * 1024 * 1024 }),
    planner: z
      .object({
        testerSelectionStrategy: testerSelectionStrategySchema.default("balanced"),
      })
      .default({ testerSelectionStrategy: "balanced" }),
    version: z.literal(1),
  })
  .strict();

export type QuestSettings = z.infer<typeof questSettingsSchema>;

const defaultQuestSettings = questSettingsSchema.parse({ version: 1 });

export class QuestSettingsStore {
  constructor(private readonly settingsPath: string = resolveQuestSettingsPath()) {}

  async readSettings(): Promise<QuestSettings> {
    const raw = await readJsonFileOrDefault<QuestSettings | null>(this.settingsPath, null, {
      invalidJsonCode: "invalid_quest_settings",
      invalidJsonMessage: `Invalid JSON in quest settings file: ${this.settingsPath}`,
    });
    if (raw === null) {
      return defaultQuestSettings;
    }

    const parsed = questSettingsSchema.safeParse(raw);
    if (!parsed.success) {
      throw new QuestDomainError({
        code: "invalid_quest_settings",
        details: parsed.error.flatten(),
        message: `Quest settings file ${this.settingsPath} is invalid`,
        statusCode: 1,
      });
    }

    return parsed.data;
  }

  async writeSettings(input: Partial<QuestSettings>): Promise<QuestSettings> {
    const current = await this.readSettings();
    const parsed = questSettingsSchema.parse({
      ...current,
      ...input,
      maintenance: {
        ...current.maintenance,
        ...(input.maintenance ?? {}),
      },
      planner: {
        ...current.planner,
        ...(input.planner ?? {}),
      },
      version: 1,
    });
    await writeJsonFileAtomically(this.settingsPath, parsed);
    return parsed;
  }
}
