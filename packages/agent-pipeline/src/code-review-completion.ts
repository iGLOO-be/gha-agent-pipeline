import { formatPhaseCompletionMarkdown } from "./phase-report.js";
import type { RunFrictionCollector } from "./run-friction.js";
import type { SessionAccumulatedUsage } from "./types/usage.js";

export type BuildCodeReviewPhaseCommentParams = {
  reviewHtmlUrl?: string;
  sessionUsage: SessionAccumulatedUsage;
  sessionId: string;
  modelId: string;
  servedModelIds?: string[];
  iterations?: number;
  toolCallsCount?: number;
  runFriction: RunFrictionCollector;
};

/** PR comment with run metrics, aligned with ci-fix / review-fix completion comments. */
export function buildCodeReviewPhaseComment(
  params: BuildCodeReviewPhaseCommentParams,
): string {
  const statusLine = params.reviewHtmlUrl
    ? `Review posted — [view review](${params.reviewHtmlUrl})`
    : undefined;
  const completion = formatPhaseCompletionMarkdown({
    phase: "code-review",
    statusLine,
    skipEmptyPhaseReportPlaceholder: true,
    sessionUsage: params.sessionUsage,
    sessionId: params.sessionId,
    modelId: params.modelId,
    servedModelIds: params.servedModelIds,
    iterations: params.iterations,
    toolCallsCount: params.toolCallsCount,
    runFriction: params.runFriction,
  });
  return `<!-- agent-code-review -->\n${completion}`;
}
