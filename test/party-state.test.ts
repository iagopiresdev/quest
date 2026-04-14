import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QuestPartyStateStore } from "../src/core/party-state";

test("party state store persists bonfire and resume transitions", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-party-state-"));
  const store = new QuestPartyStateStore(join(root, "party-state.json"));

  try {
    const initial = await store.readState();
    expect(initial.status).toBe("active");

    const resting = await store.lightBonfire("operator maintenance");
    expect(resting.status).toBe("resting");
    expect(resting.reason).toBe("operator maintenance");
    expect(resting.events.at(-1)?.type).toBe("party_bonfire_lit");

    const resumed = await store.resumeParty();
    expect(resumed.status).toBe("active");
    expect(resumed.reason).toBeUndefined();
    expect(resumed.events.at(-1)?.type).toBe("party_resumed");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
