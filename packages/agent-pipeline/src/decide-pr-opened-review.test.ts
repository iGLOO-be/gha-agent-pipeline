import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  decidePrOpenedReview,
} = require("../../../.github/scripts/decide-pr-opened-review.cjs");

function decide(
  overrides: {
    action?: string;
    number?: number;
    state?: string;
    draft?: boolean;
    body?: string | null;
    headRef?: string;
    headRepository?: string | null;
    baseRef?: string;
    baseRepository?: string | null;
    reviews?: Array<{ body: string | null; state?: string }>;
    branchPrefix?: string;
    pathFilters?: string[];
    changedPaths?: string[];
  } = {},
) {
  return decidePrOpenedReview({
    event: {
      action: overrides.action ?? "opened",
      pull_request: {
        head: {
          sha: "opening-event-sha-abc123",
          ref: "from-the-opening-event",
        },
        base: { ref: "main" },
      },
    },
    pullRequest: {
      number: overrides.number ?? 88,
      state: overrides.state ?? "open",
      draft: overrides.draft ?? false,
      body: overrides.body === undefined ? "Adds a widget." : overrides.body,
      head: {
        ref: overrides.headRef ?? "agent/42-add-widget",
        sha: "live-tip-sha-should-not-be-dispatched",
        repo:
          overrides.headRepository === undefined
            ? { full_name: "igloo/gha-agent-pipeline" }
            : overrides.headRepository === null
              ? null
              : { full_name: overrides.headRepository },
      },
      base: {
        ref: overrides.baseRef ?? "develop",
        repo:
          overrides.baseRepository === undefined
            ? { full_name: "igloo/gha-agent-pipeline" }
            : overrides.baseRepository === null
              ? null
              : { full_name: overrides.baseRepository },
      },
    },
    reviews: overrides.reviews ?? [],
    branchPrefix: overrides.branchPrefix ?? "agent",
    ...(overrides.pathFilters ? { pathFilters: overrides.pathFilters } : {}),
    ...(overrides.changedPaths ? { changedPaths: overrides.changedPaths } : {}),
  });
}

