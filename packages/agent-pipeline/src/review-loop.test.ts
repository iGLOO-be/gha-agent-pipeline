import type { Octokit } from "@octokit/rest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "./config.js";
import type { ReviewTracker } from "./tools/index.js";

type InlineReviewComment = {
  path: string;
  line?: number | null;
  body?: string | null;
};

const mocks = vi.hoisted(() => ({
  dispatchAgentPhaseWorkflow: vi.fn().mockResolvedValue(undefined),
  postComment: vi.fn().mockResolvedValue(undefined),
  listReviewCommentsForReview: vi
    .fn()
    .mockResolvedValue([] as InlineReviewComment[]),
}));

vi.mock("./tools/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools/github.js")>();
  return {
    ...actual,
    dispatchAgentPhaseWorkflow: mocks.dispatchAgentPhaseWorkflow,
    postComment: mocks.postComment,
    listReviewCommentsForReview: mocks.listReviewCommentsForReview,
  };
});

import {
  REVIEW_FIX_FEEDBACK_MAX_CHARS,
  afterCodeReviewInReviewLoop,
  afterReviewFixPushInReviewLoop,
  buildChainedReviewFixFeedback,
  getReviewLoopMaxRounds,
  isReviewLoopActiveFromEnv,
  isReviewLoopEnabled,
  onReviewFixNoChangesInReviewLoop,
  parseReviewLoopRoundFromEnv,
  startReviewLoopAfterImplement,
} from "./review-loop.js";

const baseConfig = {
  review_loop: { enabled: false, max_rounds: 3 },
} as AgentConfig;

const loopConfig = {
  review_loop: { enabled: true, max_rounds: 3 },
} as AgentConfig;

const octokit = {} as Octokit;

function resetEnv() {
  vi.unstubAllEnvs();
  delete process.env.REVIEW_LOOP_ACTIVE;
  delete process.env.REVIEW_LOOP_ROUND;
  delete process.env.REACTION_TARGET;
  delete process.env.COMMENT_ID;
}

describe("review-loop helpers", () => {
  afterEach(() => {
    resetEnv();
  });

  it("reads config flags", () => {
    expect(isReviewLoopEnabled(baseConfig)).toBe(false);
    expect(
      isReviewLoopEnabled({
        review_loop: { enabled: true, max_rounds: 5 },
      } as AgentConfig),
    ).toBe(true);
    expect(getReviewLoopMaxRounds(baseConfig)).toBe(3);
  });

  it("parses env", () => {
    expect(isReviewLoopActiveFromEnv()).toBe(false);
    vi.stubEnv("REVIEW_LOOP_ACTIVE", "true");
    expect(isReviewLoopActiveFromEnv()).toBe(true);
    vi.stubEnv("REVIEW_LOOP_ROUND", "2");
    expect(parseReviewLoopRoundFromEnv()).toBe(2);
    vi.stubEnv("REVIEW_LOOP_ROUND", "bad");
    expect(parseReviewLoopRoundFromEnv()).toBe(0);
  });
});

