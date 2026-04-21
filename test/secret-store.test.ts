import { expect, test } from "bun:test";

import { QuestDomainError } from "../src/core/errors";
import { SecretStore } from "../src/core/secret-store";

test("secret store issues macOS keychain commands through the configured service name", async () => {
  const calls: Array<{ cmd: string[]; stdin?: string | undefined }> = [];
  const store = new SecretStore({
    platform: "darwin",
    runCommand: async ({ cmd, stdin }) => {
      calls.push({ cmd, stdin });
      return {
        aborted: false,
        exitCode: 0,
        stderr: "",
        stderrTruncated: false,
        stdout: cmd.includes("-w") && cmd[1] === "find-generic-password" ? "stored-secret\n" : "",
        stdoutTruncated: false,
        timedOut: false,
      };
    },
    serviceName: "quest-tests",
  });

  await store.setSecret("codex.api", "stored-secret");
  const secret = await store.getSecret("codex.api");
  const status = await store.getStatus("codex.api");
  await store.deleteSecret("codex.api");

  expect(secret).toBe("stored-secret");
  expect(status).toEqual({
    backend: "macos-keychain",
    exists: true,
    name: "codex.api",
  });
  expect(calls).toEqual([
    {
      cmd: ["security", "add-generic-password", "-a", "codex.api", "-s", "quest-tests", "-U", "-w"],
      stdin: "stored-secret\nstored-secret\n",
    },
    {
      cmd: ["security", "find-generic-password", "-a", "codex.api", "-s", "quest-tests", "-w"],
      stdin: undefined,
    },
    {
      cmd: ["security", "find-generic-password", "-a", "codex.api", "-s", "quest-tests"],
      stdin: undefined,
    },
    {
      cmd: ["security", "delete-generic-password", "-a", "codex.api", "-s", "quest-tests"],
      stdin: undefined,
    },
  ]);
});

test("secret store rejects unsupported platforms", async () => {
  const store = new SecretStore({ platform: "linux" });

  try {
    await store.getStatus("codex.api");
    throw new Error("Expected quest_unavailable");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(QuestDomainError);
    expect((error as QuestDomainError).code).toBe("quest_unavailable");
  }
});

test("secret store surfaces keychain failures separately from missing items", async () => {
  const store = new SecretStore({
    platform: "darwin",
    runCommand: async () => ({
      aborted: false,
      exitCode: 36,
      stderr: "User interaction is not allowed.",
      stderrTruncated: false,
      stdout: "",
      stdoutTruncated: false,
      timedOut: false,
    }),
  });

  await expect(store.getStatus("codex.api")).rejects.toMatchObject({
    code: "quest_storage_failure",
  });
  await expect(store.deleteSecret("codex.api")).rejects.toMatchObject({
    code: "quest_storage_failure",
  });
  await expect(store.getSecret("codex.api")).rejects.toMatchObject({
    code: "quest_storage_failure",
  });
});
