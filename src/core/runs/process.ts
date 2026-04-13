import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export type SubprocessResult = {
  aborted: boolean;
  exitCode: number;
  stderr: string;
  stderrTruncated: boolean;
  stdout: string;
  stdoutTruncated: boolean;
  timedOut: boolean;
};

async function readPipe(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onChunk?: (() => void) | undefined,
): Promise<{ truncated: boolean; value: string }> {
  if (!stream) {
    return { truncated: false, value: "" };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    onChunk?.();

    // Capping captured output keeps one noisy worker or git command from bloating run state
    // enough to destabilize the orchestrator itself.
    if (totalBytes < maxBytes) {
      const remaining = maxBytes - totalBytes;
      if (value.byteLength <= remaining) {
        chunks.push(value);
        totalBytes += value.byteLength;
      } else {
        chunks.push(value.slice(0, remaining));
        totalBytes += remaining;
        truncated = true;
      }
    } else {
      truncated = true;
    }
  }

  const merged =
    chunks.length === 0
      ? new Uint8Array(0)
      : Uint8Array.from(chunks.flatMap((chunk) => Array.from(chunk)));
  return {
    truncated,
    value: new TextDecoder().decode(merged),
  };
}

function resolveCommandPath(cmd: string[], env: Record<string, string | undefined>): string[] {
  const executable = cmd[0];
  if (!executable || executable.includes("/")) {
    return cmd;
  }

  if (executable === "git") {
    for (const candidate of ["/usr/bin/git", "/bin/git", "/opt/homebrew/bin/git"]) {
      try {
        accessSync(candidate, constants.X_OK);
        return [candidate, ...cmd.slice(1)];
      } catch {
        // Fall through to PATH scanning when a preferred git binary is unavailable.
      }
    }
  }

  const pathValue = env.PATH ?? Bun.env.PATH ?? "";
  for (const segment of pathValue.split(delimiter)) {
    if (segment.length === 0) {
      continue;
    }

    const candidate = join(segment, executable);
    try {
      accessSync(candidate, constants.X_OK);
      return [candidate, ...cmd.slice(1)];
    } catch {
      // Keep scanning PATH entries until one resolves to an executable.
    }
  }

  return cmd;
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

type SpawnedProcess = {
  exited: Promise<number>;
  kill: () => void;
  stderr: ReadableStream<Uint8Array> | null;
  stdout: ReadableStream<Uint8Array> | null;
};

function spawnProcess(options: {
  cmd: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: Uint8Array | "ignore";
}): SpawnedProcess {
  try {
    return Bun.spawn({
      cmd: options.cmd,
      cwd: options.cwd,
      env: options.env,
      stdin: options.stdin,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error: unknown) {
    const isEnoent =
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    if (!isEnoent) {
      throw error;
    }

    // The compiled Bun binary on this machine can fail direct posix_spawn for some native
    // executables even when the path exists. Falling back to a minimal shell preserves the public
    // wrapper path without widening normal command construction elsewhere in the codebase.
    try {
      return Bun.spawn({
        cmd: ["/bin/sh", "-lc", options.cmd.map((part) => quoteShellArg(part)).join(" ")],
        cwd: options.cwd,
        env: options.env,
        stdin: options.stdin,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (fallbackError: unknown) {
      const fallbackMessage =
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(
        `Subprocess spawn failed for ${options.cmd.join(" ")} after shell fallback: ${fallbackMessage}`,
      );
    }
  }
}

export async function runSubprocess(options: {
  cmd: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  idleTimeoutMs?: number | undefined;
  maxOutputBytes?: number | undefined;
  signal?: AbortSignal | undefined;
  stdin?: string | undefined;
  timeoutMs?: number | undefined;
}): Promise<SubprocessResult> {
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
  let aborted = options.signal?.aborted === true;
  let timedOut = false;
  const resolvedCmd = resolveCommandPath(options.cmd, options.env);
  const process = spawnProcess({
    cmd: resolvedCmd,
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
  });

  const abortProcess = (): void => {
    aborted = true;
    try {
      process.kill();
    } catch {
      // Ignore kill races for already-exited processes.
    }
  };

  const abortListener = (): void => {
    abortProcess();
  };

  let idleTimeout: ReturnType<typeof setTimeout> | null = null;
  const clearIdleTimeout = (): void => {
    if (idleTimeout) {
      clearTimeout(idleTimeout);
      idleTimeout = null;
    }
  };
  const resetIdleTimeout = (): void => {
    if (options.idleTimeoutMs === undefined) {
      return;
    }

    clearIdleTimeout();
    idleTimeout = setTimeout(() => {
      timedOut = true;
      abortProcess();
    }, options.idleTimeoutMs);
  };

  options.signal?.addEventListener("abort", abortListener, { once: true });
  // Timeouts are enforced in the helper so every caller gets the same failure mode instead of
  // sprinkling ad hoc watchdog logic across adapters and git flows.
  const timeout =
    options.timeoutMs === undefined
      ? null
      : setTimeout(() => {
          timedOut = true;
          abortProcess();
        }, options.timeoutMs);
  resetIdleTimeout();

  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    readPipe(process.stdout, maxOutputBytes, resetIdleTimeout),
    readPipe(process.stderr, maxOutputBytes, resetIdleTimeout),
  ]);

  if (timeout) {
    clearTimeout(timeout);
  }
  clearIdleTimeout();
  options.signal?.removeEventListener("abort", abortListener);

  return {
    aborted,
    exitCode,
    stderr: stderr.value,
    stderrTruncated: stderr.truncated,
    stdout: stdout.value,
    stdoutTruncated: stdout.truncated,
    timedOut,
  };
}
