import { describe, expect, it } from "vitest";
import {
  REVIEW_FIX_CHAINED_FEEDBACK_MAX_CHARS,
  REVIEW_FIX_TRIGGER_MAX_CHARS,
  truncateReviewFixFeedbackForDispatch,
} from "./review-fix-dispatch-feedback.js";

describe("truncateReviewFixFeedbackForDispatch", () => {
  it("returns short feedback unchanged", () => {
    expect(
      truncateReviewFixFeedbackForDispatch("fix the tests", {
        maxChars: REVIEW_FIX_TRIGGER_MAX_CHARS,
      }),
    ).toBe("fix the tests");
  });

  it("truncates with a note and optional source URL", () => {
    const long = "x".repeat(REVIEW_FIX_TRIGGER_MAX_CHARS + 500);
    const out = truncateReviewFixFeedbackForDispatch(long, {
      maxChars: REVIEW_FIX_TRIGGER_MAX_CHARS,
      sourceUrl: "https://github.com/o/r/pull/1",
    });
    expect(out.length).toBeLessThanOrEqual(REVIEW_FIX_TRIGGER_MAX_CHARS);
    expect(out).toContain("truncated");
    expect(out).toContain("https://github.com/o/r/pull/1");
  });

  it("respects the chained review-loop limit", () => {
    const long = "y".repeat(REVIEW_FIX_CHAINED_FEEDBACK_MAX_CHARS + 100);
    const out = truncateReviewFixFeedbackForDispatch(long, {
      maxChars: REVIEW_FIX_CHAINED_FEEDBACK_MAX_CHARS,
    });
    expect(out.length).toBeLessThanOrEqual(
      REVIEW_FIX_CHAINED_FEEDBACK_MAX_CHARS,
    );
  });
});
