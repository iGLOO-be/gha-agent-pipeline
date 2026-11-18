import { createRequire } from "node:module";
import type { Octokit } from "@octokit/rest";

const require = createRequire(import.meta.url);
const { decidePrOpenedReview } =
  require("../../../.github/scripts/decide-pr-opened-review.cjs") as {
    decidePrOpenedReview: (input: {
      event: { action: string };
      pullRequest: unknown;
      reviews: unknown;
      branchPrefix: string;
    }) => { outcome: string };
  };

export type RunCodeReviewPhaseOptions = {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  branchPrefix: string;
  start: () => Promise<void>;
};

/**
 * Starts a code review. When `PR_OPENED_REVIEW=true`, the shared decision runs
 * on the live pull request and every existing review first. A silent skip
 * returns before `start`, so the phase posts no startup comment and calls no model.
 * A pull request closed after dispatch still starts. A published PR-opened
 * review mark still skips.
 */
export async function runCodeReviewPhase(
  options: RunCodeReviewPhaseOptions,
): Promise<void> {
  if (process.env.PR_OPENED_REVIEW === "true") {
    const decision = await decideLivePrOpenedReview(options);
    if (decision.outcome === "silent-skip") {
      console.log("PR-opened review skipped before startup.");
      return;
    }
  }

  await options.start();
}

async function decideLivePrOpenedReview(options: RunCodeReviewPhaseOptions) {
  const { octokit, owner, repo, prNumber, branchPrefix } = options;
  const { data: pullRequest } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  const reviews = await octokit.paginate(octokit.pulls.listReviews, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  return decidePrOpenedReview({
    // This job is workflow dispatch. The gate already accepted a reviewable
    // pull_request event, so the phase asks the same decision as ready_for_review
    // against the live pull request and reviews. Closed after that dispatch is
    // not a skip; the once-only mark on an existing review still is.
    event: { action: "ready_for_review" },
    pullRequest: { ...pullRequest, state: "open" },
    reviews,
    branchPrefix,
  });
}
