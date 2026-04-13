const DEFAULT_PATH =
  "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";

const ALLOWED_HOST_ENV_KEYS = [
  "CI",
  "COLORTERM",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

type ProcessEnvValue = string | undefined;

function sanitizeEntries(source: Record<string, ProcessEnvValue>): Record<string, string> {
  const entries = Object.entries(source).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );

  return Object.fromEntries(entries);
}

export function buildProcessEnv(
  explicitOverrides: Record<string, ProcessEnvValue> = {},
): Record<string, string> {
  const baseEnv: Record<string, ProcessEnvValue> = {};

  // Worker and git subprocesses should not inherit the caller's full environment by default.
  // Keeping this allowlist narrow reduces accidental secret leakage and ambient behavior drift.
  for (const key of ALLOWED_HOST_ENV_KEYS) {
    baseEnv[key] = Bun.env[key];
  }

  const merged = sanitizeEntries({
    ...baseEnv,
    ...explicitOverrides,
    PATH: explicitOverrides.PATH ?? baseEnv.PATH ?? DEFAULT_PATH,
  });

  return merged;
}
