import { describe, expect, it } from "vitest";
import { loadAgentConfig } from "./config.js";
import {
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

  it("chains implement when env, config, or slash flag is set", () => {
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
    expect(
      shouldChainCodeReviewAfterImplement(config, {
        triggerText: "/agent implement --code-review",
      }),
    ).toBe(true);
    expect(shouldChainCodeReviewAfterImplement(config, {})).toBe(false);
  });
});