describe("review loop state machine", () => {
  const review: ReviewTracker = {
    posted: true,
    id: 55,
    body: "## Walkthrough\nHard finding.",
    htmlUrl: "https://github.com/o/r/pull/2#pullrequestreview-55",
    event: "REQUEST_CHANGES",
  };

  beforeEach(() => {
    resetEnv();
    mocks.dispatchAgentPhaseWorkflow.mockClear();
    mocks.postComment.mockClear();
    mocks.listReviewCommentsForReview.mockReset();
    mocks.listReviewCommentsForReview.mockResolvedValue([
      { path: "src/a.ts", line: 3, body: "fix this" },
    ]);
    vi.stubEnv("COMMENT_ID", "42");
  });

  afterEach(() => {
    resetEnv();
  });

  describe("afterCodeReviewInReviewLoop", () => {
    it("does nothing when the loop is not active", async () => {
      await afterCodeReviewInReviewLoop(octokit, "o", "r", loopConfig, {
        issueNumber: 1,
        prNumber: 2,
        headRef: "agent/1",
        review,
      });

      expect(mocks.dispatchAgentPhaseWorkflow).not.toHaveBeenCalled();
      expect(mocks.postComment).not.toHaveBeenCalled();
    });

    it("stops without dispatch when the review was not posted", async () => {
      vi.stubEnv("REVIEW_LOOP_ACTIVE", "true");

      await afterCodeReviewInReviewLoop(octokit, "o", "r", loopConfig, {
        issueNumber: 1,
        prNumber: 2,
        headRef: "agent/1",
        review: { posted: false },
      });

      expect(mocks.dispatchAgentPhaseWorkflow).not.toHaveBeenCalled();
      expect(mocks.postComment).not.toHaveBeenCalled();
    });

    it("completes the loop on COMMENT", async () => {
      vi.stubEnv("REVIEW_LOOP_ACTIVE", "true");
      vi.stubEnv("REVIEW_LOOP_ROUND", "0");

      await afterCodeReviewInReviewLoop(octokit, "o", "r", loopConfig, {
        issueNumber: 1,
        prNumber: 2,
        headRef: "agent/1",
        review: { ...review, event: "COMMENT" },
      });

      expect(mocks.dispatchAgentPhaseWorkflow).not.toHaveBeenCalled();
      expect(mocks.postComment).toHaveBeenCalledWith(
        octokit,
        "o",
        "r",
        2,
        expect.stringContaining("Review loop complete"),
      );
    });

    it("dispatches review-fix below the round cap", async () => {
      vi.stubEnv("REVIEW_LOOP_ACTIVE", "true");
      vi.stubEnv("REVIEW_LOOP_ROUND", "0");

      await afterCodeReviewInReviewLoop(octokit, "o", "r", loopConfig, {
        issueNumber: 1,
        prNumber: 2,
        headRef: "agent/1",
        review,
      });

      expect(mocks.postComment).not.toHaveBeenCalled();
      expect(mocks.dispatchAgentPhaseWorkflow).toHaveBeenCalledWith(
        octokit,
        "o",
        "r",
        expect.objectContaining({
          phase: "review-fix",
          commentId: "42",
          reviewLoopActive: true,
          reviewLoopRound: 0,
          reactionTarget: "issue_comment",
          reviewFeedback: expect.stringContaining("src/a.ts:3"),
        }),
      );
    });

    it("stops at the round cap", async () => {
      vi.stubEnv("REVIEW_LOOP_ACTIVE", "true");
      vi.stubEnv("REVIEW_LOOP_ROUND", "3");

      await afterCodeReviewInReviewLoop(octokit, "o", "r", loopConfig, {
        issueNumber: 1,
        prNumber: 2,
        headRef: "agent/1",
        review,
      });

      expect(mocks.dispatchAgentPhaseWorkflow).not.toHaveBeenCalled();
      expect(mocks.postComment).toHaveBeenCalledWith(
        octokit,
        "o",
        "r",
        2,
        expect.stringContaining("review_loop.max_rounds"),
      );
    });

    it("posts a stop comment when the review-fix dispatch fails", async () => {
      vi.stubEnv("REVIEW_LOOP_ACTIVE", "true");
      vi.stubEnv("REVIEW_LOOP_ROUND", "0");
      mocks.dispatchAgentPhaseWorkflow.mockRejectedValueOnce(
        new Error("Resource not accessible by integration"),
      );

      await afterCodeReviewInReviewLoop(octokit, "o", "r", loopConfig, {
        issueNumber: 1,
        prNumber: 2,
        headRef: "agent/1",
        review,
      });

      expect(mocks.postComment).toHaveBeenCalledWith(
        octokit,
        "o",
        "r",
        2,
        expect.stringContaining("could not dispatch"),
      );
      expect(mocks.postComment).toHaveBeenCalledWith(
        octokit,
        "o",
        "r",
        2,
        expect.stringContaining("Check the App token `actions: write` scope"),
      );
    });

    it("posts a stop comment when COMMENT_ID is missing", async () => {
      vi.stubEnv("REVIEW_LOOP_ACTIVE", "true");
      vi.stubEnv("REVIEW_LOOP_ROUND", "0");
      delete process.env.COMMENT_ID;

      await afterCodeReviewInReviewLoop(octokit, "o", "r", loopConfig, {
        issueNumber: 1,
        prNumber: 2,
        headRef: "agent/1",
        review,
      });

      expect(mocks.dispatchAgentPhaseWorkflow).not.toHaveBeenCalled();
      expect(mocks.postComment).toHaveBeenCalledWith(
        octokit,
        "o",
        "r",
        2,
        expect.stringContaining("could not dispatch"),
      );
      expect(mocks.postComment).toHaveBeenCalledWith(
        octokit,
        "o",
        "r",
        2,
        expect.stringContaining(
          "`COMMENT_ID` is missing from the run environment",
        ),
      );
      expect(mocks.postComment).not.toHaveBeenCalledWith(
        octokit,
        "o",
        "r",
        2,
        expect.stringContaining("actions: write"),
      );
    });
  });
});

