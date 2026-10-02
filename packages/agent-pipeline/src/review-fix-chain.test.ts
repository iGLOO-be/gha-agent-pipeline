import { describe, expect, it } from "vitest";
import { loadAgentConfig } from "./config.js";
import {
  parseReviewFixChainCodeReviewFromText,
  shouldChainCodeReviewAfterReviewFix,
  stripReviewFixChainFlags,
} from "./review-fix-chain.js";

describe("review-fix-chain", () => {
  it("detects slash chain flags", () => {
    expect(parseReviewFixChainCodeReviewFromText("/agent fix --recheck")).toBe(
      true,
    );
    expect(
      parseReviewFixChainCodeReviewFromText("/agent fix +code-review"),
    ).toBe(true);
    expect(parseReviewFixChainCodeReviewFromText("/agent fix")).toBe(false);
  });

  it("strips chain flags from feedback", () => {
    expect(stripReviewFixChainFlags("/agent fix --recheck please")).toBe(
      "/agent fix please",
    );
    expect(stripReviewFixChainFlags("fix +code-review now")).toBe("fix now");
  });

  it("chains when env, config, or slash flag is set", () => {
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

    const repoConfig = loadAgentConfig();
    expect(shouldChainCodeReviewAfterReviewFix(repoConfig, {})).toBe(
      repoConfig.review_fix?.follow_up?.code_review === true,
    );
  });
});
