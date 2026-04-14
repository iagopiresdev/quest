import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWorkspacePreInstall } from "../src/core/runs/workspace-materializer";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

test("workspace preInstall infers requirements install commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-workspace-preinstall-"));
  tempRoots.push(root);
  const binDir = join(root, "bin");
  const cwd = join(root, "workspace");
  const markerPath = join(root, "pip-marker.txt");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "requirements.txt"), "requests==2.0.0\n", "utf8");
  writeFileSync(
    join(binDir, "python3"),
    ["#!/bin/sh", "set -eu", `printf '%s\\n' "$*" > ${JSON.stringify(markerPath)}`].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );

  const previousPath = Bun.env.PATH;
  Bun.env.PATH = `${binDir}:${previousPath ?? ""}`;
  try {
    await runWorkspacePreInstall(true, cwd);
    expect(await Bun.file(markerPath).text()).toContain("-m pip install -r requirements.txt");
  } finally {
    if (previousPath === undefined) {
      delete Bun.env.PATH;
    } else {
      Bun.env.PATH = previousPath;
    }
  }
});
