import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "./config.js";
import {
  getReviewLoopMaxRounds,
  isReviewLoopActiveFromEnv,
  isReviewLoopEnabled,
  parseReviewLoopRoundFromEnv,
} from "./review-loop.js";

const baseConfig = {
  review_loop: { enabled: false, max_rounds: 3 },
} as AgentConfig;

describe("review-loop helpers", () => {
  afterEach(() => {
    delete process.env.REVIEW_LOOP_ACTIVE;
    delete process.env.REVIEW_LOOP_ROUND;
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
    process.env.REVIEW_LOOP_ACTIVE = "true";
    expect(isReviewLoopActiveFromEnv()).toBe(true);
    process.env.REVIEW_LOOP_ROUND = "2";
    expect(parseReviewLoopRoundFromEnv()).toBe(2);
    process.env.REVIEW_LOOP_ROUND = "bad";
    expect(parseReviewLoopRoundFromEnv()).toBe(0);
  });
});

describe("dispatchAgentPhaseWorkflow review loop inputs", () => {
  it("forwards chain and loop fields", async () => {
    const createWorkflowDispatch = vi.fn().mockResolvedValue(undefined);
    const octokit = {
      repos: {
        get: vi.fn().mockResolvedValue({ data: { default_branch: "main" } }),
      },
      actions: { createWorkflowDispatch },
    };

    const { dispatchAgentPhaseWorkflow } = await import("./tools/github.js");
    await dispatchAgentPhaseWorkflow(octokit as never, "o", "r", {
      phase: "review-fix",
      commentId: "99",
      issueNumber: 1,
      prNumber: 2,
      headRef: "agent/1",
      reviewFeedback: "fix",
      chainCodeReview: true,
      reviewLoopActive: true,
      reviewLoopRound: 1,
    });

    expect(createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: expect.objectContaining({
          chain_code_review: "true",
          review_loop_active: "true",
          review_loop_round: "1",
          review_feedback: "fix",
        }),
      }),
    );
  });
});
