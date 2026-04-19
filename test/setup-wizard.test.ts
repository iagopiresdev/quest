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
  if (!answers) {
    throw new Error("Missing prompt answer state");
  }
  return answers;
}

function takeAnswer<T>(answers: T[], kind: string): T {
  const answer = answers.shift();
  if (answer === undefined) {
    throw new Error(`Missing ${kind} answer`);
  }
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
  spinner: mock(() => ({
    start: mock(() => {}),
    stop: mock(() => {}),
  })),
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

test("setup wizard registers multiple selected models in one pass", async () => {
  const result = await runWizardWithAnswers(
    {
      confirmAnswers: [true],
      multiselectAnswers: [["codex"], ["gpt-5.4", "gpt-5.4-mini"]],
      selectAnswers: ["builder", "tester", "none"],
      textAnswers: [USE_INITIAL, USE_INITIAL],
    },
    {
      defaults: {
        backend: "codex",
        testerSelectionStrategy: "balanced",
      },
    },
  );

  const ids = result.workerPlans.map((plan) => optionValue(plan.args, "--id"));
  expect(ids).toEqual(["codex-builder-gpt-5-4", "codex-tester-gpt-5-4-mini"]);
  expect(result.calibrateWorkerIds).toEqual(["codex-builder-gpt-5-4", "codex-tester-gpt-5-4-mini"]);
});

test("setup wizard records declined detected imports on worker plans", async () => {
  const result = await runWizardWithAnswers(
    {
      confirmAnswers: [false, false],
      multiselectAnswers: [["codex"], ["gpt-5.4"]],
      selectAnswers: ["hybrid", "none"],
      textAnswers: [USE_INITIAL],
    },
    {
      defaults: {
        backend: "codex",
        harnessDefaults: {
          codex: {
            envVar: "OPENAI_API_KEY",
            importSummary: "Codex API key imported from OPENAI_API_KEY",
          },
        },
        testerSelectionStrategy: "balanced",
      },
    },
  );

  const args = result.workerPlans[0]?.args ?? [];
  expect(args).toContain("--no-import-existing");
  expect(args).not.toContain("--auth-mode");
  expect(args).not.toContain("--env-var");
});

test("setup wizard does not re-check harness defaults that are already loaded", async () => {
  let loadCalls = 0;
  const result = await runWizardWithAnswers(
    {
      confirmAnswers: [true, false],
      multiselectAnswers: [["codex"], ["gpt-5.4"]],
      selectAnswers: ["hybrid", "none"],
      textAnswers: [USE_INITIAL],
    },
    {
      defaults: {
        backend: "codex",
        harnessDefaults: {
          codex: {
            importSummary: "Codex login active via /opt/homebrew/bin/codex",
          },
        },
        testerSelectionStrategy: "balanced",
      },
      loadHarnessDefaults: () => {
        loadCalls += 1;
        return {};
      },
    },
  );

  expect(loadCalls).toBe(0);
  expect(result.workerPlans[0]?.args).toContain("--auth-mode");
});

test("setup wizard keeps detected defaults scoped to their harness", async () => {
  const result = await runWizardWithAnswers(
    {
      confirmAnswers: [false],
      multiselectAnswers: [["hermes", "openclaw"], ["hermes-local"], ["openclaw-codex"]],
      selectAnswers: ["hybrid", "hybrid", "none"],
      textAnswers: [USE_INITIAL, USE_INITIAL, USE_INITIAL, USE_INITIAL],
    },
    {
      defaults: {
        backend: "codex",
        baseUrl: "http://wrong.example/v1",
        harnessDefaults: {
          hermes: {
            baseUrl: "http://127.0.0.1:8000/v1",
            profile: "hermes-local",
          },
          openclaw: {
            agentId: "codex",
            baseUrl: "http://127.0.0.1:6420",
            profile: "openclaw-codex",
          },
        },
        profile: "wrong-model",
        testerSelectionStrategy: "balanced",
      },
    },
  );

  const [hermesPlan, openClawPlan] = result.workerPlans;
  expect(optionValue(hermesPlan?.args ?? [], "--profile")).toBe("hermes-local");
  expect(optionValue(hermesPlan?.args ?? [], "--base-url")).toBe("http://127.0.0.1:8000/v1");
  expect(optionValue(openClawPlan?.args ?? [], "--profile")).toBe("openclaw-codex");
  expect(optionValue(openClawPlan?.args ?? [], "--agent-id")).toBe("codex");
});

test("setup wizard loads detected defaults after harness selection", async () => {
  const requestedHarnesses: string[][] = [];

  const result = await runWizardWithAnswers(
    {
      confirmAnswers: [true, false],
      multiselectAnswers: [["openclaw"], ["openclaw-codex"]],
      selectAnswers: ["hybrid", "none"],
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
            importSummary: "OpenClaw agent codex on openclaw-codex",
            profile: "openclaw-codex",
          },
        };
      },
    },
  );

  expect(requestedHarnesses).toEqual([["openclaw"]]);
  const args = result.workerPlans[0]?.args ?? [];
  expect(optionValue(args, "--profile")).toBe("openclaw-codex");
  expect(optionValue(args, "--agent-id")).toBe("codex");
  expect(optionValue(args, "--gateway-url")).toBe("http://127.0.0.1:6420");
});

test("setup wizard can register a standalone local-command worker", async () => {
  const result = await runWizardWithAnswers(
    {
      confirmAnswers: [false],
      multiselectAnswers: [["standalone"]],
      selectAnswers: ["hybrid", "none"],
      textAnswers: [USE_INITIAL, "bun ./worker.ts"],
    },
    {
      defaults: {
        backend: "standalone",
        testerSelectionStrategy: "balanced",
      },
    },
  );

  const plan = result.workerPlans[0];
  expect(plan?.backend).toBe("standalone");
  expect(optionValue(plan?.args ?? [], "--command")).toBe("bun ./worker.ts");
  expect(optionValue(plan?.args ?? [], "--profile")).toBe("standalone");
});
