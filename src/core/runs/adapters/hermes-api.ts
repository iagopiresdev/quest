import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, posix, relative, resolve } from "node:path";

import { z } from "zod";
import { isQuestDomainError, QuestDomainError } from "../../errors";
import type { SecretStore } from "../../secret-store";
import type { WorkerRuntimeConfig } from "../../workers/runtime";
import { matchesQuestPathPattern } from "../path-patterns";
import { assertWorkspacePathWithinRoot } from "../workspace-layout";
import { buildRunnerPrompt, resolveAuthEnv } from "./shared";
import type { RunnerAdapter, RunnerExecutionContext, RunnerExecutionResult } from "./types";

const hermesResponseSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            content: z.string(),
            path: z.string().trim().min(1).max(400),
          })
          .strict(),
      )
      .max(64)
      .default([]),
    summary: z.string().trim().min(1).max(400),
  })
  .strict();

type HermesFileSnapshot = {
  content: string;
  path: string;
};

function buildHermesSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined) {
    return signal;
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) {
    return timeoutSignal;
  }

  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeoutSignal]) : signal;
}

function matchesOwnedPath(relativePath: string, ownedPatterns: string[]): boolean {
  return matchesQuestPathPattern(relativePath, ownedPatterns);
}

function normalizeHermesWritePath(inputPath: string): string {
  const slashPath = inputPath.replaceAll("\\", "/").trim();
  const hasWindowsDrivePrefix = /^[A-Za-z]:/.test(slashPath);
  if (slashPath.startsWith("/") || hasWindowsDrivePrefix) {
    throw new QuestDomainError({
      code: "quest_command_failed",
      details: { path: inputPath },
      message: `Hermes produced an invalid write path: ${inputPath}`,
      statusCode: 1,
    });
  }

  if (slashPath.split("/").includes("..")) {
    throw new QuestDomainError({
      code: "quest_command_failed",
      details: { path: inputPath },
      message: `Hermes produced an invalid write path: ${inputPath}`,
      statusCode: 1,
    });
  }

  const normalized = posix.normalize(slashPath).replace(/^\.\/+/, "");
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new QuestDomainError({
      code: "quest_command_failed",
      details: { path: inputPath },
      message: `Hermes produced an invalid write path: ${inputPath}`,
      statusCode: 1,
    });
  }

  return normalized;
}

async function listWorkspaceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(root, entry.parentPath.replaceAll("\\", "/"), entry.name));
}

async function collectHermesFileSnapshots(
  context: RunnerExecutionContext,
): Promise<HermesFileSnapshot[]> {
  const files = await listWorkspaceFiles(context.cwd);
  const matchingFiles = files
    .map((path) => ({
      absolutePath: path,
      relativePath: relative(context.cwd, path).replaceAll("\\", "/"),
    }))
    .filter((file) => matchesOwnedPath(file.relativePath, context.slice.owns))
    .slice(0, 24);

  const snapshots = await Promise.all(
    matchingFiles.map(async (file) => ({
      content: await Bun.file(file.absolutePath).text(),
      path: file.relativePath,
    })),
  );

  return snapshots.filter((snapshot) => snapshot.content.length <= 50_000);
}

function buildHermesPrompt(
  context: RunnerExecutionContext,
  snapshots: HermesFileSnapshot[],
): string {
  const filesSection =
    snapshots.length === 0
      ? "No owned files currently exist in the workspace."
      : snapshots
          .map((snapshot) => `File: ${snapshot.path}\n<<<FILE\n${snapshot.content}\nFILE`)
          .join("\n\n");

  return [
    buildRunnerPrompt(context),
    "",
    "Return JSON only with this shape:",
    '{"summary":"short summary","files":[{"path":"relative/path","content":"full file contents"}]}',
    "",
    "Rules:",
    "- Only write files inside the owned paths for this slice.",
    "- Return complete file contents for each changed file.",
    "- If no file change is needed, return an empty files array.",
    "",
    "Current owned file snapshots:",
    filesSection,
  ].join("\n");
}

function extractAssistantContent(responseBody: unknown): string {
  const parsed = z
    .object({
      choices: z
        .array(
          z.object({
            message: z.object({
              content: z.union([
                z.string(),
                z.array(
                  z.object({
                    text: z.string().optional(),
                    type: z.string(),
                  }),
                ),
              ]),
            }),
          }),
        )
        .min(1),
    })
    .safeParse(responseBody);

  if (!parsed.success) {
    throw new QuestDomainError({
      code: "quest_unavailable",
      details: parsed.error.flatten(),
      message: "Hermes response is not a valid chat completion payload",
      statusCode: 1,
    });
  }

  const content = parsed.data.choices[0]?.message.content;
  if (typeof content === "string") {
    return content;
  }

  if (!content) {
    throw new QuestDomainError({
      code: "quest_unavailable",
      details: parsed.data.choices[0],
      message: "Hermes response did not include message content",
      statusCode: 1,
    });
  }

  return content
    .map((part) => (part.type === "text" && part.text ? part.text : ""))
    .join("")
    .trim();
}

