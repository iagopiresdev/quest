import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { QuestCommandSpec, QuestSliceSpec, QuestSpec } from "../src/core/planning/spec-schema";
import type { RegisteredWorker, WorkerRunner } from "../src/core/workers/schema";

export type CliTestContext = {
  secretServiceName: string;
  stateRoot: string;
};

export type CliResult = {
  code: number | null;
  stderr: string;
  stdout: string;
};

const cliArgs = ["./src/cli.ts"];
const projectRoot = import.meta.dir.replace(/\/test$/, "");
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function createTempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupTempRoot(root: string): void {
  rmSync(root, { force: true, recursive: true });
}

export function runCommandOrThrow(cmd: string[], cwd: string): void {
  const result = Bun.spawnSync({
    cmd,
    cwd,
    env: Bun.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${cmd.join(" ")}\n${new TextDecoder().decode(result.stderr)}`);
  }
}

export function createCommittedRepo(root: string): string {
  const repositoryRoot = join(root, "source-repo");
  mkdirSync(repositoryRoot, { recursive: true });
  runCommandOrThrow(["git", "init"], repositoryRoot);
  runCommandOrThrow(["git", "config", "user.name", "Quest Runner"], repositoryRoot);
  runCommandOrThrow(["git", "config", "user.email", "quest-runner@example.com"], repositoryRoot);
  writeFileSync(join(repositoryRoot, "tracked.txt"), "from-source-repo\n", "utf8");
  runCommandOrThrow(["git", "add", "tracked.txt"], repositoryRoot);
  runCommandOrThrow(["git", "commit", "-m", "Initial commit"], repositoryRoot);
  return repositoryRoot;
}

export function createCliContext(): CliTestContext {
  return {
    secretServiceName: `quest-runner-test-${crypto.randomUUID()}`,
    stateRoot: createTempRoot("quest-cli-"),
  };
}

export function createCalibrationCommandScript(root: string): string {
  const scriptPath = join(root, "calibration-worker.ts");
  writeFileSync(
    scriptPath,
    [
      "const sliceId = Bun.env.QUEST_SLICE_ID;",
      "const workspace = Bun.env.QUEST_SLICE_WORKSPACE;",
      "",
      "if (!sliceId || !workspace) {",
      '  throw new Error("missing quest runner slice context");',
      "}",
      "",
      "switch (sliceId) {",
      '  case "fix-sum": {',
      '    const path = workspace + "/src/sum.ts";',
      "    const text = await Bun.file(path).text();",
      '    await Bun.write(path, text.replace("a + b + 1", "a + b"));',
      '    console.log("fixed sum implementation");',
      "    break;",
      "  }",
      '  case "add-empty-echo-test": {',
      '    const path = workspace + "/test/echo.test.ts";',
      "    const text = await Bun.file(path).text();",
      '    if (!text.includes("echo(\\"\\"")) {',
      "      await Bun.write(",
      "        path,",
      '        text.trimEnd() + \'\\n\\ntest("echo keeps empty strings stable", () => {\\n  expect(echo("")).toBe("");\\n});\\n\',',
      "      );",
      "    }",
      '    console.log("added empty echo regression test");',
      "    break;",
      "  }",
      '  case "update-readme": {',
      '    const path = workspace + "/README.md";',
      "    await Bun.write(",
      "      path,",
      '      ["# Training Grounds", "", "The `sum(a, b)` helper returns the exact arithmetic sum.", ""].join("\\n"),',
      "    );",
      '    console.log("updated readme");',
      "    break;",
      "  }",
      "  default:",
      '    throw new Error("unexpected slice: " + sliceId);',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  return scriptPath;
}

export function createCodexMockExecutable(
  root: string,
  options: { loginOk?: boolean; version?: string } = {},
): string {
  const scriptPath = join(root, "codex-mock.sh");
  const version = options.version ?? "codex 0.0.0-test";
  const loginOk = options.loginOk ?? true;
  writeFileSync(
    scriptPath,
    [
      "#!/bin/sh",
      "set -eu",
      'if [ "$1" = "--version" ]; then',
      `  printf '%s\\n' '${version}'`,
      "  exit 0",
      "fi",
      'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
      loginOk ? "  printf 'logged in\\n'" : "  printf 'not logged in\\n' >&2",
      loginOk ? "  exit 0" : "  exit 1",
      "fi",
      "printf 'unsupported codex mock command\\n' >&2",
      "exit 1",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  return scriptPath;
}

export function createOpenClawMockExecutable(
  root: string,
  options: {
    agents?: Array<{ id: string; model?: string }>;
    agentId?: string;
    captureArgsPath?: string | undefined;
    captureDeleteArgsPath?: string | undefined;
    gatewayReachable?: boolean;
    jsonToStderr?: boolean;
    noisyAgent?: boolean;
    noisyAgentsList?: boolean;
    richAgentsList?: boolean;
    noisyStatus?: boolean;
    payloadText?: string;
    transientStatusFailures?: number;
    version?: string;
    writeFile?: { content: string; path: string } | undefined;
  } = {},
): string {
  const scriptPath = join(root, "openclaw-mock.sh");
  const version = options.version ?? "OpenClaw 0.0.0-test";
  const agentId = options.agentId ?? "main";
  const agents = options.agents ?? [
    { id: agentId, model: "openai-codex/gpt-5.4" },
    { id: "codex", model: "openai-codex/gpt-5.4" },
  ];
  const captureArgsPath = options.captureArgsPath;
  const captureDeleteArgsPath = options.captureDeleteArgsPath;
  const gatewayReachable = options.gatewayReachable ?? true;
  const jsonToStderr = options.jsonToStderr ?? false;
  const noisyAgent = options.noisyAgent ?? false;
  const noisyAgentsList = options.noisyAgentsList ?? false;
  const richAgentsList = options.richAgentsList ?? false;
  const noisyStatus = options.noisyStatus ?? false;
  const payloadText = options.payloadText ?? "OpenClaw updated the workspace";
  const statusCountPath = join(root, "openclaw-status-count");
  const transientStatusFailures = options.transientStatusFailures ?? 0;
  const writeFile = options.writeFile;
  const mutationBlock = writeFile
    ? [
        `  target="$QUEST_SLICE_WORKSPACE/${writeFile.path}"`,
        '  mkdir -p "$(dirname "$target")"',
        `  cat <<'EOF' > "$target"`,
        writeFile.content,
        "EOF",
      ].join("\n")
    : "  :";

  writeFileSync(
    scriptPath,
    [
      "#!/bin/sh",
      "set -eu",
      'if [ "$1" = "--version" ]; then',
      `  printf '%s\\n' '${version}'`,
      "  exit 0",
      "fi",
      'if [ "$1" = "status" ] && [ "$2" = "--json" ]; then',
      `  count_file='${statusCountPath}'`,
      "  status_count=0",
      '  if [ -f "$count_file" ]; then status_count="$(cat "$count_file")"; fi',
      "  status_count=$((status_count + 1))",
      '  printf "%s" "$status_count" > "$count_file"',
      `  if [ "$status_count" -le ${transientStatusFailures} ]; then`,
      "    cat <<'EOF'",
      JSON.stringify({
        gateway: { reachable: false },
        agents: { agents: agents.map((agent) => ({ id: agent.id })) },
      }),
      "EOF",
      "    exit 1",
      "  fi",
      ...(noisyStatus ? ["  printf 'plugins booted\\n'"] : []),
      "  cat <<'EOF'",
      JSON.stringify({
        gateway: { reachable: gatewayReachable },
        agents: { agents: agents.map((agent) => ({ id: agent.id })) },
      }),
      "EOF",
      gatewayReachable ? "  exit 0" : "  exit 1",
      "fi",
      'if [ "$1" = "agents" ] && [ "$2" = "list" ] && [ "$3" = "--json" ]; then',
      ...(noisyAgentsList ? ["  printf 'plugins booted\\n'"] : []),
      "  cat <<'EOF'",
      JSON.stringify(
        agents.map((agent) => ({
          ...(richAgentsList
            ? {
                agentDir: `/tmp/openclaw-${agent.id}/agent`,
                bindings: 0,
                identityEmoji: "🔥",
                identityName: agent.id,
                identitySource: "identity",
                isDefault: agent.id === agentId,
                name: agent.id,
                providers: ["test"],
                routes: ["default"],
              }
            : {}),
          id: agent.id,
          model: agent.model ?? null,
          workspace: `/tmp/openclaw-${agent.id}`,
        })),
      ),
      "EOF",
      "  exit 0",
      "fi",
      'if [ "$1" = "agents" ] && [ "$2" = "add" ]; then',
      "  cat <<'EOF'",
      JSON.stringify({ ok: true }),
      "EOF",
      "  exit 0",
      "fi",
      'if [ "$1" = "agents" ] && [ "$2" = "delete" ]; then',
      ...(captureDeleteArgsPath ? [`  printf '%s\\n' "$*" > '${captureDeleteArgsPath}'`] : []),
      "  cat <<'EOF'",
      JSON.stringify({ ok: true }),
      "EOF",
      "  exit 0",
      "fi",
      'if [ "$1" = "agent" ]; then',
      ...(captureArgsPath ? [`  printf '%s\\n' "$*" > '${captureArgsPath}'`] : []),
      mutationBlock,
      ...(noisyAgent ? ["  printf 'plugins booted\\n'"] : []),
      jsonToStderr ? "  cat >&2 <<'EOF'" : "  cat <<'EOF'",
      JSON.stringify({
        result: {
          payloads: [{ text: payloadText }],
          summary: "OpenClaw completed the slice",
        },
      }),
      "EOF",
      "  exit 0",
      "fi",
      "printf 'unsupported openclaw mock command\\n' >&2",
      "exit 1",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  return scriptPath;
}

export function runCli(
  context: CliTestContext,
  args: string[],
  options: { env?: Record<string, string | undefined>; input?: string } = {},
): CliResult {
  const result = Bun.spawnSync({
    cmd: ["bun", ...cliArgs, ...args],
    cwd: projectRoot,
    env: {
      ...Bun.env,
      ...options.env,
      QUEST_RUNNER_STATE_ROOT: context.stateRoot,
      QUEST_RUNNER_WORKER_REGISTRY_PATH: join(context.stateRoot, "workers.json"),
      QUEST_RUNNER_SECRET_STORE_SERVICE_NAME: context.secretServiceName,
    },
    stdin: options.input ? textEncoder.encode(options.input) : null,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    code: result.exitCode,
    stderr: textDecoder.decode(result.stderr),
    stdout: textDecoder.decode(result.stdout),
  };
}

export async function runCliAsync(
  context: CliTestContext,
  args: string[],
  options: { env?: Record<string, string | undefined>; input?: string } = {},
): Promise<CliResult> {
  const process = Bun.spawn({
    cmd: ["bun", ...cliArgs, ...args],
    cwd: projectRoot,
    env: {
      ...Bun.env,
      ...options.env,
      QUEST_RUNNER_STATE_ROOT: context.stateRoot,
      QUEST_RUNNER_WORKER_REGISTRY_PATH: join(context.stateRoot, "workers.json"),
      QUEST_RUNNER_SECRET_STORE_SERVICE_NAME: context.secretServiceName,
    },
    stdin: options.input ? textEncoder.encode(options.input) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  return {
    code,
    stderr,
    stdout,
  };
}

export function spawnCli(
  context: CliTestContext,
  args: string[],
  options: { env?: Record<string, string | undefined>; input?: string } = {},
) {
  return Bun.spawn({
    cmd: ["bun", ...cliArgs, ...args],
    cwd: projectRoot,
    env: {
      ...Bun.env,
      ...options.env,
      QUEST_RUNNER_STATE_ROOT: context.stateRoot,
      QUEST_RUNNER_WORKER_REGISTRY_PATH: join(context.stateRoot, "workers.json"),
      QUEST_RUNNER_SECRET_STORE_SERVICE_NAME: context.secretServiceName,
    },
    stdin: options.input ? textEncoder.encode(options.input) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function reserveLocalPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to reserve a local test port"));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

export async function startTestServer(options: {
  fetch: (request: Request) => Promise<Response> | Response;
}): Promise<{ port: number; stop(force?: boolean): Promise<void> } | null> {
  let port: number;
  try {
    port = await reserveLocalPort();
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EPERM") {
      return null;
    }

    throw error;
  }
  const server = createHttpServer(async (request, response) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) {
        continue;
      }

      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }

    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    const url = `http://127.0.0.1:${port}${request.url ?? "/"}`;
    const init: RequestInit = {
      headers,
      ...(request.method ? { method: request.method } : {}),
      ...(body ? { body } : {}),
    };
    const reply = await options.fetch(new Request(url, init));

    response.statusCode = reply.status;
    reply.headers.forEach((value, key) => {
      response.setHeader(key, value);
    });
    response.end(Buffer.from(await reply.arrayBuffer()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    port,
    async stop(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

export function createWorker(
  overrides: Partial<RegisteredWorker> = {},
  backendOverrides: Partial<RegisteredWorker["backend"]> = {},
): RegisteredWorker {
  const base: RegisteredWorker = {
    backend: {
      adapter: "local-cli",
      profile: "gpt-5.4",
      runner: "codex",
      toolPolicy: { allow: [], deny: [] },
    },
    calibration: {
      history: [],
    },
    class: "engineer",
    enabled: true,
    id: "ember",
    name: "Ember",
    persona: {
      approach: "test-first",
      prompt: "Keep diffs tight and explain tradeoffs briefly.",
      voice: "terse",
    },
    progression: {
      level: 7,
      xp: 1840,
    },
    role: "hybrid",
    resources: {
      cpuCost: 2,
      gpuCost: 0,
      maxParallel: 1,
      memoryCost: 3,
    },
    stats: {
      coding: 82,
      contextEndurance: 58,
      docs: 44,
      mergeSafety: 79,
      research: 51,
      speed: 63,
      testing: 77,
    },
    tags: ["typescript"],
    title: "Battle Engineer",
    trust: {
      calibratedAt: "2026-04-10T00:00:00Z",
      rating: 0.74,
    },
  };

  return {
    ...base,
    ...overrides,
    backend: {
      ...base.backend,
      ...overrides.backend,
      ...backendOverrides,
      toolPolicy: {
        ...base.backend.toolPolicy,
        ...overrides.backend?.toolPolicy,
        ...backendOverrides.toolPolicy,
      },
    },
    persona: {
      ...base.persona,
      ...overrides.persona,
    },
    progression: {
      ...base.progression,
      ...overrides.progression,
    },
    resources: {
      ...base.resources,
      ...overrides.resources,
    },
    stats: {
      ...base.stats,
      ...overrides.stats,
    },
    trust: {
      ...base.trust,
      ...overrides.trust,
    },
  };
}

export function createWorkerJson(
  overrides: Partial<RegisteredWorker> = {},
  backendOverrides: Partial<RegisteredWorker["backend"]> = {},
): string {
  return JSON.stringify(createWorker(overrides, backendOverrides));
}

export function createLocalCommandWorkerJson(id: string, command: string[]): string {
  return createWorkerJson(
    {
      id,
      name: id,
      title: "Training Ground Worker",
    },
    {
      adapter: "local-command",
      command,
      profile: "local-command",
      runner: "custom",
    },
  );
}

export function createWorkerForRunner(
  id: string,
  runner: WorkerRunner = "codex",
  backendOverrides: Partial<RegisteredWorker["backend"]> = {},
): RegisteredWorker {
  return createWorker(
    {
      class: runner === "hermes" ? "tester" : "engineer",
      id,
      name: id,
      progression: { level: 1, xp: 0 },
      role: "hybrid",
      resources: {
        cpuCost: 1,
        gpuCost: runner === "hermes" ? 1 : 0,
        maxParallel: 1,
        memoryCost: 1,
      },
      stats: {
        coding: 80,
        contextEndurance: 60,
        docs: 40,
        mergeSafety: 75,
        research: 50,
        speed: 65,
        testing: runner === "hermes" ? 90 : 55,
      },
      tags: [],
      title: "Worker",
      trust: {
        calibratedAt: "2026-04-11T00:00:00Z",
        rating: 0.75,
      },
    },
    {
      adapter: "local-cli",
      profile: runner === "hermes" ? "qwen3.5-27b" : "gpt-5.4",
      runner,
      ...backendOverrides,
    },
  );
}

export function createSlice(overrides: Partial<QuestSliceSpec> = {}): QuestSliceSpec {
  return {
    acceptanceChecks: [],
    contextHints: [],
    dependsOn: [],
    discipline: "coding",
    goal: "Implement parser changes",
    id: "parser",
    owns: ["src/security/url.ts"],
    title: "Parser",
    ...overrides,
  };
}

export function createCommand(argv: string[], env: Record<string, string> = {}): QuestCommandSpec {
  return { argv, env };
}

export function createSpec(
  overrides: Partial<Omit<QuestSpec, "slices">> & { slices?: QuestSliceSpec[] } = {},
): QuestSpec {
  return {
    acceptanceChecks: [],
    execution: {
      preInstall: false,
      shareSourceDependencies: true,
      testerSelectionStrategy: "balanced",
      timeoutMinutes: 20,
    },
    featureDoc: { enabled: false },
    hotspots: [],
    maxParallel: 1,
    slices: overrides.slices ?? [createSlice()],
    title: "Quest Run",
    version: 1,
    workspace: "command-center",
    ...overrides,
  };
}
