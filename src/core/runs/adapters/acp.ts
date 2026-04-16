/**
 * ACP (Agent Client Protocol) runner adapter.
 *
 * Spawns any ACP-compatible agent as a subprocess and communicates via
 * JSON-RPC over stdio. Uses a Node.js bridge process because Bun's
 * runtime cannot reliably read Python asyncio stdout pipes.
 *
 * @see docs/specs/acp-adapter-v1.mdx
 */

import { dirname, resolve } from "node:path";

import { QuestDomainError } from "../../errors";
import type { SecretStore } from "../../secret-store";
import { buildProcessEnv } from "../process-env";
import { buildRunnerPrompt, resolveAuthEnv } from "./shared";
import type { RunnerAdapter, RunnerExecutionContext, RunnerExecutionResult } from "./types";

type JsonRpcId = number | string;

interface JsonRpcRequest {
  id: JsonRpcId;
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown> | undefined;
}

interface JsonRpcResponse {
  error?: { code: number; data?: unknown; message: string };
  id: JsonRpcId;
  jsonrpc: "2.0";
  result?: unknown;
}

interface JsonRpcNotification {
  method?: string;
  params?: Record<string, unknown>;
}

type IncomingMessage =
  | { kind: "notification"; value: JsonRpcNotification }
  | { kind: "response"; value: JsonRpcResponse };

type QuoteMode = '"' | "'" | null;

type AcpExecutionState = {
  aborted: boolean;
  agentFinished: boolean;
  agentSummary: string;
  lastEventTime: number;
  sessionId: string | null;
  timedOut: boolean;
};

let nextRpcId = 1;

const BRIDGE_SCRIPT = resolve(dirname(new URL(import.meta.url).pathname), "acp-bridge.mjs");
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const IDLE_EVENT_TIMEOUT_MS = 120 * 1000;
const MAX_CAPTURED_STDERR = 64 * 1024;

function makeRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  const req: JsonRpcRequest = { id: nextRpcId++, jsonrpc: "2.0", method };
  if (params !== undefined) {
    req.params = params;
  }
  return req;
}

function parseIncomingLine(line: string): IncomingMessage | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if ("id" in parsed && (typeof parsed.id === "number" || typeof parsed.id === "string")) {
      return { kind: "response", value: parsed as unknown as JsonRpcResponse };
    }
    return { kind: "notification", value: parsed as unknown as JsonRpcNotification };
  } catch {
    return null;
  }
}

export function parseExecutableCommand(command: string): string[] {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    throw new QuestDomainError({
      code: "quest_runner_unavailable",
      details: { command },
      message: "ACP executable command is empty",
      statusCode: 1,
    });
  }

  const args: string[] = [];
  let current = "";
  let quote: QuoteMode = null;
  let escaping = false;
  let tokenStarted = false;

  const pushCurrent = (): void => {
    if (!tokenStarted) {
      return;
    }

    args.push(current);
    current = "";
    tokenStarted = false;
  };

  for (const char of trimmed) {
    if (escaping) {
      current += char;
      escaping = false;
      tokenStarted = true;
      continue;
    }

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\") {
        escaping = true;
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      tokenStarted = true;
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (escaping || quote !== null) {
    throw new QuestDomainError({
      code: "quest_runner_unavailable",
      details: { command },
      message: `ACP executable command has invalid quoting: ${command}`,
      statusCode: 1,
    });
  }

  pushCurrent();
  return args;
}

function buildInitializeRequest(): JsonRpcRequest {
  return makeRequest("initialize", {
    clientCapabilities: {},
    clientInfo: { name: "quest-runner", version: "0.1.0" },
    protocolVersion: 1,
  });
}

function buildNewSessionRequest(cwd: string, model?: string): JsonRpcRequest {
  return makeRequest("session/new", {
    cwd,
    mcpServers: [],
    ...(model ? { model } : {}),
  });
}

function buildPromptRequest(sessionId: string, message: string): JsonRpcRequest {
  return makeRequest("session/prompt", {
    prompt: [{ text: message, type: "text" }],
    sessionId,
  });
}

