import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  addReactionToIssueComment,
  addReactionToPullRequestReview,
  AGENT_COMMENT_MARKERS,
  buildRunUrl,
  clearAgentResumeLabels,
  extractAgentPlan,
  findPlanComment,
  findPlanCommentUrl,
  formatCommentsForPrompt,
  hasAgentMarkerInComments,
  markerFor,
  normalizeAgentPlanBody,
  parseRiskLevel,
  prependAgentMarker,
  readComments,
  unescapeToolString,
} from "./github.js";

const ENV_KEYS = [
  "GITHUB_SERVER_URL",
  "GITHUB_REPOSITORY",
  "GITHUB_RUN_ID",
] as const;

type Comment = Awaited<ReturnType<typeof readComments>>[number];

function makeComment(
  body: string,
  options: { id?: number; login?: string; url?: string } = {},
): Comment {
  return {
    id: options.id ?? 1,
    node_id: "node-1",
    url: "https://api.github.com/comment",
    html_url: options.url ?? "https://github.com/comment",
    body,
    user: { login: options.login ?? "bot" } as Comment["user"],
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
  } as Comment;
}

describe("tools/github", () => {
  describe("marker helpers", () => {
    it("renders a marker as HTML comment", () => {
      expect(markerFor("agent-plan")).toBe("<!-- agent-plan -->");
    });

    it("prepends a marker to a body", () => {
      const body = prependAgentMarker("Hello", "agent-implement");
      expect(body).toBe("<!-- agent-implement -->\nHello");
    });
  });

  describe("unescapeToolString", () => {
    it("unescapes JSON-style escape sequences", () => {
      expect(unescapeToolString("line1\\nline2")).toBe("line1\nline2");
      expect(unescapeToolString("tab\\there")).toBe("tab\there");
      expect(unescapeToolString('quote\\"end')).toBe('quote"end');
      expect(unescapeToolString("backslash\\\\")).toBe("backslash\\");
    });
  });

  describe("normalizeAgentPlanBody", () => {
    it("renames Revised Agent Plan heading", () => {
      const input = "## Revised Agent Plan\n\nSome plan";
      expect(normalizeAgentPlanBody(input)).toBe("## Agent Plan\nSome plan");
    });

    it("unescapes literal \\n characters", () => {
      const input = "## Agent Plan\\n\\nstep";
      expect(normalizeAgentPlanBody(input)).toBe("## Agent Plan\n\nstep");
    });

    it("preserves <details> HTML tags", () => {
      const input =
        "## Agent Plan\n\n### Executive summary\nTL;DR\n\n<details><summary>Full plan</summary>\n\n### Files to change\n- foo.ts\n\n</details>\n\n### Risk score\nlow";
      const result = normalizeAgentPlanBody(input);
      expect(result).toContain("<details><summary>Full plan</summary>");
      expect(result).toContain("</details>");
      expect(result).toContain("### Executive summary");
      expect(result).toContain("### Risk score\nlow");
    });

    it("leaves already-normal bodies unchanged", () => {
      const input = "## Agent Plan\nstep";
      expect(normalizeAgentPlanBody(input)).toBe(input);
    });
  });

  describe("extractAgentPlan", () => {
    it("extracts an Agent Plan section", () => {
      const text = "intro\n## Agent Plan\n\n- step 1\n\n---";
      expect(extractAgentPlan(text)).toBe("## Agent Plan\n- step 1\n\n---");
    });

    it("extracts a Revised Agent Plan section", () => {
      const text = "intro\n## Revised Agent Plan\n\n- step";
      expect(extractAgentPlan(text)).toBe("## Agent Plan\n- step");
    });

    it("extracts an Agent Plan section that contains <details> blocks", () => {
      const text =
        "intro\n## Agent Plan\n\n### Executive summary\nTL;DR\n\n<details><summary>Full plan</summary>\n\n### Files to change\n- foo.ts\n\n</details>\n\n### Risk score\nlow\n";
      const result = extractAgentPlan(text);
      expect(result).toContain("<details><summary>Full plan</summary>");
      expect(result).toContain("</details>");
      expect(result).toContain("### Executive summary");
      expect(result).toContain("### Risk score\nlow");
    });

    it("returns null when no plan section is present", () => {
      expect(extractAgentPlan("no plan here")).toBeNull();
    });
  });

  describe("findPlanComment", () => {
    const planBody = "## Agent Plan\n\nsummary";

    it("finds the latest plan comment by marker", () => {
      const comments = [
        makeComment("first plan\n<!-- agent-plan -->", {
          id: 1,
          url: "https://example.com/1",
        }),
        makeComment(prependAgentMarker(planBody, "agent-plan"), {
          id: 2,
          url: "https://example.com/2",
        }),
      ];
      expect(findPlanComment(comments)).toBe(
        prependAgentMarker(planBody, "agent-plan"),
      );
      expect(findPlanCommentUrl(comments)).toBe("https://example.com/2");
    });

    it("falls back to a body containing ## Agent Plan", () => {
      const comments = [
        makeComment("hi", {
          id: 1,
          url: "https://example.com/1",
          login: "human",
        }),
        makeComment(planBody, {
          id: 2,
          url: "https://example.com/2",
          login: "bot",
        }),
      ];
      expect(findPlanComment(comments)).toBe(planBody);
      expect(findPlanCommentUrl(comments)).toBe("https://example.com/2");
    });

    it("returns null when no plan exists", () => {
      expect(findPlanComment([])).toBeNull();
      expect(findPlanCommentUrl([])).toBeNull();
    });
  });

  describe("formatCommentsForPrompt", () => {
    it("returns a placeholder for empty comments", () => {
      expect(formatCommentsForPrompt([])).toBe("(no comments yet)");
    });

    it("formats comments with author and body", () => {
      const comments = [
        makeComment("hello", { id: 1, login: "alice" }),
        makeComment("world\nline", { id: 2, login: "bob" }),
      ];
      expect(formatCommentsForPrompt(comments)).toBe(
        "--- Comment by alice ---\nhello\n\n--- Comment by bob ---\nworld\nline",
      );
    });
  });

  describe("hasAgentMarkerInComments", () => {
    it("detects a marker in comment bodies", () => {
      const comments = [
        makeComment(prependAgentMarker("blocked", "agent-blocked")),
      ];
      expect(hasAgentMarkerInComments(comments, "agent-blocked")).toBe(true);
      expect(hasAgentMarkerInComments(comments, "agent-plan")).toBe(false);
    });
  });

  describe("buildRunUrl", () => {
    let originalValues: Record<string, string | undefined> = {};

    beforeEach(() => {
      originalValues = {};
      for (const key of ENV_KEYS) {
        originalValues[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of ENV_KEYS) {
        if (originalValues[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalValues[key];
        }
      }
    });

    it("returns null when env vars are missing", () => {
      expect(buildRunUrl()).toBeNull();
    });

    it("builds a valid run URL", () => {
      process.env.GITHUB_SERVER_URL = "https://github.com";
      process.env.GITHUB_REPOSITORY = "iGLOO-be/gha-agent-demo";
      process.env.GITHUB_RUN_ID = "42";

      expect(buildRunUrl()).toBe(
        "https://github.com/iGLOO-be/gha-agent-demo/actions/runs/42",
      );
    });
  });

  describe("clearAgentResumeLabels", () => {
    function makeOctokit(
      calls: Array<{ issueNumber: number; name: string }>,
      errors: Map<string, number> = new Map(),
    ) {
      return {
        issues: {
          removeLabel: async ({
            issue_number,
            name,
          }: {
            issue_number: number;
            name: string;
          }) => {
            calls.push({ issueNumber: issue_number, name });
            const key = `${issue_number}:${name}`;
            const status = errors.get(key);
            if (status) {
              const err = new Error(`HTTP ${status}`) as Error & {
                status: number;
              };
              err.status = status;
              throw err;
            }
            return { data: {} };
          },
        },
      };
    }

    it("clears labels from the issue only", async () => {
      const calls: Array<{ issueNumber: number; name: string }> = [];
      const octokit = makeOctokit(calls);
      await clearAgentResumeLabels(
        octokit as unknown as Parameters<typeof clearAgentResumeLabels>[0],
        "owner",
        "repo",
        { issueNumber: 99 },
      );
      expect(calls).toEqual([
        { issueNumber: 99, name: "agent-waiting-human" },
        { issueNumber: 99, name: "agent-failed" },
      ]);
    });

    it("clears labels from the PR only", async () => {
      const calls: Array<{ issueNumber: number; name: string }> = [];
      const octokit = makeOctokit(calls);
      await clearAgentResumeLabels(
        octokit as unknown as Parameters<typeof clearAgentResumeLabels>[0],
        "owner",
        "repo",
        { prNumber: 42 },
      );
      expect(calls).toEqual([
        { issueNumber: 42, name: "agent-waiting-human" },
        { issueNumber: 42, name: "agent-failed" },
      ]);
    });

    it("clears labels from both issue and PR", async () => {
      const calls: Array<{ issueNumber: number; name: string }> = [];
      const octokit = makeOctokit(calls);
      await clearAgentResumeLabels(
        octokit as unknown as Parameters<typeof clearAgentResumeLabels>[0],
        "owner",
        "repo",
        { issueNumber: 99, prNumber: 42 },
      );
      expect(calls).toEqual([
        { issueNumber: 99, name: "agent-waiting-human" },
        { issueNumber: 99, name: "agent-failed" },
        { issueNumber: 42, name: "agent-waiting-human" },
        { issueNumber: 42, name: "agent-failed" },
      ]);
    });

    it("deduplicates targets when issue and PR numbers are equal", async () => {
      const calls: Array<{ issueNumber: number; name: string }> = [];
      const octokit = makeOctokit(calls);
      await clearAgentResumeLabels(
        octokit as unknown as Parameters<typeof clearAgentResumeLabels>[0],
        "owner",
        "repo",
        { issueNumber: 7, prNumber: "7" },
      );
      expect(calls).toEqual([
        { issueNumber: 7, name: "agent-waiting-human" },
        { issueNumber: 7, name: "agent-failed" },
      ]);
    });

    it("ignores 404 errors", async () => {
      const calls: Array<{ issueNumber: number; name: string }> = [];
      const errors = new Map<string, number>([["99:agent-waiting-human", 404]]);
      const octokit = makeOctokit(calls, errors);
      await clearAgentResumeLabels(
        octokit as unknown as Parameters<typeof clearAgentResumeLabels>[0],
        "owner",
        "repo",
        { issueNumber: 99 },
      );
      expect(calls).toEqual([
        { issueNumber: 99, name: "agent-waiting-human" },
        { issueNumber: 99, name: "agent-failed" },
      ]);
    });

    it("propagates non-404 errors", async () => {
      const calls: Array<{ issueNumber: number; name: string }> = [];
      const errors = new Map<string, number>([["99:agent-failed", 500]]);
      const octokit = makeOctokit(calls, errors);
      await expect(
        clearAgentResumeLabels(
          octokit as unknown as Parameters<typeof clearAgentResumeLabels>[0],
          "owner",
          "repo",
          { issueNumber: 99 },
        ),
      ).rejects.toThrow("HTTP 500");
      expect(calls).toEqual([
        { issueNumber: 99, name: "agent-waiting-human" },
        { issueNumber: 99, name: "agent-failed" },
      ]);
    });

    it("ignores undefined, null, or invalid numbers", async () => {
      const calls: Array<{ issueNumber: number; name: string }> = [];
      const octokit = makeOctokit(calls);
      await clearAgentResumeLabels(
        octokit as unknown as Parameters<typeof clearAgentResumeLabels>[0],
        "owner",
        "repo",
        { issueNumber: undefined, prNumber: null },
      );
      expect(calls).toEqual([]);
    });
  });

  describe("reaction helpers", () => {
    it("adds a reaction to an issue comment", async () => {
      const calls: Array<{ method: string; args: unknown }> = [];
      const octokit = {
        reactions: {
          createForIssueComment: async (args: unknown) => {
            calls.push({ method: "createForIssueComment", args });
            return { data: { id: 1 } };
          },
        },
      };

      await addReactionToIssueComment(
        octokit as never,
        "owner",
        "repo",
        123,
        "rocket",
      );

      expect(calls).toEqual([
        {
          method: "createForIssueComment",
          args: {
            owner: "owner",
            repo: "repo",
            comment_id: 123,
            content: "rocket",
          },
        },
      ]);
    });

    it("adds a reaction to the first review comment", async () => {
      const calls: Array<{ method: string; args: unknown }> = [];
      const octokit = {
        pulls: {
          listCommentsForReview: async (args: unknown) => {
            calls.push({ method: "listCommentsForReview", args });
            return { data: [{ id: 1001 }, { id: 1002 }] };
          },
        },
        reactions: {
          createForPullRequestReviewComment: async (args: unknown) => {
            calls.push({ method: "createForPullRequestReviewComment", args });
            return { data: { id: 2 } };
          },
        },
      };

      await addReactionToPullRequestReview(
        octokit as never,
        "owner",
        "repo",
        42,
        456,
        "+1",
      );

      expect(calls.map((c) => c.method)).toEqual([
        "listCommentsForReview",
        "createForPullRequestReviewComment",
      ]);
      expect(calls[0]?.args).toEqual({
        owner: "owner",
        repo: "repo",
        pull_number: 42,
        review_id: 456,
      });
      expect(calls[1]?.args).toEqual({
        owner: "owner",
        repo: "repo",
        comment_id: 1001,
        content: "+1",
      });
    });

    it("returns null when the review has no comments", async () => {
      const octokit = {
        pulls: {
          listCommentsForReview: async () => ({ data: [] }),
        },
        reactions: {
          createForPullRequestReviewComment: async () => ({ data: { id: 3 } }),
        },
      };

      const result = await addReactionToPullRequestReview(
        octokit as never,
        "owner",
        "repo",
        42,
        456,
        "rocket",
      );

      expect(result).toBeNull();
    });
  });

  describe("parseRiskLevel", () => {
    it("parses risk level from a plan with <details> blocks", () => {
      const plan =
        "## Agent Plan\n\n### Executive summary\nTL;DR\n\n<details><summary>Full plan</summary>\n\n### Files to change\n- foo.ts\n\n</details>\n\n### Risk score\nmedium — moderate risk\n";
      expect(parseRiskLevel(plan)).toBe("medium");
    });

    it("parses low risk level", () => {
      expect(
        parseRiskLevel("## Agent Plan\n\n### Risk score\nlow — safe change"),
      ).toBe("low");
    });

    it("parses high risk level", () => {
      expect(
        parseRiskLevel("## Agent Plan\n\n### Risk score\nhigh — dangerous"),
      ).toBe("high");
    });

    it("returns null when no risk score section is present", () => {
      expect(parseRiskLevel("## Agent Plan\n\njust a plan")).toBeNull();
    });
  });
});
