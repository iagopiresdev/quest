const architectureRuleViolations: string[] = [];

const projectRoot = new URL("..", import.meta.url);
const sourceRoot = new URL("../src", import.meta.url);
const defaultedPolicyParamPattern = /\b(?:phase|role)\s*:\s*[^)=\n]+\s*=\s*["'][A-Za-z0-9_-]+["']/g;
const recordCastPattern = /\bas\s+Record<string,\s*unknown>/g;
const forbiddenWireApiChatPattern = /\bwire_api\s*=\s*["']chat["']/;
const forbiddenConfigFilePattern = /\.(?:cjs|js|json|md|mdx|mjs|sh|toml|ts|tsx|yaml|yml)$/;
const ignoredProjectPathSegments = new Set([
  ".codex",
  ".git",
  ".openclaw",
  ".quest-runner",
  "coverage",
  "dist",
  "node_modules",
]);

async function collectTypeScriptFiles(root: URL): Promise<string[]> {
  const files: string[] = [];

  for await (const entry of new Bun.Glob("**/*.ts").scan({
    absolute: true,
    cwd: Bun.fileURLToPath(root),
    onlyFiles: true,
  })) {
    files.push(entry);
  }

  return files.sort();
}

async function collectProjectConfigFiles(root: URL): Promise<string[]> {
  const projectPath = Bun.fileURLToPath(root);
  const visibleFiles = Bun.spawnSync({
    cmd: ["git", "-C", projectPath, "ls-files", "--cached", "--others", "--exclude-standard"],
    stderr: "ignore",
    stdout: "pipe",
  });
  if (visibleFiles.exitCode === 0) {
    return new TextDecoder()
      .decode(visibleFiles.stdout)
      .split("\n")
      .filter((entry) => forbiddenConfigFilePattern.test(entry))
      .map((entry) => `${projectPath}/${entry}`)
      .sort();
  }

  const files: string[] = [];

  for await (const entry of new Bun.Glob("**/*").scan({
    absolute: true,
    cwd: projectPath,
    onlyFiles: true,
  })) {
    const relativeSegments = relativeToProject(entry).split("/");
    if (relativeSegments.some((segment) => ignoredProjectPathSegments.has(segment))) {
      continue;
    }
    if (!forbiddenConfigFilePattern.test(entry)) {
      continue;
    }

    files.push(entry);
  }

  return files.sort();
}

function relativeToProject(absolutePath: string): string {
  const projectPath = Bun.fileURLToPath(projectRoot);
  return absolutePath.startsWith(`${projectPath}/`)
    ? absolutePath.slice(projectPath.length + 1)
    : absolutePath;
}

async function lintDefaultedPolicyParameters(): Promise<void> {
  const files = await collectTypeScriptFiles(sourceRoot);

  for (const filePath of files) {
    const sourceText = await Bun.file(filePath).text();
    const matches = [...sourceText.matchAll(defaultedPolicyParamPattern)];

    for (const match of matches) {
      const snippet = match[0];
      architectureRuleViolations.push(
        `${relativeToProject(filePath)}: defaulted role/phase parameter detected (${snippet}). ` +
          "Do not hide builder/tester policy behind a defaulted selector parameter; split the policy into explicit functions instead.",
      );
    }
  }
}

async function lintRecordCastChains(): Promise<void> {
  const files = await collectTypeScriptFiles(sourceRoot);

  for (const filePath of files) {
    const sourceText = await Bun.file(filePath).text();
    const matches = [...sourceText.matchAll(recordCastPattern)];

    for (const match of matches) {
      architectureRuleViolations.push(
        `${relativeToProject(filePath)}: raw record cast detected (${match[0]}). ` +
          "Use a shared record/type guard instead of collapsing unknown input behind an inline Record<string, unknown> cast chain.",
      );
    }
  }
}

async function lintForbiddenWireApiChat(): Promise<void> {
  const files = await collectProjectConfigFiles(projectRoot);

  for (const filePath of files) {
    const sourceText = await Bun.file(filePath).text();
    if (!forbiddenWireApiChatPattern.test(sourceText)) {
      continue;
    }

    architectureRuleViolations.push(
      `${relativeToProject(filePath)}: forbidden OpenClaw wire API override detected. ` +
        'Do not write `wire_api = "c' +
        'hat"`; it breaks compatible OpenClaw agent execution.',
    );
  }
}

async function main(): Promise<void> {
  await lintDefaultedPolicyParameters();
  await lintRecordCastChains();
  await lintForbiddenWireApiChat();

  if (architectureRuleViolations.length === 0) {
    await Bun.write(Bun.stdout, "Architecture checks passed.\n");
    return;
  }

  await Bun.write(Bun.stderr, `${architectureRuleViolations.join("\n")}\n`);
  process.exit(1);
}

void main();
