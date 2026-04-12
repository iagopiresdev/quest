import { QuestDomainError } from "../../errors";
import type { QuestSliceSpec } from "../../planning/spec-schema";
import type { SecretStore } from "../../secret-store";
import type { RegisteredWorker } from "../../workers/schema";
import { runSubprocess } from "../process";
import { buildProcessEnv } from "../process-env";
import type { RunnerExecutionContext } from "./types";

const promptVisibleCommandNames = new Set([
  "biome",
  "bun",
  "cargo",
  "deno",
  "eslint",
  "go",
  "node",
  "npm",
  "pnpm",
  "pytest",
  "python",
  "python3",
  "ruff",
  "tsc",
  "uv",
  "yarn",
]);

function formatPromptArg(arg: string): string {
  if (arg.length === 0) {
    return '""';
  }

  return /[\s"'`$\\]/.test(arg) ? JSON.stringify(arg) : arg;
}

function shouldShowCommandArguments(command: QuestSliceSpec["acceptanceChecks"][number]): boolean {
  const executable = command.argv[0]?.split("/").at(-1)?.toLowerCase();
  return executable !== undefined && promptVisibleCommandNames.has(executable);
}

function describeCommandForPrompt(command: QuestSliceSpec["acceptanceChecks"][number]): string {
  const envOverrideCount = Object.keys(command.env).length;
  const envSuffix = envOverrideCount > 0 ? `, ${envOverrideCount} env override(s)` : "";

  // Real runner prompts need enough literal command detail for the model to avoid inventing a
  // nearby test invocation, but generic commands still stay summarized to avoid leaking ad hoc
  // literals from operator-authored checks.
  if (shouldShowCommandArguments(command)) {
    return `${command.argv.map((arg) => formatPromptArg(arg)).join(" ")}${envSuffix}`;
  }

  const argCount = Math.max(0, command.argv.length - 1);
  return `${command.argv[0]} (${argCount} arg(s) redacted${envSuffix})`;
}

export function buildQuestPrompt(context: RunnerExecutionContext): string {
  const ownedPaths = context.slice.owns.map((path) => `- ${path}`).join("\n");
  const dependencyList =
    context.slice.dependsOn.length === 0
      ? "- none"
      : context.slice.dependsOn.map((dependency) => `- ${dependency}`).join("\n");
  const sliceAcceptanceChecks =
    context.slice.acceptanceChecks.length === 0
      ? "- none"
      : context.slice.acceptanceChecks
          .map((check) => `- ${describeCommandForPrompt(check)}`)
          .join("\n");
  const globalAcceptanceChecks =
    context.run.spec.acceptanceChecks.length === 0
      ? "- none"
      : context.run.spec.acceptanceChecks
          .map((check) => `- ${describeCommandForPrompt(check)}`)
          .join("\n");

  return [
    `Quest: ${context.run.spec.title}`,
    `Slice: ${context.slice.title} (${context.slice.id})`,
    "",
    "Goal:",
    context.slice.goal,
    "",
    "Constraints:",
    "- Work only within the owned paths for this slice unless a generated file is strictly required.",
    "- Leave code changes in the current workspace; do not describe hypothetical diffs only.",
    "- Keep the final response short and focused on completed work and residual risks.",
    "",
    "Owned paths:",
    ownedPaths,
    "",
    "Dependencies:",
    dependencyList,
    "",
    "Later slice acceptance checks:",
    sliceAcceptanceChecks,
    "",
    "Global acceptance checks before integration:",
    globalAcceptanceChecks,
  ].join("\n");
}

export async function resolveAuthEnv(
  worker: RegisteredWorker,
  secretStore: SecretStore,
): Promise<Record<string, string>> {
  const auth = worker.backend.auth;
  if (!auth || auth.mode === "native-login") {
    return {};
  }

  if (auth.mode === "env-var") {
    const value = auth.envVar ? Bun.env[auth.envVar] : undefined;
    if (!value) {
      throw new QuestDomainError({
        code: "quest_runner_unavailable",
        details: { envVar: auth.envVar, workerId: worker.id },
        message: `Environment variable ${auth.envVar} is not set for worker ${worker.id}`,
        statusCode: 1,
      });
    }

    return { [auth.targetEnvVar]: value };
  }

  if (!auth.secretRef) {
    throw new QuestDomainError({
      code: "quest_runner_unavailable",
      details: { workerId: worker.id },
      message: `Worker ${worker.id} is missing a secret-store reference`,
      statusCode: 1,
    });
  }

  return { [auth.targetEnvVar]: await secretStore.getSecret(auth.secretRef) };
}

export async function verifyCodexNativeLogin(
  executable: string,
  worker: RegisteredWorker,
): Promise<void> {
  const result = await runSubprocess({
    cmd: [executable, "login", "status"],
    cwd: Bun.env.PWD ?? ".",
    env: buildProcessEnv(worker.backend.env),
    timeoutMs: 30 * 1000,
  });

  if (result.exitCode !== 0) {
    throw new QuestDomainError({
      code: "quest_runner_unavailable",
      details: {
        command: [executable, "login", "status"],
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        workerId: worker.id,
      },
      message: `Codex native login is not available for ${worker.id}`,
      statusCode: 1,
    });
  }
}
