import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QuestDomainError } from "../src/core/errors";
import {
  ensureGitRepositoryIsClean,
  prepareExecutionWorkspace,
  runWorkspacePreInstall,
} from "../src/core/runs/workspace-materializer";

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

test("ensureGitRepositoryIsClean surfaces changed paths inline in the error message", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-clean-repo-"));
  tempRoots.push(root);

  const git = (...argv: string[]) => {
    const result = spawnSync("git", argv, { cwd: root, stdio: "pipe" });
    if (result.status !== 0) {
      throw new Error(`git ${argv.join(" ")} failed: ${result.stderr?.toString()}`);
    }
  };

  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(root, "seed.txt"), "seed\n", "utf8");
  git("add", "seed.txt");
  git("commit", "-qm", "seed");
  writeFileSync(join(root, "extra-one.txt"), "one\n", "utf8");
  writeFileSync(join(root, "extra-two.txt"), "two\n", "utf8");

  let caught: unknown = null;
  try {
    await ensureGitRepositoryIsClean(root);
  } catch (error: unknown) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(QuestDomainError);
  const domain = caught as QuestDomainError;
  expect(domain.code).toBe("quest_source_repo_dirty");
  expect(domain.message).toContain("2 uncommitted path(s)");
  expect(domain.message).toContain("extra-one.txt");
  expect(domain.message).toContain("extra-two.txt");
  expect(domain.message).toContain("Commit or stash before dispatch");
  const details = domain.details as { changedPaths: string[]; changedPathCount: number };
  expect(details.changedPathCount).toBe(2);
  expect(details.changedPaths).toHaveLength(2);
});

test("ensureGitRepositoryIsClean caps long path lists with a remainder summary", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-clean-repo-long-"));
  tempRoots.push(root);

  const git = (...argv: string[]) => {
    const result = spawnSync("git", argv, { cwd: root, stdio: "pipe" });
    if (result.status !== 0) {
      throw new Error(`git ${argv.join(" ")} failed: ${result.stderr?.toString()}`);
    }
  };

  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(root, "seed.txt"), "seed\n", "utf8");
  git("add", "seed.txt");
  git("commit", "-qm", "seed");
  for (let i = 0; i < 8; i += 1) {
    writeFileSync(join(root, `f${i}.txt`), "x\n", "utf8");
  }

  let caught: unknown = null;
  try {
    await ensureGitRepositoryIsClean(root);
  } catch (error: unknown) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(QuestDomainError);
  const domain = caught as QuestDomainError;
  expect(domain.message).toContain("8 uncommitted path(s)");
  expect(domain.message).toContain("and 3 more");
});


test("prepareExecutionWorkspace disables git hooks during worktree materialization", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-worktree-hooks-"));
  tempRoots.push(root);
  const repositoryRoot = join(root, "source-repo");
  const workspaceRoot = join(root, "workspaces");
  const workspacePath = join(workspaceRoot, "slice-1");
  const hookMarkerPath = join(root, "post-checkout-ran");

  const git = (...argv: string[]) => {
    const result = spawnSync("git", argv, { cwd: repositoryRoot, stdio: "pipe" });
    if (result.status !== 0) {
      throw new Error(`git ${argv.join(" ")} failed: ${result.stderr?.toString()}`);
    }
  };

  mkdirSync(repositoryRoot, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(repositoryRoot, "tracked.txt"), "seed\n", "utf8");
  git("add", "tracked.txt");
  git("commit", "-qm", "seed");
  writeFileSync(
    join(repositoryRoot, ".git", "hooks", "post-checkout"),
    ["#!/bin/sh", "set -eu", `printf 'ran' > ${JSON.stringify(hookMarkerPath)}`].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );

  await prepareExecutionWorkspace(
    {
      id: "run-1",
      sourceRepositoryPath: repositoryRoot,
      spec: {
        execution: {
          preInstall: false,
          prepareCommands: [],
          shareSourceDependencies: false,
        },
      },
      workspaceRoot,
    } as never,
    {
      sliceId: "slice-1",
      status: "queued",
      title: "slice",
      wave: 1,
    } as never,
    workspacePath,
  );

  expect(existsSync(join(workspacePath, "tracked.txt"))).toBe(true);
  expect(existsSync(hookMarkerPath)).toBe(false);
});
