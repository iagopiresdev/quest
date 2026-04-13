#!/usr/bin/env bun

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type CanaryBackend = "codex" | "local-command";

type CanaryOptions = {
  backend: CanaryBackend;
  json: boolean;
  keepSession: boolean;
  root: string;
  timeoutMs: number;
};

type CanaryResult = {
  backend: CanaryBackend;
  exitCode: number;
  integrationValue: string | null;
  integrationWorkspacePath: string | null;
  logPath: string;
  repoValue: string | null;
  resultPath: string;
  root: string;
  runId: string | null;
  sessionName: string;
  sliceStatus: string | null;
  sourceRepositoryPath: string;
  stateRoot: string;
  status: "completed" | "failed";
};

type PreparedPaths = {
  binDir: string;
  canaryScriptPath: string;
  exitCodePath: string;
  launcherScriptPath: string;
  logPath: string;
  repoDir: string;
  resultPath: string;
  root: string;
  sessionName: string;
  specPath: string;
  stateRoot: string;
};

const repoRoot = resolve(import.meta.dir, "..", "..");

function parseFlag(options: CanaryOptions, argv: string[], index: number): number {
  const arg = argv[index];
  if (!arg) {
    return index;
  }

  if (arg === "--json") {
    options.json = true;
    return index;
  }

  if (arg === "--keep-session") {
    options.keepSession = true;
    return index;
  }

  if (arg === "--backend") {
    const value = argv[index + 1];
    if (value !== "codex" && value !== "local-command") {
      throw new Error(`Invalid --backend value: ${value ?? "<missing>"}`);
    }
    options.backend = value;
    return index + 1;
  }

  if (arg === "--root") {
    const value = argv[index + 1];
    if (!value) {
      throw new Error("--root requires a path");
    }
    options.root = resolve(value);
    return index + 1;
  }

  if (arg === "--timeout-ms") {
    const value = argv[index + 1];
    if (!value) {
      throw new Error("--timeout-ms requires a value");
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid --timeout-ms value: ${value}`);
    }
    options.timeoutMs = parsed;
    return index + 1;
  }

  throw new Error(`Unknown argument: ${arg}`);
}

function parseArgs(argv: string[]): CanaryOptions {
  const options: CanaryOptions = {
    backend: "local-command",
    json: false,
    keepSession: false,
    root: mkdtempSync(join(tmpdir(), "quest-fresh-install-")),
    timeoutMs: 20 * 60 * 1000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    index = parseFlag(options, argv, index);
  }

  return options;
}

function requireExecutable(command: string): void {
  const result = Bun.spawnSync({
    cmd: ["bash", "-lc", `command -v ${JSON.stringify(command)}`],
    stderr: "pipe",
    stdout: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(`Required executable not found: ${command}`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function createPreparedPaths(root: string): PreparedPaths {
  return {
    binDir: join(root, "bin"),
    canaryScriptPath: join(root, "canary.sh"),
    exitCodePath: join(root, "exit-code.txt"),
    launcherScriptPath: join(root, "launcher.sh"),
    logPath: join(root, "tmux.log"),
    repoDir: join(root, "repo"),
    resultPath: join(root, "result.json"),
    root,
    sessionName: `quest-fresh-${Date.now().toString(36)}`,
    specPath: join(root, "spec.json"),
    stateRoot: join(root, "state"),
  };
}

function buildLocalCommandWorkerJson(scriptPath: string, role: "builder" | "tester"): string {
  return JSON.stringify(
    {
      id: role === "builder" ? "builder-only" : "tester-only",
      name: role === "builder" ? "Builder" : "Tester",
      title: role === "builder" ? "Builder" : "Tester",
      class: role === "builder" ? "engineer" : "warden",
      enabled: true,
      role,
      backend: {
        runner: "custom",
        profile: `${role}-local`,
        adapter: "local-command",
        command: ["bun", scriptPath],
        toolPolicy: { allow: [], deny: [] },
      },
      persona: {
        voice: "terse",
        approach: role === "builder" ? "build" : "test",
        prompt: role === "builder" ? "Build the slice." : "Validate the slice.",
      },
      stats: {
        coding: role === "builder" ? 90 : 20,
        testing: role === "tester" ? 95 : 10,
        docs: 20,
        research: 20,
        speed: 50,
        mergeSafety: role === "tester" ? 80 : 50,
        contextEndurance: 50,
      },
      resources: {
        cpuCost: 1,
        memoryCost: 1,
        gpuCost: 0,
        maxParallel: 1,
      },
      trust: {
        rating: 0.8,
        calibratedAt: "2026-04-12T00:00:00Z",
      },
      progression: {
        level: 1,
        xp: 0,
      },
      calibration: {
        history: [],
      },
      tags: [],
    },
    null,
    2,
  );
}

function buildSpecJson(options: {
  backend: CanaryBackend;
  preferredTesterWorkerId?: string;
  preferredWorkerId: string;
}): string {
  const slice =
    options.backend === "codex"
      ? {
          id: "status-fix",
          title: "Status Fix",
          goal: "Change status.ts so it exports the string fixed instead of stale.",
          discipline: "coding" as const,
          dependsOn: [],
          owns: ["status.ts"],
          contextHints: [],
          preferredWorkerId: options.preferredWorkerId,
          acceptanceChecks: [
            {
              argv: [
                "bun",
                "-e",
                "const text = await Bun.file('status.ts').text(); process.exit(text.includes('fixed') ? 0 : 7)",
              ],
              env: {},
            },
          ],
        }
      : {
          id: "tracked-fix",
          title: "Tracked Fix",
          goal: "Update tracked.txt and validate it through a distinct tester before integration.",
          discipline: "coding" as const,
          dependsOn: [],
          owns: ["tracked.txt"],
          contextHints: [],
          preferredWorkerId: options.preferredWorkerId,
          preferredTesterWorkerId: options.preferredTesterWorkerId,
          acceptanceChecks: [
            {
              argv: [
                "bun",
                "-e",
                "const text = await Bun.file('tracked.txt').text(); process.exit(text === 'tester-fixed\\n' ? 0 : 7)",
              ],
              env: {},
            },
          ],
        };

  return JSON.stringify(
    {
      version: 1,
      title: options.backend === "codex" ? "Codex Fresh Install Canary" : "Fresh Install Canary",
      workspace: "command-center",
      maxParallel: 1,
      featureDoc: { enabled: false },
      hotspots: [],
      acceptanceChecks:
        options.backend === "codex"
          ? []
          : [
              {
                argv: [
                  "bun",
                  "-e",
                  "const text = await Bun.file('tracked.txt').text(); process.exit(text === 'tester-fixed\\n' ? 0 : 7)",
                ],
                env: {},
              },
            ],
      slices: [slice],
    },
    null,
    2,
  );
}

function buildRegisterWorkerSteps(
  backend: CanaryBackend,
  builderJsonPath?: string,
  testerJsonPath?: string,
): string[] {
  if (backend === "codex") {
    return [
      'quest setup --yes --state-root "$STATE_ROOT" --backend codex --worker-id fresh-codex --worker-name "Fresh Codex" --profile gpt-5.4 --role hybrid --reasoning-effort medium --max-output-tokens 8000 >/tmp/quest-canary-setup.json',
    ];
  }

  return [
    `cat ${shellQuote(builderJsonPath ?? "")} | quest workers upsert --registry "$STATE_ROOT/workers.json" --stdin >/tmp/quest-canary-builder.json`,
    `cat ${shellQuote(testerJsonPath ?? "")} | quest workers upsert --registry "$STATE_ROOT/workers.json" --stdin >/tmp/quest-canary-tester.json`,
  ];
}

function buildRepoSetupSteps(backend: CanaryBackend): string[] {
  if (backend === "codex") {
    return [
      "cat > status.ts <<'EOF'",
      'export const status = "stale";',
      "EOF",
      "git add status.ts",
    ];
  }

  return ["printf 'from-source\\n' > tracked.txt", "git add tracked.txt"];
}

function buildCanaryScript(options: {
  backend: CanaryBackend;
  binDir: string;
  codexHome: string | null;
  registerWorkerSteps: string[];
  repoDir: string;
  resultPath: string;
  repoSetupSteps: string[];
  specPath: string;
  stateRoot: string;
  wrapperInstallDir: string;
}): string {
  const integrationValueStep =
    options.backend === "codex"
      ? 'INTEGRATION_VALUE=$(cat "$INTEGRATION_PATH/status.ts")'
      : 'INTEGRATION_VALUE=$(cat "$INTEGRATION_PATH/tracked.txt")';
  const repoValueStep =
    options.backend === "codex" ? "REPO_VALUE=$(cat status.ts)" : "REPO_VALUE=$(cat tracked.txt)";

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `export PATH=${shellQuote(`${options.binDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}:$PATH`,
    `export STATE_ROOT=${shellQuote(options.stateRoot)}`,
    `export QUEST_RUNNER_INSTALL_BIN_DIR=${shellQuote(options.wrapperInstallDir)}`,
    options.codexHome ? `export CODEX_HOME=${shellQuote(options.codexHome)}` : "",
    `cd ${shellQuote(repoRoot)}`,
    "bun install --frozen-lockfile",
    "bun run build",
    "bun run install:local",
    'quest doctor --state-root "$STATE_ROOT" >/tmp/quest-canary-doctor.json',
    ...options.registerWorkerSteps,
    `mkdir -p ${shellQuote(options.repoDir)}`,
    `cd ${shellQuote(options.repoDir)}`,
    "git init -q",
    "git config user.email test@example.com",
    "git config user.name tester",
    ...options.repoSetupSteps,
    "git commit -q -m init",
    `RUN_JSON=$(quest run --json --state-root "$STATE_ROOT" --file ${shellQuote(options.specPath)} --source-repo "$PWD")`,
    `printf '%s' "$RUN_JSON" > /tmp/quest-canary-run-created.json`,
    `RUN_ID=$(bun -e 'const data = JSON.parse(await Bun.file(0).text()); console.log(data.run.id);' <<< "$RUN_JSON")`,
    'EXEC_JSON=$(quest runs execute --json --state-root "$STATE_ROOT" --id "$RUN_ID" --auto-integrate --target-ref HEAD)',
    `printf '%s' "$EXEC_JSON" > /tmp/quest-canary-run-executed.json`,
    'LOG_JSON=$(quest runs logs --json --state-root "$STATE_ROOT" --id "$RUN_ID")',
    `printf '%s' "$LOG_JSON" > /tmp/quest-canary-run-logs.json`,
    'INTEGRATION_PATH=$(bun -e \'const data = JSON.parse(await Bun.file(0).text()); console.log(data.run.integrationWorkspacePath ?? "");\' <<< "$EXEC_JSON")',
    integrationValueStep,
    repoValueStep,
    `cat > ${shellQuote(options.resultPath)} <<EOF`,
    "{",
    `  "runId": "${"${" + "RUN_ID}"}",`,
    '  "runStatus": $(bun -e \'const data = JSON.parse(await Bun.file(0).text()); process.stdout.write(JSON.stringify(data.run.status));\' <<< "$EXEC_JSON"),',
    '  "sliceStatus": $(bun -e \'const data = JSON.parse(await Bun.file(0).text()); process.stdout.write(JSON.stringify(data.run.slices[0]?.status ?? null));\' <<< "$EXEC_JSON"),',
    '  "integrationWorkspacePath": $(bun -e \'const data = JSON.parse(await Bun.file(0).text()); process.stdout.write(JSON.stringify(data.run.integrationWorkspacePath ?? null));\' <<< "$EXEC_JSON"),',
    `  "repoValue": $(printf '%s' "$REPO_VALUE" | bun -e 'process.stdout.write(JSON.stringify(await Bun.file(0).text()))'),`,
    `  "integrationValue": $(printf '%s' "$INTEGRATION_VALUE" | bun -e 'process.stdout.write(JSON.stringify(await Bun.file(0).text()))')`,
    "}",
    "EOF",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function buildLauncherScript(options: {
  canaryScriptPath: string;
  exitCodePath: string;
  keepSession: boolean;
  logPath: string;
}): string {
  return [
    "#!/usr/bin/env bash",
    "set +e",
    `bash ${shellQuote(options.canaryScriptPath)} > ${shellQuote(options.logPath)} 2>&1`,
    "STATUS=$?",
    `printf '%s' "$STATUS" > ${shellQuote(options.exitCodePath)}`,
    `printf '\\n[quest-runner fresh-install canary exit=%s]\\n' "$STATUS" >> ${shellQuote(options.logPath)}`,
    options.keepSession ? `exec ${"${" + "SHELL:-/bin/zsh}"} -i` : `exit "$STATUS"`,
  ].join("\n");
}

function prepareWorkspace(options: CanaryOptions, paths: PreparedPaths): void {
  Bun.spawnSync({
    cmd: ["mkdir", "-p", paths.root, paths.binDir, paths.stateRoot, paths.repoDir],
  });

  let builderJsonPath: string | undefined;
  let testerJsonPath: string | undefined;
  if (options.backend === "local-command") {
    const builderScriptPath = join(paths.root, "builder.ts");
    const testerScriptPath = join(paths.root, "tester.ts");
    writeFileSync(
      builderScriptPath,
      [
        "await Bun.write('tracked.txt', 'builder-change\\n');",
        "await Bun.write(Bun.stdout, 'builder:' + Bun.env.QUEST_SLICE_PHASE);",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      testerScriptPath,
      [
        "await Bun.write('tracked.txt', 'tester-fixed\\n');",
        "await Bun.write(Bun.stdout, 'tester:' + Bun.env.QUEST_SLICE_PHASE);",
      ].join("\n"),
      "utf8",
    );
    builderJsonPath = join(paths.root, "builder.json");
    testerJsonPath = join(paths.root, "tester.json");
    writeFileSync(
      builderJsonPath,
      buildLocalCommandWorkerJson(builderScriptPath, "builder"),
      "utf8",
    );
    writeFileSync(testerJsonPath, buildLocalCommandWorkerJson(testerScriptPath, "tester"), "utf8");
  }

  writeFileSync(
    paths.specPath,
    buildSpecJson(
      options.backend === "local-command"
        ? {
            backend: options.backend,
            preferredTesterWorkerId: "tester-only",
            preferredWorkerId: "builder-only",
          }
        : {
            backend: options.backend,
            preferredWorkerId: "fresh-codex",
          },
    ),
    "utf8",
  );

  const codexHome = Bun.env.CODEX_HOME ?? (Bun.env.HOME ? join(Bun.env.HOME, ".codex") : null);
  writeExecutable(
    paths.canaryScriptPath,
    buildCanaryScript({
      backend: options.backend,
      binDir: paths.binDir,
      codexHome,
      registerWorkerSteps: buildRegisterWorkerSteps(
        options.backend,
        builderJsonPath,
        testerJsonPath,
      ),
      repoDir: paths.repoDir,
      repoSetupSteps: buildRepoSetupSteps(options.backend),
      resultPath: paths.resultPath,
      specPath: paths.specPath,
      stateRoot: paths.stateRoot,
      wrapperInstallDir: paths.binDir,
    }),
  );
  writeExecutable(
    paths.launcherScriptPath,
    buildLauncherScript({
      canaryScriptPath: paths.canaryScriptPath,
      exitCodePath: paths.exitCodePath,
      keepSession: options.keepSession,
      logPath: paths.logPath,
    }),
  );
}

function startTmuxSession(sessionName: string, launcherScriptPath: string): void {
  const sessionResult = Bun.spawnSync({
    cmd: ["tmux", "new-session", "-d", "-s", sessionName, launcherScriptPath],
    stderr: "pipe",
    stdout: "pipe",
  });
  if (sessionResult.exitCode !== 0) {
    throw new Error(
      `Failed to start tmux session: ${Buffer.from(sessionResult.stderr).toString("utf8")}`,
    );
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const file = Bun.file(path);
    if (await file.exists()) {
      return;
    }
    await Bun.sleep(500);
  }

  throw new Error(`Timed out waiting for canary completion: ${path}`);
}

function readExitCode(path: string): number {
  return Number(readFileSync(path, "utf8").trim() || "1");
}

async function collectResult(options: CanaryOptions, paths: PreparedPaths): Promise<CanaryResult> {
  await waitForFile(paths.exitCodePath, options.timeoutMs);
  const exitCode = readExitCode(paths.exitCodePath);
  const resultFile = Bun.file(paths.resultPath);
  const resultData = (await resultFile.exists())
    ? (JSON.parse(await resultFile.text()) as {
        integrationValue: string | null;
        integrationWorkspacePath: string | null;
        repoValue: string | null;
        runId: string | null;
        sliceStatus: string | null;
      })
    : {
        integrationValue: null,
        integrationWorkspacePath: null,
        repoValue: null,
        runId: null,
        sliceStatus: null,
      };

  return {
    backend: options.backend,
    exitCode,
    integrationValue: resultData.integrationValue,
    integrationWorkspacePath: resultData.integrationWorkspacePath,
    logPath: paths.logPath,
    repoValue: resultData.repoValue,
    resultPath: paths.resultPath,
    root: paths.root,
    runId: resultData.runId,
    sessionName: paths.sessionName,
    sliceStatus: resultData.sliceStatus,
    sourceRepositoryPath: paths.repoDir,
    stateRoot: paths.stateRoot,
    status: exitCode === 0 ? "completed" : "failed",
  };
}

function printResult(result: CanaryResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `${[
      "Fresh Install Canary",
      `  backend: ${result.backend}`,
      `  status: ${result.status}`,
      `  run: ${result.runId ?? "unknown"}`,
      `  slice: ${result.sliceStatus ?? "unknown"}`,
      `  session: ${result.sessionName}`,
      `  root: ${result.root}`,
      `  state: ${result.stateRoot}`,
      `  source repo: ${result.sourceRepositoryPath}`,
      `  integration workspace: ${result.integrationWorkspacePath ?? "none"}`,
      `  source repo value: ${result.repoValue ?? "unknown"}`,
      `  integration value: ${result.integrationValue ?? "unknown"}`,
      `  log: ${result.logPath}`,
      `  result: ${result.resultPath}`,
    ].join("\n")}\n`,
  );
}

async function main(): Promise<number> {
  const options = parseArgs(Bun.argv.slice(2));
  requireExecutable("tmux");

  const paths = createPreparedPaths(options.root);
  prepareWorkspace(options, paths);
  startTmuxSession(paths.sessionName, paths.launcherScriptPath);

  try {
    const result = await collectResult(options, paths);
    printResult(result, options.json);

    if (result.exitCode !== 0) {
      process.stderr.write(`${readFileSync(paths.logPath, "utf8")}\n`);
      return result.exitCode;
    }

    return 0;
  } finally {
    if (!options.keepSession) {
      Bun.spawnSync({
        cmd: ["tmux", "kill-session", "-t", paths.sessionName],
        stderr: "ignore",
        stdout: "ignore",
      });
    }
  }
}

const exitCode = await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
});

if (exitCode !== 0) {
  process.exit(exitCode);
}
