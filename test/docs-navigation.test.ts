import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function readTrackedFiles(): Set<string> {
  const result = Bun.spawnSync({
    cmd: ["git", "ls-files"],
    cwd: projectRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }

  return new Set(
    new TextDecoder()
      .decode(result.stdout)
      .split("\n")
      .filter((entry) => entry.length > 0),
  );
}

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectNavigationPages(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectNavigationPages(entry));
  }

  if (!isObject(value)) {
    return [];
  }

  const pages = Array.isArray(value.pages)
    ? value.pages.filter((page): page is string => typeof page === "string")
    : [];
  return [...pages, ...Object.values(value).flatMap((entry) => collectNavigationPages(entry))];
}

function trackedDocPathFor(page: string, trackedFiles: Set<string>): string | null {
  const candidates =
    page.endsWith(".md") || page.endsWith(".mdx") ? [page] : [`${page}.mdx`, `${page}.md`];
  return (
    candidates.find(
      (candidate) => trackedFiles.has(candidate) && existsSync(join(projectRoot, candidate)),
    ) ?? null
  );
}

test("docs navigation only references tracked pages", () => {
  const trackedFiles = readTrackedFiles();
  const navigation = JSON.parse(
    readFileSync(join(projectRoot, "config/navigation.json"), "utf8"),
  ) as unknown;
  const missingPages = collectNavigationPages(navigation).filter(
    (page) => trackedDocPathFor(page, trackedFiles) === null,
  );

  expect(missingPages).toEqual([]);
});

test("tracked docs absolute docs links resolve to tracked pages", () => {
  const trackedFiles = readTrackedFiles();
  const trackedDocs = [...trackedFiles].filter(
    (file) => file.endsWith(".md") || file.endsWith(".mdx"),
  );
  const brokenLinks: string[] = [];
  const docsLinkPattern = /\[[^\]]+\]\((\/docs\/[^)#?\s]+)(?:#[^)]+)?\)/g;

  for (const docPath of trackedDocs) {
    const text = readFileSync(join(projectRoot, docPath), "utf8");
    for (const match of text.matchAll(docsLinkPattern)) {
      const target = match[1];
      if (!target) {
        continue;
      }

      const normalizedTarget = target.replace(/^\//, "");
      if (trackedDocPathFor(normalizedTarget, trackedFiles) === null) {
        brokenLinks.push(`${docPath} -> ${target}`);
      }
    }
  }

  expect(brokenLinks).toEqual([]);
});
