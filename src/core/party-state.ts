import { z } from "zod";
import { QuestDomainError } from "./errors";
import {
  readJsonFileOrDefault,
  resolveQuestPartyStatePath,
  writeJsonFileAtomically,
} from "./storage";

const isoDateStringSchema = z.string().datetime({ offset: true });

export const questPartyEventSchema = z
  .object({
    at: isoDateStringSchema,
    reason: z.string().trim().min(1).max(400).optional(),
    type: z.enum(["party_bonfire_lit", "party_resumed"]),
  })
  .strict();

export const questPartyStateSchema = z
  .object({
    events: z.array(questPartyEventSchema).default([]),
    reason: z.string().trim().min(1).max(400).optional(),
    status: z.enum(["active", "resting"]).default("active"),
    updatedAt: isoDateStringSchema,
    version: z.literal(1),
  })
  .strict();

export type QuestPartyState = z.infer<typeof questPartyStateSchema>;

const defaultQuestPartyState = (): QuestPartyState =>
  questPartyStateSchema.parse({
    updatedAt: new Date().toISOString(),
    version: 1,
  });

export class QuestPartyStateStore {
  constructor(private readonly partyStatePath: string = resolveQuestPartyStatePath()) {}

  async readState(): Promise<QuestPartyState> {
    const raw = await readJsonFileOrDefault<QuestPartyState | null>(this.partyStatePath, null, {
      invalidJsonCode: "invalid_quest_party_state",
      invalidJsonMessage: `Invalid JSON in quest party state file: ${this.partyStatePath}`,
    });
    if (raw === null) {
      return defaultQuestPartyState();
    }

    const parsed = questPartyStateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new QuestDomainError({
        code: "invalid_quest_party_state",
        details: parsed.error.flatten(),
        message: `Quest party state file ${this.partyStatePath} is invalid`,
        statusCode: 1,
      });
    }

    return parsed.data;
  }

  async lightBonfire(reason?: string | undefined): Promise<QuestPartyState> {
    const current = await this.readState();
    const updatedAt = new Date().toISOString();
    const next = questPartyStateSchema.parse({
      ...current,
      events: [
        ...current.events,
        ...(current.status === "resting" && current.reason === reason
          ? []
          : [
              {
                at: updatedAt,
                ...(reason ? { reason } : {}),
                type: "party_bonfire_lit" as const,
              },
            ]),
      ],
      ...(reason ? { reason } : {}),
      status: "resting",
      updatedAt,
      version: 1,
    });
    if (!reason) {
      delete next.reason;
    }
    await writeJsonFileAtomically(this.partyStatePath, next);
    return next;
  }

  async resumeParty(): Promise<QuestPartyState> {
    const current = await this.readState();
    const updatedAt = new Date().toISOString();
    const next = questPartyStateSchema.parse({
      ...current,
      events: [
        ...current.events,
        ...(current.status === "active"
          ? []
          : [
              {
                at: updatedAt,
                type: "party_resumed" as const,
              },
            ]),
      ],
      status: "active",
      updatedAt,
      version: 1,
    });
    delete next.reason;
    await writeJsonFileAtomically(this.partyStatePath, next);
    return next;
  }

  async requireDispatchAllowed(): Promise<void> {
    const state = await this.readState();
    if (state.status !== "resting") {
      return;
    }

    throw new QuestDomainError({
      code: "quest_party_resting",
      details: {
        reason: state.reason ?? null,
        updatedAt: state.updatedAt,
      },
      message: state.reason
        ? `The party rests at a bonfire: ${state.reason}`
        : "The party rests at a bonfire",
      statusCode: 1,
    });
  }
}
