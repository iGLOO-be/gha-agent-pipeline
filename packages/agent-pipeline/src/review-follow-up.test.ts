import { describe, expect, it } from "vitest";
import { loadAgentConfig } from "./config.js";
import {
  formatFollowUpPromptSection,
  getCodeReviewFollowUpMode,
  type CodeReviewFollowUpContext,
} from "./review-follow-up.js";

describe("review-follow-up", () => {
  describe("getCodeReviewFollowUpMode", () => {
    it("defaults to agent_only when code_review is absent", () => {
      const config = loadAgentConfig();
      expect(getCodeReviewFollowUpMode(config)).toBe("agent_only");
    });
  });

  describe("formatFollowUpPromptSection", () => {
    it("includes open threads and last review metadata", () => {
      const context: CodeReviewFollowUpContext = {
        mode: "agent_only",
        openThreadsMarkdown: "(no open review threads in scope)",
        openThreads: [],
        lastAgentReview: {
          id: 9,
          commitSha: "abc1234",
          htmlUrl: "https://github.com/o/r/pull/1#review-9",
          submittedAt: "2026-01-01T00:00:00Z",
        },
        warnings: [],
      };
      const section = formatFollowUpPromptSection(context);
      expect(section).toContain("Prior review follow-up");
      expect(section).toContain("abc1234");
      expect(section).toContain("id=9");
    });
  });
});