describe("review-fix review loop hooks", () => {
  beforeEach(() => {
    resetEnv();
    mocks.dispatchAgentPhaseWorkflow.mockClear();
    mocks.postComment.mockClear();
    vi.stubEnv("COMMENT_ID", "42");
  });

  afterEach(() => {
    resetEnv();
  });

  it("dispatches the next code-review round after a push", async () => {
    vi.stubEnv("REVIEW_LOOP_ACTIVE", "true");
    vi.stubEnv("REVIEW_LOOP_ROUND", "0");

    await afterReviewFixPushInReviewLoop(octokit, "o", "r", loopConfig, {
      issueNumber: 1,
      prNumber: 2,
      agentBranch: "agent/1",
    });

    expect(mocks.postComment).not.toHaveBeenCalled();
    expect(mocks.dispatchAgentPhaseWorkflow).toHaveBeenCalledWith(
      octokit,
      "o",
      "r",
      expect.objectContaining({
        phase: "code-review",
        commentId: "42",
        headRef: "agent/1",
        reviewLoopActive: true,
        reviewLoopRound: 1,
      }),
    );
  });

  it("stops when the next round would exceed max_rounds", async () => {
    vi.stubEnv("REVIEW_LOOP_ACTIVE", "true");
    vi.stubEnv("REVIEW_LOOP_ROUND", "3");

    await afterReviewFixPushInReviewLoop(octokit, "o", "r", loopConfig, {
      issueNumber: 1,
      prNumber: 2,
      agentBranch: "agent/1",
    });

    expect(mocks.dispatchAgentPhaseWorkflow).not.toHaveBeenCalled();
    expect(mocks.postComment).toHaveBeenCalledWith(
      octokit,
      "o",
      "r",
      2,
      expect.stringContaining("review_loop.max_rounds"),
    );
  });

  it("is inert outside the loop", async () => {
    await afterReviewFixPushInReviewLoop(octokit, "o", "r", loopConfig, {
      issueNumber: 1,
      prNumber: 2,
      agentBranch: "agent/1",
    });

    expect(mocks.dispatchAgentPhaseWorkflow).not.toHaveBeenCalled();
    expect(mocks.postComment).not.toHaveBeenCalled();
  });

  it("posts a stop comment when the code-review dispatch fails", async () => {
    vi.stubEnv("REVIEW_LOOP_ACTIVE", "true");
    vi.stubEnv("REVIEW_LOOP_ROUND", "0");
    mocks.dispatchAgentPhaseWorkflow.mockRejectedValueOnce(new Error("422"));

    await afterReviewFixPushInReviewLoop(octokit, "o", "r", loopConfig, {
      issueNumber: 1,
      prNumber: 2,
      agentBranch: "agent/1",
    });

    expect(mocks.postComment).toHaveBeenCalledWith(
      octokit,
      "o",
      "r",
      2,
      expect.stringContaining("could not dispatch code-review round 1"),
    );
  });

  it("reports a stall when review-fix made no changes", async () => {
    vi.stubEnv("REVIEW_LOOP_ACTIVE", "true");

    await onReviewFixNoChangesInReviewLoop(octokit, "o", "r", 2);

    expect(mocks.postComment).toHaveBeenCalledWith(
      octokit,
      "o",
      "r",
      2,
      expect.stringContaining("no code changes"),
    );
  });

  it("does not report a stall outside the loop", async () => {
    await onReviewFixNoChangesInReviewLoop(octokit, "o", "r", 2);

    expect(mocks.postComment).not.toHaveBeenCalled();
  });
});

