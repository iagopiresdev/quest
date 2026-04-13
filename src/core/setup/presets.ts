import type { WorkerUpdate } from "../workers/management";
import type { WorkerRole } from "../workers/schema";

export type SetupWizardPartyMode = "hybrid" | "split";

export type SetupWizardArchetypeId =
  | "battle-engineer"
  | "field-researcher"
  | "trial-judge"
  | "boss-hunter"
  | "adventurer"
  | "solo-operator";

export type SetupWizardArchetype = {
  description: string;
  id: SetupWizardArchetypeId;
  label: string;
  role: WorkerRole;
  update: WorkerUpdate;
};

const archetypes: SetupWizardArchetype[] = [
  {
    description: "Strong coding, good merge safety, suited for narrow implementation slices.",
    id: "battle-engineer",
    label: "Battle Engineer",
    role: "builder",
    update: {
      role: "builder",
      stats: {
        coding: 90,
        contextEndurance: 62,
        docs: 38,
        mergeSafety: 84,
        research: 42,
        speed: 68,
        testing: 72,
      },
      title: "Battle Engineer",
      workerClass: "engineer",
    },
  },
  {
    description: "Better research/docs balance for exploratory or migration-heavy encounters.",
    id: "field-researcher",
    label: "Field Researcher",
    role: "builder",
    update: {
      role: "builder",
      stats: {
        coding: 78,
        contextEndurance: 74,
        docs: 64,
        mergeSafety: 74,
        research: 82,
        speed: 52,
        testing: 68,
      },
      title: "Field Researcher",
      workerClass: "researcher",
    },
  },
  {
    description: "High testing and merge-safety bias for strict trial ownership.",
    id: "trial-judge",
    label: "Trial Judge",
    role: "tester",
    update: {
      role: "tester",
      stats: {
        coding: 58,
        contextEndurance: 68,
        docs: 46,
        mergeSafety: 92,
        research: 54,
        speed: 50,
        testing: 94,
      },
      title: "Trial Judge",
      workerClass: "tester",
    },
  },
  {
    description: "Conservative tester archetype for hot files and integration-sensitive quests.",
    id: "boss-hunter",
    label: "Boss Hunter",
    role: "tester",
    update: {
      role: "tester",
      stats: {
        coding: 52,
        contextEndurance: 72,
        docs: 40,
        mergeSafety: 96,
        research: 50,
        speed: 46,
        testing: 90,
      },
      title: "Boss Hunter",
      workerClass: "warden",
    },
  },
  {
    description: "Balanced hybrid for small repos or single-worker setups.",
    id: "adventurer",
    label: "Adventurer",
    role: "hybrid",
    update: {
      role: "hybrid",
      stats: {
        coding: 82,
        contextEndurance: 70,
        docs: 48,
        mergeSafety: 80,
        research: 54,
        speed: 60,
        testing: 78,
      },
      title: "Adventurer",
      workerClass: "hybrid",
    },
  },
  {
    description: "High-endurance hybrid for longer quests with one party member.",
    id: "solo-operator",
    label: "Solo Operator",
    role: "hybrid",
    update: {
      role: "hybrid",
      stats: {
        coding: 80,
        contextEndurance: 86,
        docs: 44,
        mergeSafety: 82,
        research: 58,
        speed: 54,
        testing: 80,
      },
      title: "Solo Operator",
      workerClass: "operator",
    },
  },
];

export function listSetupArchetypesForRole(role: WorkerRole): SetupWizardArchetype[] {
  if (role === "hybrid") {
    return archetypes.filter((archetype) => archetype.role === "hybrid");
  }

  return archetypes.filter((archetype) => archetype.role === role);
}

export function getSetupArchetype(id: SetupWizardArchetypeId): SetupWizardArchetype {
  const archetype = archetypes.find((candidate) => candidate.id === id);
  if (!archetype) {
    throw new Error(`Unknown setup archetype: ${id}`);
  }

  return archetype;
}

export function defaultSetupArchetype(role: WorkerRole): SetupWizardArchetype {
  return listSetupArchetypesForRole(role)[0] ?? getSetupArchetype("adventurer");
}
