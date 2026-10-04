import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import {
  addReactionToIssueComment,
  addReactionToPullRequestReview,
  AGENT_COMMENT_MARKERS,
  assertPullRequestNotConflicting,
  buildRunUrl,
  clearAgentResumeLabels,
  createPullRequestReview,
  createReplyForReviewComment,
  dispatchAgentPhaseWorkflow,
  PullRequestStillConflictingError,
  extractAgentAnswer,
  extractAgentPlan,
  normalizeAgentAnswerBody,
  findPlanComment,
  findPlanCommentUrl,
  formatCommentsForPrompt,
  buildReviewFixReviewCommentContext,
  formatBareReviewFixReviewBodiesSection,
  formatReviewCommentsForPrompt,
  formatReviewThreadsForPrompt,
  hasFailedCheckRuns,
  hasAgentMarkerInComments,
  isAgentInlineReviewCommentBody,
  isAutomatedReviewAuthor,
  isBareReviewFixFeedback,
  markerFor,
  pickLatestAgentCodeReview,
  normalizeAgentPlanBody,
  parseReviewCommentIdsFromText,
  appendRiskScoreSection,
  parseMergeRiskLevel,
  parseRiskLevel,
  stripRiskScoreSection,
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

  describe("extractAgentAnswer", () => {
    it("extracts an Agent answer section", () => {
      const text = "intro\n## Agent answer\n\n- bullet\n\n---";
      expect(extractAgentAnswer(text)).toContain("## Agent answer");
      expect(extractAgentAnswer(text)).toContain("- bullet");
    });

    it("normalizes heading casing", () => {
      const text = "## agent answer\n\nYes.";
      expect(extractAgentAnswer(text)).toBe("## Agent answer\nYes.");
    });

    it("wraps substantive output without a heading", () => {
      const text = "x".repeat(50);
      expect(extractAgentAnswer(text)).toBe(`## Agent answer\n\n${text}`);
    });

    it("returns null for empty or too-short output", () => {
      expect(extractAgentAnswer("")).toBeNull();
      expect(extractAgentAnswer("too short")).toBeNull();
    });

    it("strips trailing agent phase report from fallback section", () => {
      const text =
        "## Agent answer\n\nDone.\n\n## Agent phase report (Ask)\n\nmetrics";
      expect(extractAgentAnswer(text)).toBe("## Agent answer\nDone.");
    });
  });

  describe("normalizeAgentAnswerBody", () => {
    it("prefixes body when heading is missing", () => {
      expect(normalizeAgentAnswerBody("plain text")).toBe(
        "## Agent answer\n\nplain text",
      );
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

  describe("parseReviewCommentIdsFromText", () => {
    it("parses discussion_r anchors and pull comment URLs", () => {
      const text =
        "Fix https://github.com/org/repo/pull/1#discussion_r4039927492 and /pulls/1/comments/99";
      expect(parseReviewCommentIdsFromText(text)).toEqual([4039927492, 99]);
    });
  });

  describe("formatReviewThreadsForPrompt", () => {
    it("formats thread id, path, and root comment", () => {
      const out = formatReviewThreadsForPrompt([
        {
          id: "PRRT_abc",
          isResolved: false,
          isOutdated: false,
          comments: [
            {
              id: 42,
              body: "Use const",
              path: "src/a.ts",
              line: 3,
              authorLogin: "github-actions[bot]",
            },
          ],
        },
      ]);
      expect(out).toContain("PRRT_abc");
      expect(out).toContain("src/a.ts line 3");
      expect(out).toContain("Use const");

      const withoutBody = formatReviewThreadsForPrompt(
        [
          {
            id: "PRRT_abc",
            isResolved: false,
            isOutdated: false,
            comments: [
              {
                id: 42,
                body: "Use const",
                path: "src/a.ts",
                line: 3,
                authorLogin: "github-actions[bot]",
              },
            ],
          },
        ],
        { includeBody: false },
      );
      expect(withoutBody).toContain("PRRT_abc");
      expect(withoutBody).toContain("rootCommentId=42");
      expect(withoutBody).not.toContain("Use const");
    });
  });

  describe("formatReviewCommentsForPrompt", () => {
    it("formats path, line, author, and body", () => {
      const out = formatReviewCommentsForPrompt([
        {
          id: 1,
          path: "src/a.ts",
          line: 10,
          body: "Please fix",
          user: { login: "reviewer" },
        },
      ]);
      expect(out).toContain("id=1");
      expect(out).toContain("src/a.ts line 10");
      expect(out).toContain("Please fix");
    });
  });

  describe("isAutomatedReviewAuthor", () => {
    it("treats bot logins as automated", () => {
      expect(isAutomatedReviewAuthor("github-actions[bot]")).toBe(true);
      expect(isAutomatedReviewAuthor("foldio-app-agent-gha-agent[bot]")).toBe(
        true,
      );
      expect(isAutomatedReviewAuthor("human")).toBe(false);
      expect(isAutomatedReviewAuthor("gha-agent-demo-bot")).toBe(false);
    });
  });

  describe("isAgentInlineReviewCommentBody", () => {
    it("detects agent code-review inline tag line", () => {
      expect(
        isAgentInlineReviewCommentBody(
          "_Docs_ | _Minor_ | _Quick win_\n\nPlease fix.",
        ),
      ).toBe(true);
      expect(isAgentInlineReviewCommentBody("Please fix.")).toBe(false);
    });
  });

  describe("isBareReviewFixFeedback", () => {
    it("detects bare /agent fix triggers", () => {
      expect(isBareReviewFixFeedback("/agent fix")).toBe(true);
      expect(isBareReviewFixFeedback("  /agent fix  ")).toBe(true);
    });

    it("is false when feedback or discussion links are present", () => {
      expect(isBareReviewFixFeedback("/agent fix please update")).toBe(false);
      expect(
        isBareReviewFixFeedback("/agent fix see #discussion_r4146347607"),
      ).toBe(false);
    });
  });

  describe("pickLatestAgentCodeReview", () => {
    it("prefers the newest agent code-review with a commit", () => {
      const marker = markerFor(AGENT_COMMENT_MARKERS.codeReview);
      const older = {
        id: 1,
        body: `${marker}\nolder`,
        commit_id: "aaa",
        submitted_at: "2026-01-01T00:00:00Z",
        html_url: "https://example/1",
      };
      const newer = {
        id: 2,
        body: `${marker}\nnewer`,
        commit_id: "bbb",
        submitted_at: "2026-02-01T00:00:00Z",
        html_url: "https://example/2",
      };
      expect(pickLatestAgentCodeReview([older, newer])).toEqual(newer);
    });
  });

  describe("formatBareReviewFixReviewBodiesSection", () => {
    it("includes the latest agent code-review body", () => {
      const marker = markerFor(AGENT_COMMENT_MARKERS.codeReview);
      const section = formatBareReviewFixReviewBodiesSection([
        {
          id: 9,
          body: `${marker}\n## Walkthrough\nDetails`,
          commit_id: "sha",
          submitted_at: "2026-03-01T00:00:00Z",
          html_url: "https://example/review/9",
          user: { login: "gha-agent-demo-bot[bot]" },
        },
      ]);
      expect(section).toContain("id=9");
      expect(section).toContain("Walkthrough");
    });
  });

  describe("buildReviewFixReviewCommentContext", () => {
    it("loads all line comments on a bare /agent fix trigger", async () => {
      const botComment = {
        id: 414,
        path: "src/a.ts",
        line: 1,
        body: "_Docs_ | _Minor_ | _Quick win_\nFix me",
        user: { login: "gha-agent-demo-bot[bot]" },
        diff_hunk: "@@",
      };
      const paginate = vi
        .fn()
        .mockResolvedValueOnce([botComment])
        .mockResolvedValueOnce([]);
      const octokit = {
        paginate,
        pulls: {
          listReviews: vi.fn(),
        },
        rest: {
          pulls: {
            listReviewComments: vi.fn(),
          },
        },
      } as never;

      const context = await buildReviewFixReviewCommentContext(
        octokit,
        "owner",
        "repo",
        42,
        { reviewFeedback: "/agent fix" },
      );

      expect(context.bareFixTrigger).toBe(true);
      expect(context.lineCommentsSection).toContain("Fix me");
      expect(context.lineCommentsSection).not.toBe("(no review line comments)");
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

    it("parses capitalized risk level on the first line (Foldio-style)", () => {
      expect(
        parseRiskLevel(
          "### Risk score\n\nLow — single-file, local refactor with zero behavioral change.",
        ),
      ).toBe("low");
    });
  });

  describe("parseMergeRiskLevel", () => {
    it("parses Minimal, Moderate, and High from ## Merge risk", () => {
      expect(
        parseMergeRiskLevel("## Merge risk\n\n**Minimal** — safe tweak."),
      ).toBe("low");
      expect(
        parseMergeRiskLevel("## Merge risk\n\nModerate — auth path touched."),
      ).toBe("medium");
      expect(parseMergeRiskLevel("## Merge risk\n\nHigh — breaking API.")).toBe(
        "high",
      );
    });

    it("returns null when section is missing", () => {
      expect(
        parseMergeRiskLevel("## Walkthrough\n\nonly walkthrough"),
      ).toBeNull();
    });

    it("anchors the level so justification words cannot win", () => {
      expect(
        parseMergeRiskLevel(
          "## Merge risk\n\n**Moderate** — minimal blast radius.",
        ),
      ).toBe("medium");
      expect(
        parseMergeRiskLevel(
          "## Merge risk\n\n**High** — minimal blast radius, low chance of breakage.",
        ),
      ).toBe("high");
    });

    it("tolerates bullets and a short level/risk prefix", () => {
      expect(
        parseMergeRiskLevel("## Merge risk\n\n- **High** — breaking API."),
      ).toBe("high");
      expect(
        parseMergeRiskLevel("## Merge risk\n\nLevel: **High** — breaking API."),
      ).toBe("high");
      expect(
        parseMergeRiskLevel("## Merge risk\n\nRisk: Minimal — safe tweak."),
      ).toBe("low");
    });
  });

  describe("appendRiskScoreSection", () => {
    it("appends a risk section and strips any legacy duplicate", () => {
      const body =
        "## Agent Plan\n\n### Next steps\n- review\n\n### Risk score\nold — ignore";
      const result = appendRiskScoreSection(body, "low", "Safe change.");
      expect(result).toContain("### Risk score\n\nlow — Safe change.");
      expect(result).not.toContain("old — ignore");
      expect(stripRiskScoreSection(result)).toBe(
        "## Agent Plan\n\n### Next steps\n- review",
      );
    });
  });

  describe("createPullRequestReview", () => {
    function makeOctokit(
      createReview: (args: {
        event: string;
        comments?: unknown;
      }) => Promise<{ data: { id: number; html_url: string } }>,
    ) {
      return {
        pulls: {
          get: async () => ({ data: { head: { sha: "abc123" } } }),
          createReview,
        },
      } as unknown as Parameters<typeof createPullRequestReview>[0];
    }

    function unprocessable(message: string) {
      const error = new Error(message) as Error & { status: number };
      error.status = 422;
      return error;
    }

    it("posts COMMENT with inline comments", async () => {
      const createReview = async (args: {
        event: string;
        comments?: unknown;
      }) => {
        expect(args.event).toBe("COMMENT");
        expect(args.comments).toEqual([
          {
            path: "src/foo.ts",
            body: "nit",
            line: 12,
            side: "RIGHT",
          },
        ]);
        return { data: { id: 9, html_url: "https://example/review/9" } };
      };

      const result = await createPullRequestReview(
        makeOctokit(createReview),
        "owner",
        "repo",
        42,
        {
          event: "COMMENT",
          body: "## Standards\nnone",
          comments: [{ path: "src/foo.ts", line: 12, body: "nit" }],
        },
      );
      expect(result.id).toBe(9);
    });

    it("retries without inline comments on 422", async () => {
      const events: Array<{ event: string; hasComments: boolean }> = [];
      const createReview = async (args: {
        event: string;
        comments?: unknown;
      }) => {
        events.push({
          event: args.event,
          hasComments: Boolean(args.comments),
        });
        if (args.comments) {
          throw unprocessable(
            "Pull request review thread line must be part of the diff",
          );
        }
        return { data: { id: 11, html_url: "https://example/review/11" } };
      };

      const result = await createPullRequestReview(
        makeOctokit(createReview),
        "owner",
        "repo",
        42,
        {
          event: "COMMENT",
          body: "## Standards\nnone",
          comments: [{ path: "src/foo.ts", line: 99, body: "bad line" }],
        },
      );
      expect(result.id).toBe(11);
      expect(events).toEqual([
        { event: "COMMENT", hasComments: true },
        { event: "COMMENT", hasComments: false },
      ]);
    });

    it("falls back from REQUEST_CHANGES to COMMENT on own-PR 422", async () => {
      const events: string[] = [];
      const createReview = async (args: {
        event: string;
        comments?: unknown;
      }) => {
        events.push(args.event);
        if (args.event === "REQUEST_CHANGES") {
          throw unprocessable(
            "Can not request changes on your own pull request",
          );
        }
        return { data: { id: 12, html_url: "https://example/review/12" } };
      };

      const result = await createPullRequestReview(
        makeOctokit(createReview),
        "owner",
        "repo",
        42,
        {
          event: "REQUEST_CHANGES",
          body: "## Spec\nmissing",
        },
      );
      expect(result.id).toBe(12);
      expect(events).toEqual(["REQUEST_CHANGES", "COMMENT"]);
    });
  });

  describe("hasFailedCheckRuns", () => {
    it("detects failure and timed_out conclusions", () => {
      expect(
        hasFailedCheckRuns([
          {
            id: 1,
            name: "lint",
            status: "completed",
            conclusion: "failure",
            detailsUrl: null,
            outputTitle: null,
            outputSummary: null,
            outputText: null,
          },
        ]),
      ).toBe(true);
      expect(
        hasFailedCheckRuns([
          {
            id: 2,
            name: "test",
            status: "completed",
            conclusion: "success",
            detailsUrl: null,
            outputTitle: null,
            outputSummary: null,
            outputText: null,
          },
        ]),
      ).toBe(false);
    });
  });

  describe("assertPullRequestNotConflicting", () => {
    it("throws PullRequestStillConflictingError when dirty and behind base", async () => {
      const octokit = {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              mergeable: false,
              mergeable_state: "dirty",
              base: { label: "owner:main" },
              head: { label: "owner:branch" },
            },
          }),
        },
        repos: {
          compareCommits: vi.fn().mockResolvedValue({
            data: { behind_by: 5 },
          }),
        },
      } as unknown as Octokit;

      await expect(
        assertPullRequestNotConflicting(octokit, "o", "r", 1, {
          maxAttempts: 1,
          delayMs: 0,
        }),
      ).rejects.toBeInstanceOf(PullRequestStillConflictingError);
    });
  });

  describe("createReplyForReviewComment", () => {
    it("posts a marked reply on a review comment thread", async () => {
      const octokit = {
        pulls: {
          createReplyForReviewComment: async (args: {
            comment_id: number;
            body: string;
          }) => {
            expect(args.comment_id).toBe(55);
            expect(args.body).toContain(AGENT_COMMENT_MARKERS.reviewFixReply);
            expect(args.body).toContain("Fixed in latest commit");
            return {
              data: { id: 99, html_url: "https://example/reply/99" },
            };
          },
        },
      } as unknown as Parameters<typeof createReplyForReviewComment>[0];

      const reply = await createReplyForReviewComment(
        octokit,
        "owner",
        "repo",
        42,
        55,
        "Fixed in latest commit",
      );
      expect(reply.id).toBe(99);
    });
  });

  describe("dispatchAgentPhaseWorkflow", () => {
    it("dispatches agent-phase with default branch ref", async () => {
      let dispatched: Record<string, unknown> | undefined;
      const octokit = {
        repos: {
          get: async () => ({ data: { default_branch: "main" } }),
        },
        actions: {
          createWorkflowDispatch: async (args: Record<string, unknown>) => {
            dispatched = args;
          },
        },
      } as unknown as Parameters<typeof dispatchAgentPhaseWorkflow>[0];

      await dispatchAgentPhaseWorkflow(octokit, "owner", "repo", {
        phase: "code-review",
        commentId: 1,
        issueNumber: 2,
        prNumber: 3,
        headRef: "agent/2-slug",
        reviewInstructions: "recheck",
      });

      expect(dispatched?.workflow_id).toBe(".github/workflows/agent-phase.yml");
      expect(dispatched?.ref).toBe("main");
      expect(dispatched?.inputs).toMatchObject({
        phase: "code-review",
        comment_id: "1",
        issue_number: "2",
        pr_number: "3",
        head_ref: "agent/2-slug",
        review_instructions: "recheck",
      });
    });
  });
});
