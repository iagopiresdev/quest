import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureDirectory, writeJsonFileAtomically } from "../src/core/storage";

test("ensureDirectory creates private quest directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-storage-"));
  const path = join(root, "state", "nested");

  try {
    await ensureDirectory(path);
    expect(statSync(path).mode & 0o777).toBe(0o700);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("writeJsonFileAtomically creates private quest state files", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-storage-"));
  const path = join(root, "state", "run.json");

  try {
    await writeJsonFileAtomically(path, { ok: true });
    expect(statSync(join(root, "state")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