function parseHermesResponse(rawContent: string): z.infer<typeof hermesResponseSchema> {
  const parsedJson = JSON.parse(rawContent) as unknown;
  const parsed = hermesResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new QuestDomainError({
      code: "quest_command_failed",
      details: parsed.error.flatten(),
      message: "Hermes returned an invalid write plan",
      statusCode: 1,
    });
  }

  return parsed.data;
}

async function applyHermesWrites(
  cwd: string,
  ownedPatterns: string[],
  files: Array<{ content: string; path: string }>,
): Promise<void> {
  for (const file of files) {
    const normalizedPath = normalizeHermesWritePath(file.path);
    if (!matchesOwnedPath(normalizedPath, ownedPatterns)) {
      throw new QuestDomainError({
        code: "quest_command_failed",
        details: { path: normalizedPath },
        message: `Hermes attempted to write outside owned paths: ${normalizedPath}`,
        statusCode: 1,
      });
    }

    const absolutePath = resolve(cwd, normalizedPath);
    let confinedPath: string;
    try {
      confinedPath = await assertWorkspacePathWithinRoot(
        cwd,
        absolutePath,
        `Hermes output ${normalizedPath}`,
      );
    } catch (error: unknown) {
      throw new QuestDomainError({
        code: "quest_command_failed",
        details: {
          cause: isQuestDomainError(error) ? error.details : error,
          path: normalizedPath,
        },
        message: `Hermes attempted to escape the slice workspace: ${normalizedPath}`,
        statusCode: 1,
      });
    }

    await mkdir(dirname(confinedPath), { recursive: true });
    await writeFile(confinedPath, file.content, "utf8");
  }
}

function parseProviderOptionValue(value: string): boolean | number | string | null {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (value === "null") {
    return null;
  }

  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && value.trim() !== "") {
    return asNumber;
  }

  try {
    return JSON.parse(value) as boolean | number | string | null;
  } catch {
    return value;
  }
}

function buildHermesRequestBody(
  context: RunnerExecutionContext,
  prompt: string,
  runtime: WorkerRuntimeConfig | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages: [
      {
        content: "You are Hermes running inside quest. Return strict JSON only, no markdown.",
        role: "system",
      },
      { content: prompt, role: "user" },
    ],
    model: context.worker.backend.profile,
  };

  if (runtime?.maxOutputTokens !== undefined) {
    body.max_tokens = runtime.maxOutputTokens;
  }

  if (runtime?.temperature !== undefined) {
    body.temperature = runtime.temperature;
  } else {
    body.temperature = 0.1;
  }

  if (runtime?.topP !== undefined) {
    body.top_p = runtime.topP;
  }

  if (runtime?.reasoningEffort) {
    body.reasoning_effort = runtime.reasoningEffort;
  }

  for (const [key, value] of Object.entries(runtime?.providerOptions ?? {})) {
    body[key] = parseProviderOptionValue(value);
  }

  return body;
}

/**
 * @deprecated Use {@link AcpRunnerAdapter} instead.
 * The hermes-api adapter assumes an OpenAI-compatible REST endpoint that Hermes
 * does not expose. Migrate workers to use `adapter: "acp"` with
 * `executable: "hermes acp"` for full agent capabilities.
 */
export class HermesApiRunnerAdapter implements RunnerAdapter {
  readonly name = "hermes-api";

  constructor(private readonly secretStore: SecretStore) {}

  supports(worker: RunnerExecutionContext["worker"]): boolean {
    return worker.backend.adapter === this.name;
  }

  async execute(context: RunnerExecutionContext): Promise<RunnerExecutionResult> {
    const baseUrl = context.worker.backend.baseUrl;
    if (!baseUrl) {
      throw new QuestDomainError({
        code: "quest_unavailable",
        details: { workerId: context.worker.id },
        message: `Worker ${context.worker.id} has no Hermes base URL configured`,
        statusCode: 1,
      });
    }

    const authEnv = await resolveAuthEnv(context.worker, this.secretStore);
    const apiKey =
      context.worker.backend.auth?.targetEnvVar && authEnv[context.worker.backend.auth.targetEnvVar]
        ? authEnv[context.worker.backend.auth.targetEnvVar]
        : undefined;
    const snapshots = await collectHermesFileSnapshots(context);
    const prompt = buildHermesPrompt(context, snapshots);

    const requestInit: RequestInit = {
      body: JSON.stringify(buildHermesRequestBody(context, prompt, context.worker.backend.runtime)),
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        "content-type": "application/json",
      },
      method: "POST",
    };
    const requestSignal = buildHermesSignal(context.signal, context.timeoutMs);
    if (requestSignal) {
      requestInit.signal = requestSignal;
    }

    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, requestInit);
    const responseText = await response.text();
    if (!response.ok) {
      throw new QuestDomainError({
        code: "quest_command_failed",
        details: { body: responseText, status: response.status, workerId: context.worker.id },
        message: `Hermes request failed for ${context.worker.id}`,
        statusCode: 1,
      });
    }

    const content = extractAssistantContent(JSON.parse(responseText) as unknown);
    const plan = parseHermesResponse(content);
    await applyHermesWrites(context.cwd, context.slice.owns, plan.files);

    return {
      exitCode: 0,
      stderr: "",
      stdout: content,
      summary: plan.summary,
    };
  }
}