describe("startReviewLoopAfterImplement", () => {
  beforeEach(() => {
    resetEnv();
    mocks.dispatchAgentPhaseWorkflow.mockClear();
    mocks.postComment.mockClear();
    vi.stubEnv("COMMENT_ID", "42");
  });

  afterEach(() => {
    resetEnv();
  });

  it("dispatches the initial code-review round 0", async () => {
    await startReviewLoopAfterImplement(octokit, "o", "r", {
      issueNumber: 1,
      prNumber: 2,
      agentBranch: "agent/1",
    });

    expect(mocks.postComment).not.toHaveBeenCalled();
    expect(mocks.dispatchAgentPhaseWorkflow).toHaveBeenCalledWith(
      octokit,
      "o",
      "r",
      expect.objectContaining({
        phase: "code-review",
        commentId: "42",
        headRef: "agent/1",
        reviewLoopActive: true,
        reviewLoopRound: 0,
      }),
    );
  });

  it("reports a rejected initial dispatch instead of ending silently", async () => {
    mocks.dispatchAgentPhaseWorkflow.mockRejectedValueOnce(
      new Error("Resource not accessible by integration"),
    );

    await startReviewLoopAfterImplement(octokit, "o", "r", {
      issueNumber: 1,
      prNumber: 2,
      agentBranch: "agent/1",
    });

    expect(mocks.postComment).toHaveBeenCalledWith(
      octokit,
      "o",
      "r",
      2,
      expect.stringContaining(
        "Review loop not started: could not dispatch the initial code-review",
      ),
    );
  });

  it("reports a missing COMMENT_ID", async () => {
    delete process.env.COMMENT_ID;

    await startReviewLoopAfterImplement(octokit, "o", "r", {
      issueNumber: 1,
      prNumber: 2,
      agentBranch: "agent/1",
    });

    expect(mocks.dispatchAgentPhaseWorkflow).not.toHaveBeenCalled();
    expect(mocks.postComment).toHaveBeenCalledWith(
      octokit,
      "o",
      "r",
      2,
      expect.stringContaining("Review loop not started: could not dispatch"),
    );
  });
});

describe("buildChainedReviewFixFeedback", () => {
  beforeEach(() => {
    mocks.listReviewCommentsForReview.mockReset();
  });

  it("includes the review body and inline comments", async () => {
    mocks.listReviewCommentsForReview.mockResolvedValue([
      { path: "src/a.ts", line: 12, body: "extract helper" },
      { path: "src/b.ts", line: null, body: "missing test" },
    ]);

    const feedback = await buildChainedReviewFixFeedback(octokit, "o", "r", 2, {
      posted: true,
      id: 55,
      body: "## Walkthrough\nhard finding",
    });

    expect(feedback).toContain("### Review body");
    expect(feedback).toContain("hard finding");
    expect(feedback).toContain("- **src/a.ts:12**");
    expect(feedback).toContain("extract helper");
    expect(feedback).toContain("- **src/b.ts:?**");
  });

  it("stays under the workflow_dispatch input limit and points to the review", async () => {
    const hugeInline = Array.from({ length: 25 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      line: index + 1,
      body: "x".repeat(4_000),
    }));
    mocks.listReviewCommentsForReview.mockResolvedValue(hugeInline);

    const feedback = await buildChainedReviewFixFeedback(octokit, "o", "r", 2, {
      posted: true,
      id: 55,
      body: "y".repeat(30_000),
      htmlUrl: "https://github.com/o/r/pull/2#pullrequestreview-55",
    });

    expect(feedback.length).toBeLessThanOrEqual(REVIEW_FIX_FEEDBACK_MAX_CHARS);
    expect(feedback).toContain("truncated");
    expect(feedback).toContain(
      "https://github.com/o/r/pull/2#pullrequestreview-55",
    );
  });

  it("reports inline comment load failures", async () => {
    mocks.listReviewCommentsForReview.mockRejectedValue(new Error("boom"));

    const feedback = await buildChainedReviewFixFeedback(octokit, "o", "r", 2, {
      posted: true,
      id: 55,
      body: "body",
    });

    expect(feedback).toContain("Could not load inline review comments: boom");
  });

  it("returns the header only when the review has no body", async () => {
    const feedback = await buildChainedReviewFixFeedback(octokit, "o", "r", 2, {
      posted: true,
    });

    expect(feedback).toContain("Automated review-fix");
    expect(feedback).not.toContain("### Review body");
  });
});

describe("dispatchAgentPhaseWorkflow review loop inputs", () => {
  it("forwards the review loop fields", async () => {
    const actual =
      await vi.importActual<typeof import("./tools/github.js")>(
        "./tools/github.js",
      );
    const createWorkflowDispatch = vi.fn().mockResolvedValue(undefined);
    const client = {
      repos: {
        get: vi.fn().mockResolvedValue({ data: { default_branch: "main" } }),
      },
      actions: { createWorkflowDispatch },
    };

    await actual.dispatchAgentPhaseWorkflow(client as never, "o", "r", {
      phase: "review-fix",
      commentId: "99",
      issueNumber: 1,
      prNumber: 2,
      headRef: "agent/1",
      reviewFeedback: "fix",
      reviewLoopActive: true,
      reviewLoopRound: 1,
    });

    expect(createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: expect.objectContaining({
          review_loop_active: "true",
          review_loop_round: "1",
          review_feedback: "fix",
        }),
      }),
    );
  });
});
