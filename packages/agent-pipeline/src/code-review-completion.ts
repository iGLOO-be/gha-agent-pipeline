import {
  formatRunMetricsMarkdown,
  type SessionMetricsSource,
} from "./phase-report.js";
import {
  formatRunFrictionMarkdown,
  type RunFrictionCollector,
} from "./run-friction.js";
import type { SessionAccumulatedUsage } from "./types/usage.js";
import { createOctokit, updatePullRequestReview } from "./tools/github.js";

export type BuildCodeReviewRunnerFooterParams = SessionMetricsSource & {
  sessionUsage?: SessionAccumulatedUsage;
  runFriction: RunFrictionCollector;
};

/** Runner-owned footer (metrics + friction) appended to the PR review body. */
export function buildCodeReviewRunnerFooter(
  params: BuildCodeReviewRunnerFooterParams,
): string {
  const sections: string[] = [];

  const metricsMd = formatRunMetricsMarkdown(
    {
      usage: params.sessionUsage ?? params.usage,
      sessionId: params.sessionId,
      modelId: params.modelId,
      servedModelIds: params.servedModelIds,
      openRouterCostUsd: params.openRouterCostUsd,
      iterations: params.iterations,
      toolCallsCount: params.toolCallsCount,
    },
    { collapsible: true },
  );
  if (metricsMd) {
    sections.push(metricsMd);
  }

  const frictionMd = formatRunFrictionMarkdown(params.runFriction);
  if (frictionMd) {
    sections.push(frictionMd);
  }

  if (sections.length === 0) {
    return "";
  }

  return ["---", "", ...sections].join("\n");
}

export function appendCodeReviewRunnerFooter(
  reviewBody: string,
  footer: string,
): string {
  const trimmedFooter = footer.trim();
  if (!trimmedFooter) {
    return reviewBody;
  }
  return `${reviewBody.trimEnd()}\n\n${trimmedFooter}`;
}

export type PostedReviewTracker = {
  id?: number;
  body?: string;
};

/** Appends run metrics and friction to an already-submitted PR review summary. */
export async function appendRunnerFooterToPostedReview(
  octokit: ReturnType<typeof createOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  review: PostedReviewTracker,
  params: BuildCodeReviewRunnerFooterParams,
): Promise<void> {
  const footer = buildCodeReviewRunnerFooter(params);
  if (!footer || review.id == null || !review.body) {
    return;
  }

  const newBody = appendCodeReviewRunnerFooter(review.body, footer);
  try {
    await updatePullRequestReview(
      octokit,
      owner,
      repo,
      prNumber,
      review.id,
      newBody,
    );
    review.body = newBody;
  } catch (error) {
    console.warn("Failed to append runner footer to code review:", error);
  }
}
