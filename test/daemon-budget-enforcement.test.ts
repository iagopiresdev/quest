import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QuestDaemonStore } from "../src/core/daemon/store";
import { runDaemonTick } from "../src/core/daemon/tick";
import { QuestPartyStateStore } from "../src/core/party-state";

function baseDaemonSpec(id: string) {
  return {
    acceptanceChecks: [],
    execution: {
      preInstall: false,
      shareSourceDependencies: true,
      testerSelectionStrategy: "balanced" as const,
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
        discipline: "coding" as const,
        goal: "Do the work",
        id,
        owns: ["src/index.ts"],
        title: id,
      },
    ],
    title: `Quest ${id}`,
    version: 1 as const,
    workspace: "sandbox",
  };
}

function createAlwaysOkQuestExecutable(root: string): string {
  const scriptPath = join(root, "quest-always-ok.sh");
  writeFileSync(
    scriptPath,
    [
      "#!/bin/sh",
      "set -eu",
      'if [ "$1" = "plan" ]; then',
      '  printf \'{"plan":{"ok":true}}\\n\'',
      "  exit 0",
      "fi",
      'if [ "$1" = "run" ]; then',
      '  printf \'{"run":{"id":"quest-stub-run-id"}}\\n\'',
      "  exit 0",
      "fi",
      'if [ "$1" = "runs" ] && [ "$2" = "execute" ]; then',
      '  printf \'{"run":{"status":"completed"}}\\n\'',
      "  exit 0",
      "fi",
      "printf 'unsupported command\\n' >&2",
      "exit 1",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  return scriptPath;
}

test("daemon tick enforces maxSpecsPerHour=1 across back-to-back ticks", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-daemon-budget-"));
  const daemonStore = new QuestDaemonStore(root);
  const partyStateStore = new QuestPartyStateStore(join(root, "party-state.json"));
  const questExecutable = createAlwaysOkQuestExecutable(root);

  try {
    await daemonStore.createParty({
      budget: { maxConcurrent: 1, maxSpecsPerHour: 1 },
      enabled: true,
      name: "alpha",
      sourceRepo: join(root, "repo"),
      targetRef: "main",
    });

    const directories = await daemonStore.ensurePartyDirectories("alpha");
    writeFileSync(
      join(directories.inbox, "a.json"),
      JSON.stringify({ priority: 1, retry_count: 0, retry_limit: 0, ...baseDaemonSpec("first") }),
      "utf8",
    );
    writeFileSync(
      join(directories.inbox, "b.json"),
      JSON.stringify({
        priority: 1,
        retry_count: 0,
        retry_limit: 0,
        ...baseDaemonSpec("second"),
      }),
      "utf8",
    );

    const firstTick = await runDaemonTick(
      await daemonStore.readState(),
      await daemonStore.readConfig(),
      { daemonStore, partyStateStore, questCommand: [questExecutable] },
    );
    expect(firstTick.outcomes.some((o) => o.type === "spec_done")).toBe(true);
    await daemonStore.writeState(firstTick.state);

    const secondTick = await runDaemonTick(
      await daemonStore.readState(),
      await daemonStore.readConfig(),
      { daemonStore, partyStateStore, questCommand: [questExecutable] },
    );

    const dispatchedInSecondTick = secondTick.outcomes.filter((o) => o.type === "spec_done");
    expect(dispatchedInSecondTick).toHaveLength(0);

    const budgetEvents = secondTick.events.filter((e) => e.eventType === "daemon_budget_exhausted");
    expect(budgetEvents).toHaveLength(1);
    expect(budgetEvents[0]?.reason).toBe("hourly_limit:1");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
