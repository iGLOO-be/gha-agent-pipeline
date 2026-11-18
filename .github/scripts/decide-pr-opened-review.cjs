"use strict";

/**
 * Decide whether a pull request event starts one PR-opened review.
 *
 * Shared by the gate's `actions/github-script` step and the code-review phase.
 * Require this file from both. It performs no GitHub I/O.
 *
 * Inputs are the pull request event (`event.action`), the live pull request,
 * the existing review objects (body and state; dismissed reviews included),
 * and the configured `branchPrefix`. Extra fields such as path filters are
 * ignored.
 *
 * `event.pull_request.head.sha` and `pullRequest.head.sha` are not copied
 * onto the dispatch. `headRef` is `pullRequest.head.ref`. `baseRef` is
 * `pullRequest.base.ref`.
 *
 * A silent skip has no reason field. Callers post no comment.
 *
 * @typedef {{ action: string }} PullRequestEvent
 * @typedef {{
 *   number: number,
 *   state: string,
 *   draft?: boolean,
 *   body?: string | null,
 *   head: { ref: string, sha?: string, repo: { full_name: string } | null },
 *   base: { ref: string, repo?: { full_name: string } | null },
 * }} LivePullRequest
 * @typedef {{ body?: string | null, state?: string }} ExistingReview
 * @typedef {{
 *   issueNumber: number,
 *   prNumber: number,
 *   headRef: string,
 *   baseRef: string,
 *   prOpenedReview: true,
 *   reviewLoopActive: false,
 *   chainCodeReview: false,
 * }} PrOpenedReviewDispatch
 * @typedef {{ outcome: "silent-skip" } | { outcome: "dispatch", dispatch: PrOpenedReviewDispatch }} PrOpenedReviewDecision
 */

/**
 * HTML comment written on an implement pull request body.
 * A body that contains this comment is a silent skip.
 */
const IMPLEMENT_MARK = "<!-- agent-pr-implement -->";

/**
 * HTML comment written on a published PR-opened review.
 * Any existing review body that contains this comment is a silent skip.
 * This is not the `agent-pr-opened` comment mark.
 */
const PR_OPENED_REVIEW_MARK = "<!-- agent-pr-opened-review -->";

function issueNumberFromHeadBranch(headRef, branchPrefix, prNumber) {
  const escapedPrefix = branchPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = headRef.match(new RegExp("^" + escapedPrefix + "/(\\d+)-"));
  if (!match) return prNumber;
  return Number(match[1]);
}

const REVIEWABLE_ACTIONS = new Set(["opened", "ready_for_review"]);

const SILENT_SKIP = { outcome: "silent-skip" };

function bodyHasMark(body, mark) {
  return typeof body === "string" && body.includes(mark);
}

function sameRepository(pullRequest) {
  const headName = pullRequest.head.repo && pullRequest.head.repo.full_name;
  const baseName = pullRequest.base.repo && pullRequest.base.repo.full_name;
  return Boolean(headName) && headName === baseName;
}

function hasPublishedPrOpenedReview(reviews) {
  return (reviews ?? []).some((review) =>
    bodyHasMark(review && review.body, PR_OPENED_REVIEW_MARK),
  );
}

/**
 * @param {{
 *   event: PullRequestEvent,
 *   pullRequest: LivePullRequest,
 *   reviews?: ExistingReview[],
 *   branchPrefix: string,
 * }} input
 * @returns {PrOpenedReviewDecision}
 */
function decidePrOpenedReview({ event, pullRequest, reviews, branchPrefix }) {
  if (!REVIEWABLE_ACTIONS.has(event.action)) return SILENT_SKIP;
  if (!sameRepository(pullRequest)) return SILENT_SKIP;
  if (event.action === "opened" && pullRequest.draft) return SILENT_SKIP;
  if (pullRequest.state === "closed") return SILENT_SKIP;
  if (bodyHasMark(pullRequest.body, IMPLEMENT_MARK)) return SILENT_SKIP;
  if (hasPublishedPrOpenedReview(reviews)) return SILENT_SKIP;

  const headRef = pullRequest.head.ref;
  const prNumber = pullRequest.number;
  const issueNumber = issueNumberFromHeadBranch(
    headRef,
    branchPrefix,
    prNumber,
  );

  return {
    outcome: "dispatch",
    dispatch: {
      issueNumber,
      prNumber,
      headRef,
      baseRef: pullRequest.base.ref,
      prOpenedReview: true,
      reviewLoopActive: false,
      chainCodeReview: false,
    },
  };
}

module.exports = {
  IMPLEMENT_MARK,
  PR_OPENED_REVIEW_MARK,
  decidePrOpenedReview,
};