describe("decidePrOpenedReview", () => {
  it("dispatches one PR-opened review for a reviewable pull request in the same repository with no implement mark and no published PR-opened review", () => {
    expect(decide()).toEqual({
      outcome: "dispatch",
      dispatch: {
        issueNumber: 42,
        prNumber: 88,
        headRef: "agent/42-add-widget",
        baseRef: "develop",
        prOpenedReview: true,
        reviewLoopActive: false,
        chainCodeReview: false,
      },
    });
  });

  it("parses the issue number from branch_prefix/<id>- on the head branch", () => {
    expect(
      decide({
        branchPrefix: "bot",
        headRef: "bot/7-rename-docs",
        number: 100,
        baseRef: "main",
      }),
    ).toEqual({
      outcome: "dispatch",
      dispatch: {
        issueNumber: 7,
        prNumber: 100,
        headRef: "bot/7-rename-docs",
        baseRef: "main",
        prOpenedReview: true,
        reviewLoopActive: false,
        chainCodeReview: false,
      },
    });
  });

  it("treats a pull request that is closed when the decision runs as a silent skip", () => {
    expect(decide({ state: "closed" })).toEqual({ outcome: "silent-skip" });
  });

  it("does not treat a yolo pull request as a silent skip", () => {
    expect(
      decide({
        body: "Closes #42\n\n<!-- agent-pr -->\n## Agent PR",
      }),
    ).toEqual({
      outcome: "dispatch",
      dispatch: {
        issueNumber: 42,
        prNumber: 88,
        headRef: "agent/42-add-widget",
        baseRef: "develop",
        prOpenedReview: true,
        reviewLoopActive: false,
        chainCodeReview: false,
      },
    });
  });

  it("does not treat a dismissed code review without a PR-opened review as a silent skip", () => {
    expect(
      decide({
        reviews: [
          {
            state: "DISMISSED",
            body: "<!-- agent-code-review -->\nA dismissed code review",
          },
        ],
      }),
    ).toEqual({
      outcome: "dispatch",
      dispatch: {
        issueNumber: 42,
        prNumber: 88,
        headRef: "agent/42-add-widget",
        baseRef: "develop",
        prOpenedReview: true,
        reviewLoopActive: false,
        chainCodeReview: false,
      },
    });
  });

  it("treats a published PR-opened review as a silent skip, including a dismissed review", () => {
    expect(
      decide({
        reviews: [
          {
            state: "COMMENTED",
            body: "<!-- agent-code-review -->\nA manual code review",
          },
          {
            state: "DISMISSED",
            body: "<!-- agent-code-review -->\n<!-- agent-pr-opened-review -->\nWalkthrough",
          },
        ],
      }),
    ).toEqual({ outcome: "silent-skip" });
  });

  it("does not treat a review body that only mentions agent-pr-opened-review as a silent skip", () => {
    expect(
      decide({
        reviews: [
          {
            state: "COMMENTED",
            body: "The notes mention agent-pr-opened-review without the HTML comment.",
          },
        ],
      }),
    ).toEqual({
      outcome: "dispatch",
      dispatch: {
        issueNumber: 42,
        prNumber: 88,
        headRef: "agent/42-add-widget",
        baseRef: "develop",
        prOpenedReview: true,
        reviewLoopActive: false,
        chainCodeReview: false,
      },
    });
  });

  it("treats an implement pull request as a silent skip", () => {
    expect(
      decide({
        body: "Closes #42\n\n<!-- agent-pr -->\n<!-- agent-pr-implement -->\n## Agent PR",
      }),
    ).toEqual({ outcome: "silent-skip" });
  });

  it("does not treat a pull request body that only mentions agent-pr-implement as a silent skip", () => {
    expect(
      decide({
        body: "Closes #42\n\nThe notes mention agent-pr-implement without the HTML comment.",
      }),
    ).toEqual({
      outcome: "dispatch",
      dispatch: {
        issueNumber: 42,
        prNumber: 88,
        headRef: "agent/42-add-widget",
        baseRef: "develop",
        prOpenedReview: true,
        reviewLoopActive: false,
        chainCodeReview: false,
      },
    });
  });

  it("does not treat path filters as a silent skip", () => {
    expect(
      decide({
        pathFilters: ["!**/*"],
        changedPaths: [".github/workflows/ci.yml", "README.md"],
      }),
    ).toEqual({
      outcome: "dispatch",
      dispatch: {
        issueNumber: 42,
        prNumber: 88,
        headRef: "agent/42-add-widget",
        baseRef: "develop",
        prOpenedReview: true,
        reviewLoopActive: false,
        chainCodeReview: false,
      },
    });
  });

  it("treats events other than opened and ready_for_review as a silent skip", () => {
    for (const action of ["synchronize", "reopened", "edited"]) {
      expect(decide({ action }), action).toEqual({ outcome: "silent-skip" });
    }
  });

  it("treats an opened draft as a silent skip", () => {
    expect(decide({ draft: true })).toEqual({ outcome: "silent-skip" });
  });

  it("treats ready_for_review as reviewable", () => {
    expect(decide({ action: "ready_for_review", draft: true })).toEqual({
      outcome: "dispatch",
      dispatch: {
        issueNumber: 42,
        prNumber: 88,
        headRef: "agent/42-add-widget",
        baseRef: "develop",
        prOpenedReview: true,
        reviewLoopActive: false,
        chainCodeReview: false,
      },
    });
  });

  it("treats a head branch in another repository as a silent skip", () => {
    expect(
      decide({
        headRepository: "contributor/gha-agent-pipeline",
      }),
    ).toEqual({ outcome: "silent-skip" });
  });

  it("uses the pull request number when branch_prefix/<id>- is not at the start of the head branch", () => {
    expect(
      decide({
        headRef: "myagent/4-add-widget",
        number: 15,
      }),
    ).toEqual({
      outcome: "dispatch",
      dispatch: {
        issueNumber: 15,
        prNumber: 15,
        headRef: "myagent/4-add-widget",
        baseRef: "develop",
        prOpenedReview: true,
        reviewLoopActive: false,
        chainCodeReview: false,
      },
    });
  });

  it("uses the pull request number when the head branch has no hyphen after the issue id", () => {
    expect(
      decide({
        headRef: "agent/42",
        number: 15,
      }),
    ).toEqual({
      outcome: "dispatch",
      dispatch: {
        issueNumber: 15,
        prNumber: 15,
        headRef: "agent/42",
        baseRef: "develop",
        prOpenedReview: true,
        reviewLoopActive: false,
        chainCodeReview: false,
      },
    });
  });

  it("does not treat the pull request opened comment mark as a published PR-opened review", () => {
    expect(
      decide({
        reviews: [
          {
            state: "COMMENTED",
            body: "<!-- agent-pr-opened -->\nPR opened by this run",
          },
        ],
      }),
    ).toEqual({
      outcome: "dispatch",
      dispatch: {
        issueNumber: 42,
        prNumber: 88,
        headRef: "agent/42-add-widget",
        baseRef: "develop",
        prOpenedReview: true,
        reviewLoopActive: false,
        chainCodeReview: false,
      },
    });
  });

  it("uses the pull request number when the head branch does not match branch_prefix/<id>-", () => {
    expect(
      decide({
        branchPrefix: "bot",
        headRef: "agent/9-add-widget",
        number: 15,
        baseRef: "main",
      }),
    ).toEqual({
      outcome: "dispatch",
      dispatch: {
        issueNumber: 15,
        prNumber: 15,
        headRef: "agent/9-add-widget",
        baseRef: "main",
        prOpenedReview: true,
        reviewLoopActive: false,
        chainCodeReview: false,
      },
    });
  });
});
