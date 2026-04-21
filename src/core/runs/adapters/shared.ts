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

function buildBuilderPrompt(context: RunnerExecutionContext): string {
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
  const contextHints =
    context.slice.contextHints.length === 0
      ? "- none"
      : context.slice.contextHints.map((hint) => `- ${hint}`).join("\n");
  const descriptionSection = context.slice.description?.trim();

  return [
    `Quest: ${context.run.spec.title}`,
    `Slice: ${context.slice.title} (${context.slice.id})`,
    "",
    "Goal:",
    context.slice.goal,
    ...(descriptionSection ? ["", "Details:", descriptionSection] : []),
    "",
    "Constraints:",
    "- Work only within the owned paths for this slice unless a generated file is strictly required.",
    "- Leave code changes in the current workspace; do not describe hypothetical diffs only.",
    "- Keep the final response short and focused on completed work and residual risks.",
    "- This slice runs in an isolated workspace. Check .quest/workspace-manifest.md before searching for conventions.",
    "- Do not assume files like RTK.md or AGENTS.md exist unless the manifest or filesystem shows them.",
    "- Prefer `node --import tsx/loader --test` over `tsx --test` in Node test runs. If Bun-native tests exist, prefer `bun test`.",
    "",
    "Owned paths:",
    ownedPaths,
    "",
    "Dependencies:",
    dependencyList,
    "",
    "Context hints:",
    contextHints,
    "",
    "Later slice acceptance checks:",
    sliceAcceptanceChecks,
    "",
    "Global acceptance checks before integration:",
    globalAcceptanceChecks,
    "",
    "Workspace manifest:",
    "- .quest/workspace-manifest.md",
  ].join("\n");
}

function buildTesterPrompt(context: RunnerExecutionContext): string {
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
  const builderSummary =
    context.sliceState.lastOutput?.summary?.trim() ?? "No builder summary recorded.";
  const builderWorkerId = context.sliceState.assignedWorkerId ?? "unknown";
  const contextHints =
    context.slice.contextHints.length === 0
      ? "- none"
      : context.slice.contextHints.map((hint) => `- ${hint}`).join("\n");
  const descriptionSection = context.slice.description?.trim();

  return [
    `Quest: ${context.run.spec.title}`,
    `Trial: ${context.slice.title} (${context.slice.id})`,
    "",
    "Role:",
    `You are validating the builder output for slice ${context.slice.id}.`,
    "",
    "Builder:",
    `- worker: ${builderWorkerId}`,
    `- summary: ${builderSummary}`,
    "",
    "Goal:",
    context.slice.goal,
    ...(descriptionSection ? ["", "Details:", descriptionSection] : []),
    "",
    "Constraints:",
    "- Work only within the owned paths for this slice.",
    "- Inspect the current workspace result and make only minimal corrections needed for the trial to pass.",
    "- Do not expand the scope beyond validating and stabilizing this slice.",
    "- Keep the final response short and focused on validation and residual risks.",
    "- This slice runs in an isolated workspace. Check .quest/workspace-manifest.md before searching for conventions.",
    "- Prefer `node --import tsx/loader --test` over `tsx --test` in Node test runs. If Bun-native tests exist, prefer `bun test`.",
    "",
    "Owned paths:",
    ownedPaths,
    "",
    "Dependencies:",
    dependencyList,
    "",
    "Context hints:",
    contextHints,
    "",
    "Slice acceptance checks after your validation pass:",
    sliceAcceptanceChecks,
    "",
    "Workspace manifest:",
    "- .quest/workspace-manifest.md",
  ].join("\n");
}

export function buildRunnerPrompt(context: RunnerExecutionContext): string {
  return context.phase === "test" ? buildTesterPrompt(context) : buildBuilderPrompt(context);
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
        code: "quest_unavailable",
        details: { envVar: auth.envVar, workerId: worker.id },
        message: `Environment variable ${auth.envVar} is not set for worker ${worker.id}`,
        statusCode: 1,
      });
    }

    return { [auth.targetEnvVar]: value };
  }

  if (!auth.secretRef) {
    throw new QuestDomainError({
      code: "quest_unavailable",
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
      code: "quest_unavailable",
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
