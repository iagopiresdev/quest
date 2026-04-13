import { dirname, resolve } from "node:path";

import { isQuestDomainError, QuestDomainError } from "../errors";
import type { QuestRunCheckResult, QuestRunDocument, QuestRunSliceState } from "../runs/schema";
import { assertWorkspacePathWithinRoot } from "../runs/workspace-layout";
import { ensureDirectory } from "../storage";

function slugifyChronicleTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function resolveChronicleOutputPath(run: QuestRunDocument): Promise<string> {
  const root = run.integrationWorkspacePath ?? run.workspaceRoot;
  if (!root) {
    throw new QuestDomainError({
      code: "quest_feature_doc_failed",
      details: { runId: run.id },
      message: `Quest run ${run.id} has no workspace root for feature doc generation`,
      statusCode: 1,
    });
  }

  const relativeOutputPath =
    run.spec.featureDoc.outputPath ?? `docs/features/${slugifyChronicleTitle(run.spec.title)}.md`;
  const outputPath = resolve(root, relativeOutputPath);
  if (!(outputPath === resolve(root) || outputPath.startsWith(`${resolve(root)}/`))) {
    throw new QuestDomainError({
      code: "quest_feature_doc_failed",
      details: { outputPath: relativeOutputPath, root: resolve(root), runId: run.id },
      message: `Feature doc path escapes the quest workspace: ${relativeOutputPath}`,
      statusCode: 1,
    });
  }

  try {
    return await assertWorkspacePathWithinRoot(root, outputPath, "Feature doc path");
  } catch (error: unknown) {
    throw new QuestDomainError({
      code: "quest_feature_doc_failed",
      details: {
        cause: isQuestDomainError(error) ? error.details : error,
        outputPath: relativeOutputPath,
        root: resolve(root),
        runId: run.id,
      },
      message: `Feature doc path escapes the quest workspace: ${relativeOutputPath}`,
      statusCode: 1,
    });
  }
}

function formatCommand(check: QuestRunCheckResult): string {
  return check.command.argv.join(" ");
}

function formatChecks(checks: QuestRunCheckResult[] | undefined): string[] {
  if (!checks || checks.length === 0) {
    return ["- none"];
  }

  return checks.map((check) => {
    const status = check.exitCode === 0 ? "passed" : `failed (exit ${check.exitCode})`;
    return `- \`${formatCommand(check)}\` — ${status}`;
  });
}

function formatWorkerLine(
  workerId: string | null | undefined,
  role: "builder" | "tester",
  output: QuestRunSliceState["lastOutput"] | QuestRunSliceState["lastTesterOutput"] | undefined,
): string {
  if (!workerId) {
    return `- ${role}: unassigned`;
  }

  const summary = output?.summary ? ` — ${output.summary}` : "";
  return `- ${role}: \`${workerId}\`${summary}`;
}

function renderSliceSection(slice: QuestRunSliceState): string {
  const lines = [
    `### ${slice.title}`,
    "",
    `- slice: \`${slice.sliceId}\``,
    `- wave: ${slice.wave}`,
    `- status: ${slice.status}`,
    formatWorkerLine(slice.assignedWorkerId, "builder", slice.lastOutput),
    formatWorkerLine(slice.assignedTesterWorkerId, "tester", slice.lastTesterOutput),
    `- boss fight status: ${slice.integrationStatus ?? "pending"}`,
  ];

  if (slice.lastError) {
    lines.push(`- last error: ${slice.lastError}`);
  }

  lines.push("", "Trial results:", ...formatChecks(slice.lastChecks), "");
  return lines.join("\n");
}

function summarizeSlices(run: QuestRunDocument): string {
  return run.slices.map((slice) => renderSliceSection(slice)).join("\n");
}

function summarizeIntegration(run: QuestRunDocument): string {
  const targetRef = run.targetRef ?? "HEAD";
  const integrationWorkspace = run.integrationWorkspacePath ?? "not created";
  const lines = [
    `- turn-in status: ${run.events.some((event) => event.type === "run_integrated") ? "completed" : "pending"}`,
    `- boss fight target: \`${targetRef}\``,
    `- integration workspace: \`${integrationWorkspace}\``,
  ];

  if (run.lastIntegrationChecks) {
    lines.push("", "Boss Fight checks:", ...formatChecks(run.lastIntegrationChecks));
  } else {
    lines.push("", "Boss Fight checks:", "- none");
  }

  return lines.join("\n");
}

export function generateRunChronicle(run: QuestRunDocument): string {
  const generatedAt = new Date().toISOString();
  return [
    `# ${run.spec.title}`,
    "",
    `- quest id: \`${run.id}\``,
    `- workspace: \`${run.spec.workspace}\``,
    `- generated at: ${generatedAt}`,
    `- source repository: ${run.sourceRepositoryPath ?? "none"}`,
    "",
    "## Briefing",
    "",
    run.spec.summary ?? "No summary provided.",
    "",
    "## Objectives",
    "",
    ...run.spec.slices.flatMap((slice) => [
      `- ${slice.title}: ${slice.goal}`,
      ...(slice.description ? [`  details: ${slice.description}`] : []),
    ]),
    "",
    "## Party",
    "",
    ...run.slices.flatMap((slice) => [
      formatWorkerLine(slice.assignedWorkerId, "builder", slice.lastOutput),
      formatWorkerLine(slice.assignedTesterWorkerId, "tester", slice.lastTesterOutput),
    ]),
    "",
    "## Encounters",
    "",
    summarizeSlices(run),
    "",
    "## Boss Fight",
    "",
    summarizeIntegration(run),
    "",
  ].join("\n");
}

export async function writeRunChronicle(run: QuestRunDocument): Promise<string> {
  const outputPath = await resolveChronicleOutputPath(run);
  await ensureDirectory(dirname(outputPath));
  await Bun.write(outputPath, generateRunChronicle(run));
  return outputPath;
}
