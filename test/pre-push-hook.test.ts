import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const hookPath = join(projectRoot, ".githooks", "pre-push");

function runPrePush(input: string): { exitCode: number | null; stderr: string } {
  const result = Bun.spawnSync({
    cmd: ["bash", hookPath],
    cwd: projectRoot,
    stdin: new TextEncoder().encode(input),
    stderr: "pipe",
    stdout: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stderr: new TextDecoder().decode(result.stderr),
  };
}

test("pre-push hook blocks updates to protected remote refs", () => {
  const result = runPrePush(
    "refs/heads/topic 0000000000000000000000000000000000000001 refs/heads/main 0000000000000000000000000000000000000002\n",
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Direct pushes to main/master are blocked");
});

test("pre-push hook allows local main to create a remote topic branch", () => {
  const result = runPrePush(
    "refs/heads/main 0000000000000000000000000000000000000001 refs/heads/codex/topic 0000000000000000000000000000000000000002\n",
  );

  expect(result.exitCode).toBe(0);
});
