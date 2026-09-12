import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { AgentPhase } from "./config.js";
import {
  buildStartupComment,
  manageAgentWorkingLabel,
  reactToAgentTrigger,
  resolveStartupTarget,
  runAgentPhase,
  type StartupTarget,
} from "./lifecycle.js";

const RUN_ENV_KEYS = [
  "GITHUB_SERVER_URL",
  "GITHUB_REPOSITORY",
  "GITHUB_RUN_ID",
  "COMMENT_ID",
  "REACTION_TARGET",
  "SUCCESS_REACTION",
  "PR_NUMBER",
] as const;

type MockOctokit = {
  _calls: Array<{ method: string; args: unknown[] }>;
  issues: {
    getLabel: (...args: unknown[]) => Promise<unknown>;
    createLabel: (...args: unknown[]) => Promise<unknown>;
    addLabels: (...args: unknown[]) => Promise<unknown>;
    removeLabel: (...args: unknown[]) => Promise<unknown>;
    createComment: (...args: unknown[]) => Promise<unknown>;
  };
  reactions: {
    createForIssueComment: (...args: unknown[]) => Promise<unknown>;
    createForPullRequestReviewComment: (...args: unknown[]) => Promise<unknown>;
  };
  pulls: {
    listCommentsForReview: (...args: unknown[]) => Promise<unknown>;
  };
};

function makeOctokit(): MockOctokit {
  const calls: MockOctokit["_calls"] = [];
  const octokit: MockOctokit = {
    issues: {
      getLabel: async (...args) => {
        calls.push({ method: "issues.getLabel", args });
        throw Object.assign(new Error("Not found"), { status: 404 });
      },
      createLabel: async (...args) => {
        calls.push({ method: "issues.createLabel", args });
        return { data: {} };
      },
      addLabels: async (...args) => {
        calls.push({ method: "issues.addLabels", args });
        return { data: {} };
      },
      removeLabel: async (...args) => {
        calls.push({ method: "issues.removeLabel", args });
        return { data: {} };
      },
      createComment: async (...args) => {
        calls.push({ method: "issues.createComment", args });
        return { data: { id: 1 } };
      },
    },
    reactions: {
      createForIssueComment: async (...args) => {
        calls.push({ method: "reactions.createForIssueComment", args });
        return { data: {} };
      },
      createForPullRequestReviewComment: async (...args) => {
        calls.push({
          method: "reactions.createForPullRequestReviewComment",
          args,
        });
        return { data: {} };
      },
    },
    pulls: {
      listCommentsForReview: async (...args) => {
        calls.push({ method: "pulls.listCommentsForReview", args });
        return { data: [{ id: 1001 }] };
      },
    },
    _calls: calls,
  };
  return octokit;
}

