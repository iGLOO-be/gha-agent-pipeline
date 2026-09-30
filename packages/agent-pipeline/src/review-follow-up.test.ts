import { describe, expect, it } from "vitest";
import { loadAgentConfig } from "./config.js";
import {
  formatFollowUpPromptSection,
  getCodeReviewFollowUpMode,
  threadMatchesCodeReviewFollowUpMode,
  type CodeReviewFollowUpContext,
} from "./review-follow-up.js";

describe("review-follow-up", () => {
  describe("getCodeReviewFollowUpMode", () => {
    it("defaults to agent_only when code_review is absent", () => {
      const config = loadAgentConfig();
      expect(getCodeReviewFollowUpMode(config)).toBe("agent_only");
    });
  });

  describe("threadMatchesCodeReviewFollowUpMode", () => {
    it("includes agent inline threads for agent_only even without [bot] login", () => {
      const thread = {
        id: "PRRT_x",
        isResolved: false,
        isOutdated: true,
        comments: [
          {
            id: 1,
            body: "_Docs_ | _Minor_ | _Quick win_\n\nFix the wording.",
            path: "docs/a.md",
            line: 10,
            authorLogin: "gha-agent-demo-bot",
          },
        ],
      };
      expect(threadMatchesCodeReviewFollowUpMode(thread, "agent_only")).toBe(
        true,
      );
      expect(threadMatchesCodeReviewFollowUpMode(thread, "all_authors")).toBe(
        true,
      );
    });

    it("excludes human threads in agent_only mode", () => {
      const thread = {
        id: "PRRT_y",
        isResolved: false,
        isOutdated: false,
        comments: [
          {
            id: 2,
            body: "Please rename this.",
            path: "src/a.ts",
            line: 1,
            authorLogin: "human-reviewer",
          },
        ],
      };
      expect(threadMatchesCodeReviewFollowUpMode(thread, "agent_only")).toBe(
        false,
      );
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
