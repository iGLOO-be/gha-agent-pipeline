import type { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { loadAgentConfig } from "./config.js";
import * as github from "./tools/github.js";
import {
  buildReviewFixThreadContext,
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

  describe("buildReviewFixThreadContext", () => {
    it("omits resolved threads and filters bots unless bare fix", async () => {
      const octokit = {} as Octokit;
      vi.spyOn(github, "listPullRequestReviewThreads").mockResolvedValue([
        {
          id: "PRRT_resolved",
          isResolved: true,
          isOutdated: false,
          comments: [
            {
              id: 1,
              body: "done",
              path: "a.ts",
              line: 1,
              authorLogin: "human",
            },
          ],
        },
        {
          id: "PRRT_human",
          isResolved: false,
          isOutdated: false,
          comments: [
            {
              id: 2,
              body: "fix this",
              path: "b.ts",
              line: 2,
              authorLogin: "human",
            },
          ],
        },
        {
          id: "PRRT_bot",
          isResolved: false,
          isOutdated: false,
          comments: [
            {
              id: 3,
              body: "nit",
              path: "c.ts",
              line: 3,
              authorLogin: "dependabot[bot]",
            },
          ],
        },
      ]);

      const scoped = await buildReviewFixThreadContext(
        octokit,
        "owner",
        "repo",
        9,
        false,
      );
      expect(scoped.openThreadsMarkdown).toContain("PRRT_human");
      expect(scoped.openThreadsMarkdown).not.toContain("PRRT_resolved");
      expect(scoped.openThreadsMarkdown).not.toContain("PRRT_bot");

      const bare = await buildReviewFixThreadContext(
        octokit,
        "owner",
        "repo",
        9,
        true,
      );
      expect(bare.openThreadsMarkdown).toContain("PRRT_bot");

      vi.restoreAllMocks();
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
