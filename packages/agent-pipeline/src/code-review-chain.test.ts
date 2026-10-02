import type { Octokit } from "@octokit/rest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentConfig } from "./config.js";

const dispatchMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("./tools/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools/github.js")>();
  return {
    ...actual,
    dispatchAgentPhaseWorkflow: dispatchMock,
  };
});

import {
  chainCodeReviewAfterImplement,
  chainCodeReviewAfterReviewFix,
  parseChainCodeReviewFromSlashText,
  shouldChainCodeReviewAfterImplement,
  shouldChainCodeReviewAfterReviewFix,
  stripChainCodeReviewSlashFlags,
} from "./code-review-chain.js";

describe("code-review-chain", () => {
  it("detects slash chain flags", () => {
    expect(parseChainCodeReviewFromSlashText("/agent fix --recheck")).toBe(
      true,
    );
    expect(
      parseChainCodeReviewFromSlashText("/agent implement +code-review"),
    ).toBe(true);
    expect(
      parseChainCodeReviewFromSlashText("/agent implement --code-review"),
    ).toBe(true);
    expect(parseChainCodeReviewFromSlashText("/agent implement")).toBe(false);
  });

  it("strips chain flags from feedback", () => {
    expect(stripChainCodeReviewSlashFlags("/agent fix --recheck please")).toBe(
      "/agent fix please",
    );
    expect(stripChainCodeReviewSlashFlags("implement +code-review now")).toBe(
      "implement now",
    );
  });

  it("chains review-fix when env, config, or slash flag is set", () => {
    const config = {
      ...loadAgentConfig(),
      review_fix: { follow_up: { code_review: false } },
    };
    expect(
      shouldChainCodeReviewAfterReviewFix(config, {
        chainCodeReviewEnv: "true",
      }),
    ).toBe(true);
    expect(
      shouldChainCodeReviewAfterReviewFix(
        {
          ...config,
          review_fix: { follow_up: { code_review: true } },
        },
        {},
      ),
    ).toBe(true);
    expect(
      shouldChainCodeReviewAfterReviewFix(config, {
        reviewFeedback: "please --recheck",
      }),
    ).toBe(true);
    expect(shouldChainCodeReviewAfterReviewFix(config, {})).toBe(false);
  });

  it("chains implement when env or config is set", () => {
    const config = {
      ...loadAgentConfig(),
      implement: { follow_up: { code_review: false } },
    };
    expect(
      shouldChainCodeReviewAfterImplement(config, {
        chainCodeReviewEnv: "true",
      }),
    ).toBe(true);
    expect(
      shouldChainCodeReviewAfterImplement(
        {
          ...config,
          implement: { follow_up: { code_review: true } },
        },
        {},
      ),
    ).toBe(true);
    expect(shouldChainCodeReviewAfterImplement(config, {})).toBe(false);
  });

  describe("follow-up dispatch", () => {
    const octokit = {} as Octokit;
    const envSnapshot = { ...process.env };

    beforeEach(() => {
      dispatchMock.mockClear();
      process.env.COMMENT_ID = "42";
    });

    afterEach(() => {
      process.env = { ...envSnapshot };
    });

    it("forwards REACTION_TARGET on review-fix chain", async () => {
      process.env.REVIEW_FIX_CHAIN_CODE_REVIEW = "true";
      process.env.REACTION_TARGET = "pull_request_review";
      const config = {
        ...loadAgentConfig(),
        review_fix: { follow_up: { code_review: false } },
      };

      await chainCodeReviewAfterReviewFix(octokit, "owner", "repo", config, {
        issueNumber: 1,
        prNumber: 2,
        agentBranch: "agent/1-slug",
        reviewFeedback: "fix",
      });

      expect(dispatchMock).toHaveBeenCalledWith(
        octokit,
        "owner",
        "repo",
        expect.objectContaining({
          phase: "code-review",
          reactionTarget: "pull_request_review",
          commentId: "42",
          prNumber: 2,
        }),
      );
    });

    it("dispatches implement chain when enabled", async () => {
      process.env.IMPLEMENT_CHAIN_CODE_REVIEW = "true";
      const config = {
        ...loadAgentConfig(),
        implement: { follow_up: { code_review: false } },
      };

      await chainCodeReviewAfterImplement(octokit, "owner", "repo", config, {
        issueNumber: 1,
        prNumber: 2,
        agentBranch: "agent/1-slug",
      });

      expect(dispatchMock).toHaveBeenCalledWith(
        octokit,
        "owner",
        "repo",
        expect.objectContaining({
          phase: "code-review",
          headRef: "agent/1-slug",
        }),
      );
    });

    it("skips dispatch when COMMENT_ID is missing", async () => {
      delete process.env.COMMENT_ID;
      process.env.REVIEW_FIX_CHAIN_CODE_REVIEW = "true";
      const config = {
        ...loadAgentConfig(),
        review_fix: { follow_up: { code_review: true } },
      };

      await chainCodeReviewAfterReviewFix(octokit, "owner", "repo", config, {
        issueNumber: 1,
        prNumber: 2,
        agentBranch: "agent/1-slug",
        reviewFeedback: "fix",
      });

      expect(dispatchMock).not.toHaveBeenCalled();
    });
  });
});
