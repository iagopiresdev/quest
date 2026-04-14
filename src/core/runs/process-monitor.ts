function isSystemError(error: unknown): error is NodeJS.ErrnoException & { code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (isSystemError(error) && error.code === "ESRCH") {
      return false;
    }

    return true;
  }
}

export async function terminatePid(
  pid: number,
  options: { forceAfterMs?: number | undefined; signal?: NodeJS.Signals | number | undefined } = {},
): Promise<boolean> {
  const signal = options.signal ?? "SIGTERM";
  const forceAfterMs = options.forceAfterMs ?? 500;

  if (!isPidAlive(pid)) {
    return false;
  }

  try {
    process.kill(pid, signal);
  } catch (error: unknown) {
    if (isSystemError(error) && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }

  await Bun.sleep(forceAfterMs);
  if (!isPidAlive(pid)) {
    return true;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch (error: unknown) {
    if (isSystemError(error) && error.code === "ESRCH") {
      return true;
    }
    throw error;
  }

  await Bun.sleep(100);
  return !isPidAlive(pid);
}
