import type { ResolvedScope } from "../git.js";
import type { ReviewReportFinding } from "../schema.js";

const REVIEW_STALE_SECTION_TITLE = "Repository changed";

type ReviewFailure = {
  focus: string;
  model: string;
  error?: string;
};

type TriagedPr = {
  prNumber: number;
  title: string;
};

type TriageMarkdownItem = {
  feedbackKind: string;
  location: string;
  author: string;
  summary: string;
  decision: string;
  rationale: string;
  action: string;
};

export function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

export function buildReviewFindingsMarkdown(
  reviewedScopeLine: string,
  findings: ReviewReportFinding[],
  completedReviews: number,
  totalReviews: number,
  footerNotes: string[] = [],
): string {
  const reviewWord = totalReviews === 1 ? "review" : "reviews";
  const completionLine =
    completedReviews === totalReviews
      ? `All ${totalReviews} ${reviewWord} completed`
      : `${completedReviews} of ${totalReviews} ${reviewWord} completed`;

  if (findings.length === 0) {
    return appendMarkdownListSection(
      `${reviewedScopeLine}\n\n${completionLine}.\n\nNo findings.\n`,
      REVIEW_STALE_SECTION_TITLE,
      footerNotes,
    );
  }

  let table = "| # | Focus | Model | Priority | Location | Finding | Suggestion |\n";
  table += "|---|---|---|---|---|---|---|\n";
  findings.forEach((finding, index) => {
    table += `| ${index + 1} | ${escapeMarkdownTableCell(finding.focus)} | ${escapeMarkdownTableCell(finding.model)} | ${escapeMarkdownTableCell(finding.priority)} | ${escapeMarkdownTableCell(finding.location)} | ${escapeMarkdownTableCell(finding.finding)} | ${escapeMarkdownTableCell(finding.suggestion)} |\n`;
  });
  return appendMarkdownListSection(
    `${reviewedScopeLine}\n\n${completionLine}:\n\n${table}\n`,
    REVIEW_STALE_SECTION_TITLE,
    footerNotes,
  );
}

export function buildReviewFailuresMarkdown(failedFocuses: ReviewFailure[]): string {
  const reviewWord = failedFocuses.length === 1 ? "review" : "reviews";
  let table = "| Focus | Model | Error |\n";
  table += "|---|---|---|\n";
  for (const focus of failedFocuses) {
    table += `| ${escapeMarkdownTableCell(focus.focus)} | ${escapeMarkdownTableCell(focus.model)} | ${escapeMarkdownTableCell(focus.error ?? "Unknown failure")} |\n`;
  }
  return `${failedFocuses.length} ${reviewWord} failed:\n\n${table}\n`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (totalMinutes > 0) return `${totalMinutes}m${seconds}s`;
  return `${seconds}s`;
}

export function buildReviewedScopeLine(scope: ResolvedScope, durationMs: number): string {
  const scopeText =
    scope.kind === "working-tree"
      ? `working tree (${scope.trackedFiles.length} tracked, ${scope.untrackedFiles.length} untracked)`
      : scope.kind === "branch-diff"
        ? `branch diff vs ${scope.baseBranch} (${scope.diffFiles.length} files)`
        : scope.kind === "commit"
          ? `commit ${scope.sha}`
          : scope.kind === "folder"
            ? `snapshot for ${scope.paths.join(", ")}`
            : "custom scope";
  return `Reviewed ${scopeText} in ${formatDuration(durationMs)}.`;
}

export function buildTriagedPrLine(context: TriagedPr, durationMs: number): string {
  return `Triaged PR #${context.prNumber} (${context.title}) in ${formatDuration(durationMs)}.`;
}

export function buildTriageMarkdown(
  context: TriagedPr,
  items: TriageMarkdownItem[],
  durationMs: number,
): string {
  const header = buildTriagedPrLine(context, durationMs);
  if (items.length === 0) {
    return `${header}\n\nNo PR feedback items found.`;
  }

  let table = "| # | Kind | Location | Author | Summary | Decision | Rationale | Action |\n";
  table += "|---|---|---|---|---|---|---|---|\n";
  items.forEach((item, index) => {
    table += `| ${index + 1} | ${escapeMarkdownTableCell(item.feedbackKind)} | ${escapeMarkdownTableCell(item.location)} | ${escapeMarkdownTableCell(item.author)} | ${escapeMarkdownTableCell(item.summary)} | ${escapeMarkdownTableCell(item.decision)} | ${escapeMarkdownTableCell(item.rationale)} | ${escapeMarkdownTableCell(item.action)} |\n`;
  });

  return `${header}\n\n${table}`;
}

function appendMarkdownListSection(markdown: string, title: string, items: string[]): string {
  if (items.length === 0) return markdown;
  return `${markdown.trimEnd()}\n\n${title}:\n${items.map((item) => `- ${item}`).join("\n")}\n`;
}
