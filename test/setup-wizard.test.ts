import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";

const USE_INITIAL = Symbol("use initial text value");

type PromptAnswers = {
  confirmAnswers: boolean[];
  multiselectAnswers: string[][];
  selectAnswers: string[];
  textAnswers: Array<string | typeof USE_INITIAL>;
};

const promptAnswers = new AsyncLocalStorage<PromptAnswers>();
const originalStdoutWrite = process.stdout.write.bind(process.stdout);

function currentAnswers(): PromptAnswers {
  const answers = promptAnswers.getStore();
  if (!answers) throw new Error("Missing prompt answer state");
  return answers;
}

function takeAnswer<T>(answers: T[], kind: string): T {
  const answer = answers.shift();
  if (answer === undefined) throw new Error(`Missing ${kind} answer`);
  return answer;
}

mock.module("@clack/prompts", () => ({
  cancel: mock(() => {}),
  confirm: mock(async () => takeAnswer(currentAnswers().confirmAnswers, "confirm")),
  intro: mock(() => {}),
  isCancel: mock(() => false),
  multiselect: mock(async () => takeAnswer(currentAnswers().multiselectAnswers, "multiselect")),
  note: mock(() => {}),
  outro: mock(() => {}),
  select: mock(async () => takeAnswer(currentAnswers().selectAnswers, "select")),
  text: mock(async (options: { initialValue?: string }) => {
    const answer = takeAnswer(currentAnswers().textAnswers, "text");
    return answer === USE_INITIAL ? (options.initialValue ?? "") : answer;
  }),
}));

const { runSetupWizard } = await import("../src/core/setup/wizard");

function runWizardWithAnswers(
  answers: PromptAnswers,
  context: Parameters<typeof runSetupWizard>[0],
) {
  return promptAnswers.run(
    {
      confirmAnswers: [...answers.confirmAnswers],
      multiselectAnswers: answers.multiselectAnswers.map((answer) => [...answer]),
      selectAnswers: [...answers.selectAnswers],
      textAnswers: [...answers.textAnswers],
    },
    () => runSetupWizard(context),
  );
}

function optionValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

beforeEach(() => {
  process.stdout.write = (() => true) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
});

test("setup wizard loops back to the model list for repeated worker registration", async () => {
  const result = await runWizardWithAnswers(
    {
      confirmAnswers: [true, true],
      multiselectAnswers: [["codex"]],
      selectAnswers: [
        "gpt-5.4",
        "builder",
        "battle-engineer",
        "gpt-5.4-mini",
        "tester",
        "trial-judge",
        "__done_codex__",
        "none",
      ],
      textAnswers: [USE_INITIAL, USE_INITIAL],
    },
    {
      defaults: {
        backend: "codex",
        harnessDefaults: {
          codex: {
            authMode: "native-login",
            importSummary: "Codex login active via codex",
          },
        },
        testerSelectionStrategy: "balanced",
      },
    },
  );

  expect(result.workerPlans).toHaveLength(2);
  expect(optionValue(result.workerPlans[0]?.args ?? [], "--profile")).toBe("gpt-5.4");
  expect(optionValue(result.workerPlans[1]?.args ?? [], "--profile")).toBe("gpt-5.4-mini");
  expect(result.calibrateWorkerIds).toEqual(["codex-builder-gpt-5-4", "codex-tester-gpt-5-4-mini"]);
});

test("setup wizard prompts for fresh codex credentials when detected login is declined", async () => {
  const result = await runWizardWithAnswers(
    {
      confirmAnswers: [false, false],
      multiselectAnswers: [["codex"]],
      selectAnswers: ["env-var", "gpt-5.4", "hybrid", "adventurer", "__done_codex__", "none"],
      textAnswers: ["QUEST_OPENAI_KEY", USE_INITIAL],
    },
    {
      defaults: {
        backend: "codex",
        harnessDefaults: {
          codex: {
            authMode: "native-login",
            importSummary: "Codex login active via codex",
          },
        },
        testerSelectionStrategy: "balanced",
      },
    },
  );

  const args = result.workerPlans[0]?.args ?? [];
  expect(args).toContain("--no-import-existing");
  expect(optionValue(args, "--auth-mode")).toBe("env-var");
  expect(optionValue(args, "--env-var")).toBe("QUEST_OPENAI_KEY");
});

test("setup wizard loads defaults for the selected harnesses only", async () => {
  const requestedHarnesses: string[][] = [];
  const result = await runWizardWithAnswers(
    {
      confirmAnswers: [true, false],
      multiselectAnswers: [["openclaw"]],
      selectAnswers: ["openai-codex/gpt-5.4", "hybrid", "adventurer", "__done_openclaw__", "none"],
      textAnswers: [USE_INITIAL],
    },
    {
      defaults: {
        backend: "codex",
        testerSelectionStrategy: "balanced",
      },
      loadHarnessDefaults: async (harnesses) => {
        requestedHarnesses.push([...harnesses]);
        return {
          openclaw: {
            agentId: "codex",
            baseUrl: "http://127.0.0.1:6420",
            importSummary: "OpenClaw agent codex on openai-codex/gpt-5.4",
            openClawAgents: [{ id: "codex", model: "openai-codex/gpt-5.4" }],
          },
        };
      },
    },
  );

  expect(requestedHarnesses).toEqual([["openclaw"]]);
  expect(optionValue(result.workerPlans[0]?.args ?? [], "--agent-id")).toBe("codex");
  expect(optionValue(result.workerPlans[0]?.args ?? [], "--gateway-url")).toBe(
    "http://127.0.0.1:6420",
  );
});
