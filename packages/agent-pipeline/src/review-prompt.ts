import type { IgnoredFile } from "./review-path-filters.js";

export function formatReviewFileScopeMarkdown(
  reviewed: string[],
  ignored: IgnoredFile[],
): string {
  const reviewedBlock =
    reviewed.length > 0
      ? reviewed.map((file) => `- \`${file}\``).join("\n")
      : "(none)";

  const ignoredBlock =
    ignored.length > 0
      ? ignored
          .map((entry) => `- \`${entry.path}\` — ${entry.reason}`)
          .join("\n")
      : "(none)";

  return `Files selected for review:
${reviewedBlock}

Files ignored due to path filters:
${ignoredBlock}`;
}

export function parseReviewBodyFromAgentOutput(
  outputText: string,
): string | null {
  const walkthrough = outputText.match(/(## Walkthrough[\s\S]*)/);
  if (walkthrough) {
    return walkthrough[1].trim();
  }

  const standards = outputText.match(
    /(## Standards[\s\S]*?)(?=\n---|\n<!--|$)/,
  );
  if (standards) {
    return standards[1].trim();
  }

  return null;
}
