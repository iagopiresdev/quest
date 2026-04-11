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

export async function runSubprocess(options: {
  cmd: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  stdin?: string;
  timeoutMs?: number;
}): Promise<SubprocessResult> {
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
  let aborted = options.signal?.aborted === true;
  let timedOut = false;
  const process = Bun.spawn({
    cmd: options.cmd,
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
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

  options.signal?.addEventListener("abort", abortListener, { once: true });
  const timeout =
    options.timeoutMs === undefined
      ? null
      : setTimeout(() => {
          timedOut = true;
          abortProcess();
        }, options.timeoutMs);

  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    readPipe(process.stdout, maxOutputBytes),
    readPipe(process.stderr, maxOutputBytes),
  ]);

  if (timeout) {
    clearTimeout(timeout);
  }
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
