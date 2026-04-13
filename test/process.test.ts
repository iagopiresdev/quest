import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSubprocess } from "../src/core/runs/process";

test("runSubprocess truncates oversized stdout and marks it as truncated", async () => {
  const result = await runSubprocess({
    cmd: ["bun", "-e", "await Bun.write(Bun.stdout, 'x'.repeat(4096));"],
    cwd: process.cwd(),
    env: { PATH: Bun.env.PATH ?? "/usr/bin:/bin" },
    maxOutputBytes: 256,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.length).toBe(256);
  expect(result.stdoutTruncated).toBe(true);
  expect(result.stderrTruncated).toBe(false);
});

test("runSubprocess aborts long-running commands when timeoutMs elapses", async () => {
  const result = await runSubprocess({
    cmd: ["bun", "-e", "await Bun.sleep(100);"],
    cwd: process.cwd(),
    env: { PATH: Bun.env.PATH ?? "/usr/bin:/bin" },
    timeoutMs: 10,
  });

  expect(result.timedOut).toBe(true);
  expect(result.aborted).toBe(true);
});

test("runSubprocess aborts commands that stop producing output past idleTimeoutMs", async () => {
  const result = await runSubprocess({
    cmd: ["bun", "-e", "process.stdout.write('start\\n'); await Bun.sleep(120);"],
    cwd: process.cwd(),
    env: { PATH: Bun.env.PATH ?? "/usr/bin:/bin" },
    idleTimeoutMs: 30,
  });

  expect(result.timedOut).toBe(true);
  expect(result.aborted).toBe(true);
  expect(result.stdout).toContain("start");
});

test("runSubprocess resolves bare commands against the provided PATH", async () => {
  const root = mkdtempSync(join(tmpdir(), "quest-process-"));

  try {
    const executablePath = join(root, "quest-echo");
    writeFileSync(executablePath, ["#!/bin/sh", "printf 'resolved-from-path\\n'"].join("\n"), {
      encoding: "utf8",
      mode: 0o755,
    });

    const result = await runSubprocess({
      cmd: ["quest-echo"],
      cwd: root,
      env: { PATH: root },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("resolved-from-path");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
