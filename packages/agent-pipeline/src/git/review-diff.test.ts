import { describe, expect, it } from "vitest";
import {
  isSafeGitRef,
  MAX_REVIEW_DIFF_CHARS,
  truncateReviewDiff,
} from "./review-diff.js";

describe("review-diff", () => {
  describe("isSafeGitRef", () => {
    it("accepts typical branch names", () => {
      expect(isSafeGitRef("main")).toBe(true);
      expect(isSafeGitRef("feat/agent-code-review")).toBe(true);
    });

    it("rejects shell metacharacters", () => {
      expect(isSafeGitRef("main; rm -rf /")).toBe(false);
      expect(isSafeGitRef("origin/main && echo")).toBe(false);
    });
  });

  describe("truncateReviewDiff", () => {
    it("leaves short diffs unchanged", () => {
      expect(truncateReviewDiff("abc", 10)).toEqual({
        diff: "abc",
        truncated: false,
      });
    });

    it("truncates long diffs", () => {
      const result = truncateReviewDiff("x".repeat(20), 8);
      expect(result.truncated).toBe(true);
      expect(result.diff.startsWith("xxxxxxxx")).toBe(true);
      expect(result.diff).toContain("truncated 12 characters");
    });

    it("uses the default max length", () => {
      const result = truncateReviewDiff("ok");
      expect(result.truncated).toBe(false);
      expect(MAX_REVIEW_DIFF_CHARS).toBeGreaterThan(0);
    });
  });
});
