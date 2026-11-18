"use strict";

/**
 * Pure helpers for the PR-opened review gate. No GitHub I/O.
 *
 * The workflow reads `.github/agent.config.yml` from the default branch,
 * passes that text to `readBranchPrefix` (missing or unreadable text yields
 * `agent`), and calls `decidePrOpenedReview` with the prefix. A dispatch
 * payload is turned into `workflow_dispatch` inputs by
 * `prOpenedReviewWorkflowInputs`.
 */

const DEFAULT_BRANCH_PREFIX = "agent";

function readBranchPrefix(configText) {
  if (typeof configText !== "string" || configText.length === 0) {
    return DEFAULT_BRANCH_PREFIX;
  }
  const match = configText.match(/^\s*branch_prefix:\s*(.+)$/m);
  if (!match) return DEFAULT_BRANCH_PREFIX;
  const value = match[1].trim().replace(/^['"]|['"]$/g, "");
  return value || DEFAULT_BRANCH_PREFIX;
}

/**
 * Workflow_dispatch inputs for the consumer `agent-phase.yml` code review.
 * `head_ref` is the branch name. There is no opening SHA and no comment id.
 * The review loop and chaining stay inactive.
 *
 * @param {{
 *   issueNumber: number,
 *   prNumber: number,
 *   headRef: string,
 *   baseRef: string,
 *   prOpenedReview: true,
 *   reviewLoopActive: false,
 *   chainCodeReview: false,
 * }} dispatch
 */
function prOpenedReviewWorkflowInputs(dispatch) {
  return {
    phase: "code-review",
    runtime_phase: "code-review",
    issue_number: String(dispatch.issueNumber),
    pr_number: String(dispatch.prNumber),
    head_ref: dispatch.headRef,
    base_branch: dispatch.baseRef,
    pr_opened_review: dispatch.prOpenedReview ? "true" : "false",
    review_loop_active: dispatch.reviewLoopActive ? "true" : "false",
    chain_code_review: dispatch.chainCodeReview ? "true" : "false",
  };
}

module.exports = {
  readBranchPrefix,
  prOpenedReviewWorkflowInputs,
};
