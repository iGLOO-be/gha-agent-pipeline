import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  decidePrOpenedReview,
} = require("../../../.github/scripts/decide-pr-opened-review.cjs");
const {
  prOpenedReviewWorkflowInputs,
  readBranchPrefix,
} = require("../../../.github/scripts/pr-opened-review-dispatch.cjs");

describe("readBranchPrefix", () => {
  it("reads git.branch_prefix from agent config text", () => {
    const configText = ["version: 1", "git:", "  branch_prefix: bot"].join(
      "\n",
    );

    expect(readBranchPrefix(configText)).toBe("bot");
  });

  it("uses agent when the config text has no branch_prefix", () => {
    const configText = ["version: 1", "git:", "  base_branch: main"].join("\n");

    expect(readBranchPrefix(configText)).toBe("agent");
  });

  it("uses agent when the config text is missing or unreadable", () => {
    expect(readBranchPrefix(undefined)).toBe("agent");
    expect(readBranchPrefix(null)).toBe("agent");
    expect(readBranchPrefix("")).toBe("agent");
  });

  it("reads a quoted branch_prefix without the quotes", () => {
    expect(readBranchPrefix('git:\n  branch_prefix: "bot"\n')).toBe("bot");
    expect(readBranchPrefix("git:\n  branch_prefix: 'bot'\n")).toBe("bot");
  });
});

describe("prOpenedReviewWorkflowInputs", () => {
  it("turns a PR-opened review dispatch into code-review workflow_dispatch inputs", () => {
    expect(
      prOpenedReviewWorkflowInputs({
        issueNumber: 42,
        prNumber: 88,
        headRef: "agent/42-add-widget",
        baseRef: "develop",
        prOpenedReview: true,
        reviewLoopActive: false,
        chainCodeReview: false,
      }),
    ).toEqual({
      phase: "code-review",
      runtime_phase: "code-review",
      issue_number: "42",
      pr_number: "88",
      head_ref: "agent/42-add-widget",
      base_branch: "develop",
      pr_opened_review: "true",
      review_loop_active: "false",
      chain_code_review: "false",
    });
  });

  it("uses the default branch prefix when config text is unreadable and dispatches that issue number", () => {
    const branchPrefix = readBranchPrefix(null);
    const decision = decidePrOpenedReview({
      event: { action: "opened" },
      pullRequest: {
        number: 88,
        state: "open",
        draft: false,
        body: "Adds a widget.",
        head: {
          ref: "agent/42-add-widget",
          sha: "live-tip-sha-should-not-be-dispatched",
          repo: { full_name: "igloo/gha-agent-pipeline" },
        },
        base: {
          ref: "develop",
          repo: { full_name: "igloo/gha-agent-pipeline" },
        },
      },
      reviews: [],
      branchPrefix,
    });

    expect(prOpenedReviewWorkflowInputs(decision.dispatch)).toEqual({
      phase: "code-review",
      runtime_phase: "code-review",
      issue_number: "42",
      pr_number: "88",
      head_ref: "agent/42-add-widget",
      base_branch: "develop",
      pr_opened_review: "true",
      review_loop_active: "false",
      chain_code_review: "false",
    });
  });
});