describe("lifecycle", () => {
  beforeEach(() => {
    for (const key of RUN_ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of RUN_ENV_KEYS) {
      delete process.env[key];
    }
  });

  describe("buildStartupComment", () => {
    it("renders a startup comment for an issue phase with run URL", () => {
      process.env.GITHUB_SERVER_URL = "https://github.com";
      process.env.GITHUB_REPOSITORY = "owner/repo";
      process.env.GITHUB_RUN_ID = "12345";

      const body = buildStartupComment("plan", "issue", 7);
      expect(body).toContain("<!-- agent-startup -->");
      expect(body).toContain("Agent Plan");
      expect(body).toContain("issue #7");
      expect(body).toContain(
        "https://github.com/owner/repo/actions/runs/12345",
      );
    });

    it.each([
      ["plan", "Plan"],
      ["implement", "Implement"],
      ["yolo", "Yolo"],
      ["review-fix", "Review Fix"],
      ["ci-fix", "CI Fix"],
    ] as Array<[AgentPhase, string]>)(
      'renders label for phase "%s"',
      (phase, label) => {
        const body = buildStartupComment(phase, "pr", 42);
        expect(body).toContain(`Agent ${label}`);
        expect(body).toContain("PR #42");
      },
    );

    it("falls back when run URL is unavailable", () => {
      const body = buildStartupComment("implement", "issue", 8);
      expect(body).toContain("<!-- agent-startup -->");
      expect(body).toContain("(run URL unavailable)");
    });
  });

  describe("resolveStartupTarget", () => {
    it("targets the issue for issue-only phases", () => {
      expect(resolveStartupTarget("plan", 7)).toEqual<StartupTarget>({
        type: "issue",
        number: 7,
      });
    });

    it("targets the PR when prNumber is provided", () => {
      expect(resolveStartupTarget("review-fix", 7, 42)).toEqual<StartupTarget>({
        type: "pr",
        number: 42,
      });
    });

    it("ignores non-finite PR numbers", () => {
      expect(resolveStartupTarget("ci-fix", 7, NaN)).toEqual<StartupTarget>({
        type: "issue",
        number: 7,
      });
    });
  });

  describe("manageAgentWorkingLabel", () => {
    it("ensures the label and adds it to the issue", async () => {
      const octokit = makeOctokit();
      await manageAgentWorkingLabel(
        octokit as never,
        "owner",
        "repo",
        "add",
        7,
      );

      expect(octokit._calls.map((c) => c.method)).toEqual([
        "issues.getLabel",
        "issues.createLabel",
        "issues.addLabels",
      ]);
      const addCall = octokit._calls.find(
        (c) => c.method === "issues.addLabels",
      );
      expect(addCall?.args[0]).toMatchObject({
        issue_number: 7,
        labels: ["agent-working"],
      });
    });

    it("adds the label to both issue and PR", async () => {
      const octokit = makeOctokit();
      await manageAgentWorkingLabel(
        octokit as never,
        "owner",
        "repo",
        "add",
        7,
        42,
      );

      const addCalls = octokit._calls.filter(
        (c) => c.method === "issues.addLabels",
      );
      expect(
        addCalls.map(
          (c) => (c.args[0] as { issue_number: number }).issue_number,
        ),
      ).toEqual([7, 42]);
    });

    it("deduplicates when issue and PR numbers are equal", async () => {
      const octokit = makeOctokit();
      await manageAgentWorkingLabel(
        octokit as never,
        "owner",
        "repo",
        "add",
        7,
        7,
      );

      const addCalls = octokit._calls.filter(
        (c) => c.method === "issues.addLabels",
      );
      expect(addCalls).toHaveLength(1);
      expect(addCalls[0]?.args[0]).toMatchObject({ issue_number: 7 });
    });

    it("removes the label from both issue and PR", async () => {
      const octokit = makeOctokit();
      await manageAgentWorkingLabel(
        octokit as never,
        "owner",
        "repo",
        "remove",
        7,
        42,
      );

      const removeCalls = octokit._calls.filter(
        (c) => c.method === "issues.removeLabel",
      );
      expect(
        removeCalls.map(
          (c) => (c.args[0] as { issue_number: number }).issue_number,
        ),
      ).toEqual([7, 42]);
    });

    it("ignores 404 on remove", async () => {
      const octokit = makeOctokit();
      octokit.issues.removeLabel = async () => {
        octokit._calls.push({ method: "issues.removeLabel", args: [] });
        throw Object.assign(new Error("Not found"), { status: 404 });
      };
      await manageAgentWorkingLabel(
        octokit as never,
        "owner",
        "repo",
        "remove",
        7,
      );
      expect(
        octokit._calls.filter((c) => c.method === "issues.removeLabel"),
      ).toHaveLength(1);
    });
  });

  describe("reactToAgentTrigger", () => {
    it("adds an issue comment reaction on success", async () => {
      process.env.COMMENT_ID = "123";
      process.env.SUCCESS_REACTION = "rocket";

      const octokit = makeOctokit();
      await reactToAgentTrigger(octokit as never, "owner", "repo", "success");

      expect(octokit._calls).toHaveLength(1);
      expect(octokit._calls[0]).toMatchObject({
        method: "reactions.createForIssueComment",
        args: [
          { owner: "owner", repo: "repo", comment_id: 123, content: "rocket" },
        ],
      });
    });

    it("adds a confused reaction on failure", async () => {
      process.env.COMMENT_ID = "123";
      process.env.SUCCESS_REACTION = "+1";

      const octokit = makeOctokit();
      await reactToAgentTrigger(octokit as never, "owner", "repo", "failure");

      expect(octokit._calls[0]?.args[0]).toMatchObject({ content: "confused" });
    });

    it("routes to pull request review when REACTION_TARGET is set", async () => {
      process.env.COMMENT_ID = "456";
      process.env.REACTION_TARGET = "pull_request_review";
      process.env.PR_NUMBER = "42";
      process.env.SUCCESS_REACTION = "rocket";

      const octokit = makeOctokit();
      await reactToAgentTrigger(octokit as never, "owner", "repo", "success");

      expect(octokit._calls.map((c) => c.method)).toEqual([
        "pulls.listCommentsForReview",
        "reactions.createForPullRequestReviewComment",
      ]);
      expect(octokit._calls[1]?.args[0]).toMatchObject({
        owner: "owner",
        repo: "repo",
        comment_id: 1001,
        content: "rocket",
      });
    });

    it("skips when COMMENT_ID is missing", async () => {
      const octokit = makeOctokit();
      await reactToAgentTrigger(octokit as never, "owner", "repo", "success");
      expect(octokit._calls).toHaveLength(0);
    });

    it("warns and skips for unknown REACTION_TARGET", async () => {
      process.env.COMMENT_ID = "123";
      process.env.REACTION_TARGET = "unknown";

      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const octokit = makeOctokit();
      await reactToAgentTrigger(octokit as never, "owner", "repo", "success");
      expect(octokit._calls).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith("Unknown reaction_target: unknown");
      warnSpy.mockRestore();
    });
  });

  describe("runAgentPhase", () => {
    it("runs the full lifecycle around main", async () => {
      const octokit = makeOctokit();
      const main = vi.fn().mockResolvedValue(undefined);

      await runAgentPhase({
        phase: "plan",
        octokit: octokit as never,
        owner: "owner",
        repo: "repo",
        issueNumber: 7,
        main,
      });

      expect(main).toHaveBeenCalledTimes(1);
      expect(octokit._calls.map((c) => c.method)).toEqual([
        "issues.getLabel",
        "issues.createLabel",
        "issues.addLabels",
        "issues.createComment",
        "issues.removeLabel",
        "issues.removeLabel",
        "issues.removeLabel",
      ]);
    });

    it("adds and removes the working label on both issue and PR", async () => {
      const octokit = makeOctokit();
      const main = vi.fn().mockResolvedValue(undefined);

      await runAgentPhase({
        phase: "review-fix",
        octokit: octokit as never,
        owner: "owner",
        repo: "repo",
        issueNumber: 7,
        prNumber: 42,
        main,
      });

      const addCalls = octokit._calls.filter(
        (c) => c.method === "issues.addLabels",
      );
      const removeCalls = octokit._calls.filter(
        (c) => c.method === "issues.removeLabel",
      );
      expect(
        addCalls.map(
          (c) => (c.args[0] as { issue_number: number }).issue_number,
        ),
      ).toEqual([7, 42]);
      expect(
        removeCalls.map(
          (c) => (c.args[0] as { issue_number: number }).issue_number,
        ),
      ).toEqual([7, 7, 42, 42, 7, 42]);
    });

    it("reacts failure and still removes label when main throws", async () => {
      process.env.COMMENT_ID = "123";
      const octokit = makeOctokit();
      const main = vi.fn().mockRejectedValue(new Error("boom"));

      await expect(
        runAgentPhase({
          phase: "plan",
          octokit: octokit as never,
          owner: "owner",
          repo: "repo",
          issueNumber: 7,
          main,
        }),
      ).rejects.toThrow("boom");

      expect(octokit._calls.map((c) => c.method)).toContain(
        "reactions.createForIssueComment",
      );
      expect(
        octokit._calls.find(
          (c) => c.method === "reactions.createForIssueComment",
        )?.args[0],
      ).toMatchObject({ content: "confused" });
      expect(
        octokit._calls.filter((c) => c.method === "issues.removeLabel").length,
      ).toBeGreaterThan(0);
    });
  });
});
