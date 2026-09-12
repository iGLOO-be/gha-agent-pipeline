import { buildRunUrl } from "./tools/github.js";

export interface BuildAgentPrBodyOptions {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  planCommentUrl?: string | null;
  usageMarkdown?: string | null;
  riskLevel?: string | null;
  riskJustification?: string | null;
}

export function buildAgentPrBody({
  issueNumber,
  issueTitle,
  issueUrl,
  planCommentUrl,
  usageMarkdown,
  riskLevel,
  riskJustification,
}: BuildAgentPrBodyOptions): string {
  const runUrl = buildRunUrl();

  const lines = [
    `Closes #${issueNumber}`,
    "",
    "<!-- agent-pr -->",
    "## 🤖 Agent PR",
    "",
    `- **Issue:** [#${issueNumber} — ${issueTitle}](${issueUrl})`,
  ];

  if (planCommentUrl) {
    lines.push(`- **Plan:** [Agent Plan comment](${planCommentUrl})`);
  }

  if (riskLevel) {
    lines.push(
      `- **Risk score:** ${riskLevel}${riskJustification ? ` — ${riskJustification}` : ""}`,
    );
  }

  lines.push(
    "- **Feedback:** review comments or failing CI → comment `/agent fix` on this PR",
  );

  if (runUrl) {
    lines.push(`- **Run:** [GitHub Actions](${runUrl})`);
  } else {
    lines.push("- **Run:** not available outside GitHub Actions");
  }

  if (usageMarkdown) {
    lines.push("", usageMarkdown);
  }

  return lines.join("\n");
}
