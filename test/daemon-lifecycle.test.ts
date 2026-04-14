import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDaemonTickLoop } from "../src/core/daemon/lifecycle";
import { QuestDaemonStore } from "../src/core/daemon/store";

test("daemon tick loop recovers specs stranded in the running queue before exiting", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-daemon-lifecycle-"));
  const daemonStore = new QuestDaemonStore(root);

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
    await daemonStore.updateProcess({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      stopRequested: true,
    });

    const directories = await daemonStore.ensurePartyDirectories("alpha");
    writeFileSync(
      join(directories.running, "stuck.json"),
      JSON.stringify({
        ...baseDaemonSpec(),
        daemon_result: {
          runId: "quest-00000000-aaaaaaaa",
          startedAt: new Date().toISOString(),
          status: "running",
        },
        priority: 1,
        retry_count: 0,
        retry_limit: 0,
      }),
      "utf8",
    );

    const result = await runDaemonTickLoop(daemonStore, {
      sleep: async () => {},
    });

    expect(result.stopped).toBe(true);
    expect(existsSync(join(directories.inbox, "stuck.json"))).toBe(true);
    expect(existsSync(join(directories.running, "stuck.json"))).toBe(false);

    const recovered = JSON.parse(readFileSync(join(directories.inbox, "stuck.json"), "utf8"));
    expect(recovered.daemon_result.status).toBe("retrying");
    expect((await daemonStore.readState()).process).toBeUndefined();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

function baseDaemonSpec() {
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
        id: "alpha",
        owns: ["src/index.ts"],
        title: "alpha",
      },
    ],
    title: "Lifecycle quest",
    version: 1,
    workspace: "daemon-workspace",
  };
}
