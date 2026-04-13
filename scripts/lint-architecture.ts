const architectureRuleViolations: string[] = [];

const projectRoot = new URL("..", import.meta.url);
const sourceRoot = new URL("../src/core", import.meta.url);
const defaultedPolicyParamPattern = /\b(?:phase|role)\s*:\s*[^)=\n]+\s*=\s*["'][A-Za-z0-9_-]+["']/g;

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

async function main(): Promise<void> {
  await lintDefaultedPolicyParameters();

  if (architectureRuleViolations.length === 0) {
    await Bun.write(Bun.stdout, "Architecture checks passed.\n");
    return;
  }

  await Bun.write(Bun.stderr, `${architectureRuleViolations.join("\n")}\n`);
  process.exit(1);
}

void main();
