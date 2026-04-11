import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import { QuestDomainError } from "../errors";

function isPathWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function resolveExistingPath(path: string): Promise<string> {
  const resolvedPath = resolve(path);
  let currentPath = resolvedPath;
  const suffix: string[] = [];

  while (true) {
    try {
      const resolvedExistingPath = await realpath(currentPath);
      // Canonicalize through the nearest existing ancestor so paths under /tmp and /private/tmp
      // compare consistently even before the final child path exists on disk.
      return suffix.length === 0
        ? resolvedExistingPath
        : join(resolvedExistingPath, ...suffix.reverse());
    } catch (error: unknown) {
      if (!isEnoent(error)) {
        throw error;
      }

      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) {
        return resolvedPath;
      }

      suffix.push(basename(currentPath));
      currentPath = parentPath;
    }
  }
}

export function resolveRunWorkspaceRootPath(workspacesRoot: string, runId: string): string {
  return join(workspacesRoot, runId);
}

export function resolveSliceWorkspacePathForRunRoot(
  workspaceRoot: string,
  sliceId: string,
): string {
  return join(workspaceRoot, "slices", sliceId);
}

export function resolveIntegrationWorkspacePathForRunRoot(workspaceRoot: string): string {
  return join(workspaceRoot, "integration");
}

export async function assertWorkspacePathWithinRoot(
  workspaceRoot: string,
  candidatePath: string,
  label: string,
): Promise<string> {
  const resolvedRoot = await resolveExistingPath(workspaceRoot);
  const resolvedCandidate = await resolveExistingPath(candidatePath);

  if (!isPathWithinRoot(resolvedCandidate, resolvedRoot)) {
    throw new QuestDomainError({
      code: "quest_workspace_materialization_failed",
      details: {
        candidatePath: resolvedCandidate,
        label,
        workspaceRoot: resolvedRoot,
      },
      message: `${label} is outside the quest workspace root`,
      statusCode: 1,
    });
  }

  return resolvedCandidate;
}