function buildEndSessionRequest(sessionId: string): JsonRpcRequest {
  return makeRequest("session/close", { sessionId });
}

function killProcess(proc: ReturnType<typeof Bun.spawn>): void {
  try {
    proc.kill();
  } catch {
    // Ignore races when the child is already gone.
  }
}

function startStderrCapture(
  proc: ReturnType<typeof Bun.spawn>,
  capturedStderr: string[],
): Promise<void> {
  return (async () => {
    const stderrStream = proc.stderr;
    if (!stderrStream || !(stderrStream instanceof ReadableStream)) {
      return;
    }

    const reader = stderrStream.getReader();
    const dec = new TextDecoder();
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        const text = dec.decode(value, { stream: true });
        if (totalBytes < MAX_CAPTURED_STDERR) {
          capturedStderr.push(text);
          totalBytes += text.length;
        }
      }
    } catch {
      // Stderr capture is best-effort only.
    } finally {
      reader.releaseLock();
    }
  })();
}

async function* readStdoutMessages(
  proc: ReturnType<typeof Bun.spawn>,
): AsyncGenerator<IncomingMessage> {
  const stdoutStream = proc.stdout instanceof ReadableStream ? proc.stdout : null;
  if (!stdoutStream) {
    return;
  }

  const reader = stdoutStream.getReader();
  const dec = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        for (const line of buffer.split("\n")) {
          const msg = parseIncomingLine(line);
          if (msg) {
            yield msg;
          }
        }
        return;
      }

      buffer += dec.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const msg = parseIncomingLine(line);
        if (msg) {
          yield msg;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function createMessageSender(stdinSink: Bun.FileSink | number | null): {
  send: (msg: JsonRpcRequest) => void;
  sendNotification: (method: string) => void;
} {
  return {
    send: (msg: JsonRpcRequest): void => {
      if (!stdinSink || typeof stdinSink === "number") {
        return;
      }

      stdinSink.write(`${JSON.stringify(msg)}\n`);
      stdinSink.flush();
    },
    sendNotification: (method: string): void => {
      if (!stdinSink || typeof stdinSink === "number") {
        return;
      }

      stdinSink.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
      stdinSink.flush();
    },
  };
}

function updateAgentSummaryFromNotification(
  notification: JsonRpcNotification,
  state: AcpExecutionState,
): void {
  extractNotificationSummary(notification, (text) => {
    state.agentSummary = text;
  });
}

async function waitForResponse(
  expectedId: JsonRpcId,
  iter: AsyncGenerator<IncomingMessage>,
  workerId: string,
  state: AcpExecutionState,
): Promise<JsonRpcResponse> {
  for await (const incoming of iter) {
    if (incoming.kind === "response" && incoming.value.id === expectedId) {
      return incoming.value;
    }

    if (incoming.kind === "notification") {
      state.lastEventTime = Date.now();
      updateAgentSummaryFromNotification(incoming.value, state);
    }
  }

  throw new QuestDomainError({
    code: "quest_runner_unavailable",
    details: { expectedId, workerId },
    message: `ACP agent closed before responding to request ${expectedId}`,
    statusCode: 1,
  });
}

async function driveAcpSession(
  context: RunnerExecutionContext,
  stdoutIter: AsyncGenerator<IncomingMessage>,
  sender: ReturnType<typeof createMessageSender>,
  state: AcpExecutionState,
  prompt: string,
): Promise<void> {
  try {
    const initReq = buildInitializeRequest();
    sender.send(initReq);
    const initResp = await waitForResponse(initReq.id, stdoutIter, context.worker.id, state);
    if (initResp.error) {
      throw new QuestDomainError({
        code: "quest_runner_unavailable",
        details: initResp.error,
        message: `ACP initialize failed for ${context.worker.id}: ${initResp.error.message}`,
        statusCode: 1,
      });
    }

    sender.sendNotification("notifications/initialized");

    const newSessReq = buildNewSessionRequest(
      context.cwd,
      context.worker.backend.profile || undefined,
    );
    sender.send(newSessReq);
    const newSessResp = await waitForResponse(newSessReq.id, stdoutIter, context.worker.id, state);
    if (newSessResp.error) {
      throw new QuestDomainError({
        code: "quest_runner_unavailable",
        details: newSessResp.error,
        message: `ACP session/new failed for ${context.worker.id}: ${newSessResp.error.message}`,
        statusCode: 1,
      });
    }

    const sessResult = newSessResp.result as Record<string, unknown> | undefined;
    state.sessionId = (sessResult?.sessionId ?? sessResult?.session_id ?? "") as string;
    if (!state.sessionId) {
      throw new QuestDomainError({
        code: "quest_runner_unavailable",
        details: { response: newSessResp.result, workerId: context.worker.id },
        message: `ACP session/new did not return a session ID for ${context.worker.id}`,
        statusCode: 1,
      });
    }

    const promptReq = buildPromptRequest(state.sessionId, prompt);
    sender.send(promptReq);
    const promptResp = await waitForResponse(promptReq.id, stdoutIter, context.worker.id, state);
    if (promptResp.error) {
      throw new QuestDomainError({
        code: "quest_runner_command_failed",
        details: promptResp.error,
        message: `ACP session/prompt failed for ${context.worker.id}: ${promptResp.error.message}`,
        statusCode: 1,
      });
    }

    const respResult = promptResp.result as Record<string, unknown> | undefined;
    if (respResult) {
      const text = extractResponseText(respResult);
      if (text) {
        state.agentSummary = text;
      }
    }
    state.agentFinished = true;
  } finally {
    if (state.sessionId) {
      try {
        sender.send(buildEndSessionRequest(state.sessionId));
      } catch {
        // Session close is best-effort after terminal errors.
      }
    }
  }
}

async function cleanupAcpProcess(
  proc: ReturnType<typeof Bun.spawn>,
  pid: number | null,
  context: RunnerExecutionContext,
  stdinSink: Bun.FileSink | number | null,
  stderrPromise: Promise<void> | null,
  capturedStderr: string[],
): Promise<{ exitCode: number; stderr: string }> {
  try {
    if (stdinSink && typeof stdinSink !== "number") {
      stdinSink.end();
    }
  } catch {
    // Ignore close races when the pipe is already gone.
  }

  const exitPromise = proc.exited;
  const killTimer = setTimeout(() => {
    killProcess(proc);
  }, 5000);
  const exitCode = await exitPromise;
  clearTimeout(killTimer);
  await stderrPromise;

  if (pid !== null) {
    await context.onSubprocessExit?.(pid);
  }

  return {
    exitCode,
    stderr: capturedStderr.join("").slice(0, MAX_CAPTURED_STDERR),
  };
}

export class AcpRunnerAdapter implements RunnerAdapter {
  readonly name = "acp";

  constructor(private readonly secretStore: SecretStore) {}

  supports(worker: RunnerExecutionContext["worker"]): boolean {
    return worker.backend.adapter === this.name;
  }

  async execute(context: RunnerExecutionContext): Promise<RunnerExecutionResult> {
    const executable = context.worker.backend.executable;
    if (!executable) {
      throw new QuestDomainError({
        code: "quest_runner_unavailable",
        details: { workerId: context.worker.id },
        message: `ACP adapter requires backend.executable for worker ${context.worker.id}`,
        statusCode: 1,
      });
    }

    const authEnv = await resolveAuthEnv(context.worker, this.secretStore);
    const env = buildProcessEnv({
      ...context.worker.backend.env,
      ...authEnv,
      QUEST_RUN_ID: context.run.id,
      QUEST_SLICE_ID: context.slice.id,
      QUEST_SLICE_PHASE: context.phase,
      QUEST_SLICE_WORKSPACE: context.sliceState.workspacePath ?? context.cwd,
      QUEST_WORKER_ID: context.worker.id,
      QUEST_WORKSPACE: context.run.spec.workspace,
      QUEST_WORKSPACE_ROOT: context.run.workspaceRoot ?? "",
    });
    const agentCmdParts = parseExecutableCommand(executable);
    const timeoutMs = context.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const idleTimeoutMs = context.idleTimeoutMs ?? IDLE_EVENT_TIMEOUT_MS;

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn({
        cmd: ["node", BRIDGE_SCRIPT, ...agentCmdParts],
        cwd: context.cwd,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new QuestDomainError({
        code: "quest_runner_unavailable",
        details: { executable, message, workerId: context.worker.id },
        message: `Failed to spawn ACP agent for worker ${context.worker.id}: ${message}`,
        statusCode: 1,
      });
    }

    const pid = typeof proc.pid === "number" ? proc.pid : null;
    if (pid !== null) {
      await context.onSubprocessSpawn?.(agentCmdParts, pid);
    }

    const prompt = buildRunnerPrompt(context);
    const capturedStderr: string[] = [];
    const state: AcpExecutionState = {
      aborted: false,
      agentFinished: false,
      agentSummary: "",
      lastEventTime: Date.now(),
      sessionId: null,
      timedOut: false,
    };
    let stdinSink: Bun.FileSink | number | null = null;
    let executionError: unknown = null;
    let exitCode = 0;
    let stderr = "";
    let stderrPromise: Promise<void> | null = null;

    const timeoutTimer = setTimeout(() => {
      state.timedOut = true;
      killProcess(proc);
    }, timeoutMs);
    const idleTimer = setInterval(() => {
      if (Date.now() - state.lastEventTime > idleTimeoutMs) {
        state.timedOut = true;
        killProcess(proc);
      }
    }, 5_000);
    const onExternalAbort = (): void => {
      state.aborted = true;
      killProcess(proc);
    };
    context.signal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      stderrPromise = startStderrCapture(proc, capturedStderr);
      stdinSink = proc.stdin ?? null;
      const stdoutIter = readStdoutMessages(proc);
      const sender = createMessageSender(stdinSink);
      await driveAcpSession(context, stdoutIter, sender, state, prompt);
    } catch (error: unknown) {
      executionError = error;
    } finally {
      clearTimeout(timeoutTimer);
      clearInterval(idleTimer);
      context.signal?.removeEventListener("abort", onExternalAbort);

      const cleaned = await cleanupAcpProcess(
        proc,
        pid,
        context,
        stdinSink,
        stderrPromise,
        capturedStderr,
      );
      exitCode = cleaned.exitCode;
      stderr = cleaned.stderr;
    }

    if (executionError) {
      throw executionError;
    }

    if ((state.timedOut || state.aborted) && !state.agentFinished) {
      throw new QuestDomainError({
        code: state.timedOut ? "quest_subprocess_timed_out" : "quest_subprocess_aborted",
        details: { executable, timedOut: state.timedOut, workerId: context.worker.id },
        message: `ACP agent was ${state.timedOut ? "timed out" : "aborted"} for ${context.worker.id}`,
        statusCode: 1,
      });
    }

    if (exitCode !== 0) {
      throw new QuestDomainError({
        code: "quest_runner_command_failed",
        details: {
          command: agentCmdParts,
          exitCode,
          stderr,
          workerId: context.worker.id,
        },
        message: `ACP agent command failed for ${context.worker.id} with exit code ${exitCode}`,
        statusCode: 1,
      });
    }

    if (!state.agentSummary) {
      state.agentSummary = `ACP agent completed slice ${context.slice.id}`;
    }

    return {
      exitCode,
      stderr,
      stdout: state.agentSummary,
      summary: state.agentSummary,
    };
  }
}

function extractNotificationSummary(
  notification: JsonRpcNotification,
  onText: (text: string) => void,
): void {
  const params = notification.params;
  if (!params || typeof params !== "object") {
    return;
  }

  if (
    notification.method === "session/update" ||
    notification.method === "agent/message" ||
    notification.method === "message"
  ) {
    const update = params.update as Record<string, unknown> | undefined;
    const content = (update?.content ?? params.content) as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          onText(block.text);
        }
      }
    }
  }
}

function extractResponseText(result: Record<string, unknown>): string | null {
  const content = result.content as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        texts.push(block.text);
      }
    }
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }

  if (typeof result.message === "string" && result.message.trim()) {
    return result.message;
  }

  if (typeof result.summary === "string" && result.summary.trim()) {
    return result.summary;
  }

  return null;
}
