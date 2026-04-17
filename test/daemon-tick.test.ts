import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QuestDaemonStore } from "../src/core/daemon/store";
import { runDaemonTick } from "../src/core/daemon/tick";
import { QuestPartyStateStore } from "../src/core/party-state";

function createFakeQuestExecutable(
  root: string,
  options: { capturePath: string; failStage?: "execute" | undefined } = { capturePath: "" },
): string {
  const scriptPath = join(root, "quest-daemon-mock.sh");
  const planInputPath = join(root, "stdin-plan.json");
  const runInputPath = join(root, "stdin-run.json");
  writeFileSync(
    scriptPath,
    [
      "#!/bin/sh",
      "set -eu",
      `printf '%s\\n' "$*" >> '${options.capturePath}'`,
      'if [ "$1" = "plan" ]; then',
      `  cat "$3" > '${planInputPath}'`,
      '  printf \'{"plan":{"ok":true}}\\n\'',
      "  exit 0",
      "fi",
      'if [ "$1" = "run" ]; then',
      `  cat "$3" > '${runInputPath}'`,
      '  printf \'{"run":{"id":"quest-00000000-aaaaaaaa"}}\\n\'',
      "  exit 0",
      "fi",
      'if [ "$1" = "runs" ] && [ "$2" = "execute" ]; then',
      ...(options.failStage === "execute"
        ? ['  printf \'{"error":"quest_failed","message":"execute blew up"}\\n\' >&2', "  exit 1"]
        : ['  printf \'{"run":{"status":"completed"}}\\n\'', "  exit 0"]),
      "fi",
      "printf 'unsupported command\\n' >&2",
      "exit 1",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  return scriptPath;
}

test("daemon tick dispatches the highest-priority inbox spec through quest subprocesses", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-daemon-tick-"));
  const capturePath = join(root, "commands.log");
  const daemonStore = new QuestDaemonStore(root);
  const partyStateStore = new QuestPartyStateStore(join(root, "party-state.json"));
  const questExecutable = createFakeQuestExecutable(root, { capturePath });

  try {
    await daemonStore.createParty({
      budget: {
        maxConcurrent: 1,
        maxSpecsPerHour: 10,
      },
      enabled: true,
      name: "alpha",
      sourceRepo: join(root, "repo"),
      targetRef: "main",
    });

    const directories = await daemonStore.ensurePartyDirectories("alpha");
    writeFileSync(
      join(directories.inbox, "slow.json"),
      JSON.stringify({ priority: 5, retry_count: 0, retry_limit: 0, ...baseDaemonSpec("slow") }),
      "utf8",
    );
    writeFileSync(
      join(directories.inbox, "fast.json"),
      JSON.stringify({ priority: 1, retry_count: 0, retry_limit: 0, ...baseDaemonSpec("fast") }),
      "utf8",
    );

    const result = await runDaemonTick(
      await daemonStore.readState(),
      await daemonStore.readConfig(),
      {
        daemonStore,
        partyStateStore,
        questCommand: [questExecutable],
      },
    );

    expect(result.outcomes.some((outcome) => outcome.type === "spec_done")).toBe(true);
    expect(existsSync(join(directories.done, "fast.json"))).toBe(true);
    expect(existsSync(join(directories.inbox, "slow.json"))).toBe(true);

    const doneDocument = JSON.parse(readFileSync(join(directories.done, "fast.json"), "utf8"));
    expect(doneDocument.daemon_result.status).toBe("done");
    expect(doneDocument.daemon_result.runId).toBe("quest-00000000-aaaaaaaa");

    const commands = readFileSync(capturePath, "utf8").trim().split("\n");
    const preparedPath = join(directories.running, "fast.json.prepared.json");
    expect(commands).toEqual([
      `plan --file ${preparedPath} --state-root ${root}`,
      `run --file ${preparedPath} --state-root ${root}`,
      `runs execute --id quest-00000000-aaaaaaaa --auto-integrate --land --source-repo ${join(root, "repo")} --target-ref main --state-root ${root}`,
    ]);
    const plannedInput = JSON.parse(readFileSync(join(root, "stdin-plan.json"), "utf8"));
    const runInput = JSON.parse(readFileSync(join(root, "stdin-run.json"), "utf8"));
    expect(plannedInput).toEqual(runInput);
    expect(plannedInput.title).toBe("Quest fast");
    expect(plannedInput.priority).toBeUndefined();
    expect(plannedInput.retry_count).toBeUndefined();
    expect(plannedInput.retry_limit).toBeUndefined();
    expect(plannedInput.daemon_result).toBeUndefined();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("daemon tick moves failed specs to the failed queue and starts cooldown", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-daemon-tick-"));
  const capturePath = join(root, "commands.log");
  const daemonStore = new QuestDaemonStore(root);
  const partyStateStore = new QuestPartyStateStore(join(root, "party-state.json"));
  const questExecutable = createFakeQuestExecutable(root, { capturePath, failStage: "execute" });

  try {
    await daemonStore.createParty({
      budget: {
        maxConcurrent: 1,
        maxSpecsPerHour: 10,
      },
      enabled: true,
      name: "alpha",
      sourceRepo: join(root, "repo"),
      targetRef: "main",
    });

    const directories = await daemonStore.ensurePartyDirectories("alpha");
    writeFileSync(
      join(directories.inbox, "broken.json"),
      JSON.stringify({ priority: 1, retry_count: 0, retry_limit: 0, ...baseDaemonSpec("broken") }),
      "utf8",
    );

    const result = await runDaemonTick(
      await daemonStore.readState(),
      await daemonStore.readConfig(),
      {
        daemonStore,
        partyStateStore,
        questCommand: [questExecutable],
      },
    );

    expect(result.outcomes.some((outcome) => outcome.type === "spec_failed")).toBe(true);
    expect(result.state.cooldownUntil.alpha).toBeString();
    expect(result.state.lastErrorByParty.alpha).toContain("execute blew up");

    const failedDocument = JSON.parse(
      readFileSync(join(directories.failed, "broken.json"), "utf8"),
    );
    expect(failedDocument.daemon_result.status).toBe("failed");
    expect(failedDocument.daemon_result.error).toContain("execute blew up");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("daemon tick quarantines invalid specs without starving valid inbox work", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-daemon-tick-"));
  const capturePath = join(root, "commands.log");
  const daemonStore = new QuestDaemonStore(root);
  const partyStateStore = new QuestPartyStateStore(join(root, "party-state.json"));
  const questExecutable = createFakeQuestExecutable(root, { capturePath });

  try {
    await daemonStore.createParty({
      budget: {
        maxConcurrent: 1,
        maxSpecsPerHour: 10,
      },
      enabled: true,
      name: "alpha",
      sourceRepo: join(root, "repo"),
      targetRef: "main",
    });

    const directories = await daemonStore.ensurePartyDirectories("alpha");
    writeFileSync(join(directories.inbox, "broken.json"), "{\n", "utf8");
    writeFileSync(
      join(directories.inbox, "valid.json"),
      JSON.stringify({ priority: 1, retry_count: 0, retry_limit: 0, ...baseDaemonSpec("valid") }),
      "utf8",
    );

    const result = await runDaemonTick(
      await daemonStore.readState(),
      await daemonStore.readConfig(),
      {
        daemonStore,
        partyStateStore,
        questCommand: [questExecutable],
      },
    );

    expect(result.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          party: "alpha",
          specFile: "broken.json",
          type: "spec_failed",
        }),
        expect.objectContaining({
          party: "alpha",
          specFile: "valid.json",
          type: "spec_done",
        }),
      ]),
    );
    expect(existsSync(join(directories.failed, "broken.json"))).toBe(true);
    expect(existsSync(join(directories.done, "valid.json"))).toBe(true);
    expect(result.state.cooldownUntil.alpha).toBeUndefined();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("daemon tick persists active run ids before execute starts", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-daemon-tick-"));
  const capturePath = join(root, "commands.log");
  const daemonStore = new QuestDaemonStore(root);
  const partyStateStore = new QuestPartyStateStore(join(root, "party-state.json"));
  const questExecutable = join(root, "quest-daemon-active-run-mock.sh");
  const daemonStatePath = daemonStore.getStatePath();

  writeFileSync(
    questExecutable,
    [
      "#!/bin/sh",
      "set -eu",
      `printf '%s\\n' "$*" >> '${capturePath}'`,
      'if [ "$1" = "plan" ]; then',
      '  printf \'{"plan":{"ok":true}}\\n\'',
      "  exit 0",
      "fi",
      'if [ "$1" = "run" ]; then',
      '  printf \'{"run":{"id":"quest-00000000-aaaaaaaa"}}\\n\'',
      "  exit 0",
      "fi",
      'if [ "$1" = "runs" ] && [ "$2" = "execute" ]; then',
      `  grep -q 'quest-00000000-aaaaaaaa' '${daemonStatePath}'`,
      '  printf \'{"run":{"status":"completed"}}\\n\'',
      "  exit 0",
      "fi",
      "printf 'unsupported command\\n' >&2",
      "exit 1",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );

  try {
    await daemonStore.createParty({
      budget: {
        maxConcurrent: 1,
        maxSpecsPerHour: 10,
      },
      enabled: true,
      name: "alpha",
      sourceRepo: join(root, "repo"),
      targetRef: "main",
    });

    const directories = await daemonStore.ensurePartyDirectories("alpha");
    writeFileSync(
      join(directories.inbox, "active.json"),
      JSON.stringify({ priority: 1, retry_count: 0, retry_limit: 0, ...baseDaemonSpec("active") }),
      "utf8",
    );

    const result = await runDaemonTick(
      await daemonStore.readState(),
      await daemonStore.readConfig(),
      {
        daemonStore,
        partyStateStore,
        questCommand: [questExecutable],
      },
    );

    expect(result.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          party: "alpha",
          specFile: "active.json",
          type: "spec_done",
        }),
      ]),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("daemon tick emits dispatched and landed events for a successful run", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-daemon-tick-"));
  const capturePath = join(root, "commands.log");
  const daemonStore = new QuestDaemonStore(root);
  const partyStateStore = new QuestPartyStateStore(join(root, "party-state.json"));
  const questExecutable = createFakeQuestExecutable(root, { capturePath });

  try {
    await daemonStore.createParty({
      budget: { maxConcurrent: 1, maxSpecsPerHour: 10 },
      enabled: true,
      name: "alpha",
      sourceRepo: join(root, "repo"),
      targetRef: "main",
    });

    const directories = await daemonStore.ensurePartyDirectories("alpha");
    writeFileSync(
      join(directories.inbox, "fast.json"),
      JSON.stringify({ priority: 1, retry_count: 0, retry_limit: 0, ...baseDaemonSpec("fast") }),
      "utf8",
    );

    const result = await runDaemonTick(
      await daemonStore.readState(),
      await daemonStore.readConfig(),
      {
        daemonStore,
        partyStateStore,
        questCommand: [questExecutable],
      },
    );

    const eventTypes = result.events.map((event) => event.eventType);
    expect(eventTypes).toContain("daemon_dispatched");
    expect(eventTypes).toContain("daemon_landed");
    const landed = result.events.find((event) => event.eventType === "daemon_landed");
    expect(landed?.partyName).toBe("alpha");
    expect(landed?.specFile).toBe("fast.json");
    expect(landed?.runId).toBe("quest-00000000-aaaaaaaa");
    const dispatched = result.events.find((event) => event.eventType === "daemon_dispatched");
    expect(dispatched?.partyName).toBe("alpha");
    expect(dispatched?.runId).toBeNull();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("daemon tick emits a failed event when execute blows up", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-daemon-tick-"));
  const capturePath = join(root, "commands.log");
  const daemonStore = new QuestDaemonStore(root);
  const partyStateStore = new QuestPartyStateStore(join(root, "party-state.json"));
  const questExecutable = createFakeQuestExecutable(root, { capturePath, failStage: "execute" });

  try {
    await daemonStore.createParty({
      budget: { maxConcurrent: 1, maxSpecsPerHour: 10 },
      enabled: true,
      name: "alpha",
      sourceRepo: join(root, "repo"),
      targetRef: "main",
    });

    const directories = await daemonStore.ensurePartyDirectories("alpha");
    writeFileSync(
      join(directories.inbox, "boom.json"),
      JSON.stringify({ priority: 1, retry_count: 0, retry_limit: 0, ...baseDaemonSpec("boom") }),
      "utf8",
    );

    const result = await runDaemonTick(
      await daemonStore.readState(),
      await daemonStore.readConfig(),
      {
        daemonStore,
        partyStateStore,
        questCommand: [questExecutable],
      },
    );

    const failed = result.events.find((event) => event.eventType === "daemon_failed");
    expect(failed).toBeDefined();
    expect(failed?.specFile).toBe("boom.json");
    expect(failed?.error).toContain("execute blew up");
    expect(failed?.runId).toBe("quest-00000000-aaaaaaaa");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("daemon tick emits a failed event for unreadable specs", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-daemon-tick-"));
  const capturePath = join(root, "commands.log");
  const daemonStore = new QuestDaemonStore(root);
  const partyStateStore = new QuestPartyStateStore(join(root, "party-state.json"));
  const questExecutable = createFakeQuestExecutable(root, { capturePath });

  try {
    await daemonStore.createParty({
      budget: { maxConcurrent: 1, maxSpecsPerHour: 10 },
      enabled: true,
      name: "alpha",
      sourceRepo: join(root, "repo"),
      targetRef: "main",
    });

    const directories = await daemonStore.ensurePartyDirectories("alpha");
    writeFileSync(join(directories.inbox, "broken.json"), "{\n", "utf8");

    const result = await runDaemonTick(
      await daemonStore.readState(),
      await daemonStore.readConfig(),
      {
        daemonStore,
        partyStateStore,
        questCommand: [questExecutable],
      },
    );

    const failed = result.events.filter((event) => event.eventType === "daemon_failed");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]?.specFile).toBe("broken.json");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("daemon tick inherits party tracker default when spec has no tracker block", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-daemon-tick-"));
  const capturePath = join(root, "commands.log");
  const daemonStore = new QuestDaemonStore(root);
  const partyStateStore = new QuestPartyStateStore(join(root, "party-state.json"));
  const questExecutable = createFakeQuestExecutable(root, { capturePath });

  try {
    await daemonStore.createParty({
      budget: { maxConcurrent: 1, maxSpecsPerHour: 10 },
      enabled: true,
      name: "alpha",
      sourceRepo: join(root, "repo"),
      targetRef: "main",
      tracker: { linear: { defaultIssueId: "FRI-FALLBACK" } },
    });

    const directories = await daemonStore.ensurePartyDirectories("alpha");
    // Spec intentionally omits tracker block — should inherit FRI-FALLBACK from the party.
    writeFileSync(
      join(directories.inbox, "inherit.json"),
      JSON.stringify({
        priority: 1,
        retry_count: 0,
        retry_limit: 0,
        ...baseDaemonSpec("inherit"),
      }),
      "utf8",
    );

    const result = await runDaemonTick(
      await daemonStore.readState(),
      await daemonStore.readConfig(),
      {
        daemonStore,
        partyStateStore,
        questCommand: [questExecutable],
      },
    );

    const dispatched = result.events.find((e) => e.eventType === "daemon_dispatched");
    const landed = result.events.find((e) => e.eventType === "daemon_landed");
    expect(dispatched?.trackerIssueId).toBe("FRI-FALLBACK");
    expect(landed?.trackerIssueId).toBe("FRI-FALLBACK");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("daemon tick: spec-level tracker overrides party default", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-daemon-tick-"));
  const capturePath = join(root, "commands.log");
  const daemonStore = new QuestDaemonStore(root);
  const partyStateStore = new QuestPartyStateStore(join(root, "party-state.json"));
  const questExecutable = createFakeQuestExecutable(root, { capturePath });

  try {
    await daemonStore.createParty({
      budget: { maxConcurrent: 1, maxSpecsPerHour: 10 },
      enabled: true,
      name: "alpha",
      sourceRepo: join(root, "repo"),
      targetRef: "main",
      tracker: { linear: { defaultIssueId: "FRI-FALLBACK" } },
    });

    const directories = await daemonStore.ensurePartyDirectories("alpha");
    writeFileSync(
      join(directories.inbox, "override.json"),
      JSON.stringify({
        priority: 1,
        retry_count: 0,
        retry_limit: 0,
        ...baseDaemonSpec("override"),
        tracker: { linear: { issueId: "FRI-EXPLICIT" } },
      }),
      "utf8",
    );

    const result = await runDaemonTick(
      await daemonStore.readState(),
      await daemonStore.readConfig(),
      {
        daemonStore,
        partyStateStore,
        questCommand: [questExecutable],
      },
    );

    const dispatched = result.events.find((e) => e.eventType === "daemon_dispatched");
    expect(dispatched?.trackerIssueId).toBe("FRI-EXPLICIT");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("daemon tick emits a budget_exhausted event when the hourly window is full", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-daemon-tick-"));
  const daemonStore = new QuestDaemonStore(root);
  const partyStateStore = new QuestPartyStateStore(join(root, "party-state.json"));

  try {
    await daemonStore.createParty({
      budget: { maxConcurrent: 1, maxSpecsPerHour: 1 },
      enabled: true,
      name: "alpha",
      sourceRepo: join(root, "repo"),
      targetRef: "main",
    });

    const saturatedState = await daemonStore.readState();
    saturatedState.completedSpecTimestamps.alpha = [new Date().toISOString()];
    await daemonStore.writeState(saturatedState);

    const directories = await daemonStore.ensurePartyDirectories("alpha");
    writeFileSync(
      join(directories.inbox, "queued.json"),
      JSON.stringify({ priority: 1, retry_count: 0, retry_limit: 0, ...baseDaemonSpec("queued") }),
      "utf8",
    );

    const result = await runDaemonTick(
      await daemonStore.readState(),
      await daemonStore.readConfig(),
      {
        daemonStore,
        partyStateStore,
      },
    );

    const budgetEvent = result.events.find(
      (event) => event.eventType === "daemon_budget_exhausted",
    );
    expect(budgetEvent).toBeDefined();
    expect(budgetEvent?.partyName).toBe("alpha");
    expect(budgetEvent?.reason).toBe("hourly_limit:1");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

function baseDaemonSpec(id: string) {
  return {
    acceptanceChecks: [],
    execution: {
      preInstall: false,
      shareSourceDependencies: true,
      testerSelectionStrategy: "balanced",
      timeoutMinutes: 20,
    },
    featureDoc: { enabled: false },
    hotspots: [],
    maxParallel: 1,
    slices: [
      {
        acceptanceChecks: [],
        contextHints: [],
        dependsOn: [],
        discipline: "coding",
        goal: "Do the work",
        id,
        owns: ["src/index.ts"],
        title: id,
      },
    ],
    title: `Quest ${id}`,
    version: 1,
    workspace: "daemon-workspace",
  };
}
