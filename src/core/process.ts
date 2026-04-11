export type SubprocessResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

async function readPipe(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return "";
  }

  return await new Response(stream).text();
}

export async function runSubprocess(options: {
  cmd: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdin?: string;
}): Promise<SubprocessResult> {
  const process = Bun.spawn({
    cmd: options.cmd,
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    readPipe(process.stdout),
    readPipe(process.stderr),
  ]);

  return {
    exitCode,
    stderr,
    stdout,
  };
}
