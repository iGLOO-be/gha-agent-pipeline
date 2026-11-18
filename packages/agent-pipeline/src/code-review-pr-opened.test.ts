import type { Octokit } from "@octokit/rest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureReviewPosted } from "./code-review-publish.js";
import { runCodeReviewPhase } from "./code-review-phase.js";
import { createCodeReviewTools, type ReviewTracker } from "./tools/index.js";

const WALKTHROUGH = "## Walkthrough\n\nAdds a widget.";

function unpublishedReview(): ReviewTracker {
  return { posted: false };
}

function octokitCapturingReviewBody(): {
  octokit: Octokit;
  publishedBody: () => string | undefined;
} {
  let publishedBody: string | undefined;
  const octokit = {
    pulls: {
      get: async () => ({ data: { head: { sha: "abc123" } } }),
      createReview: async (args: { body?: string }) => {
        publishedBody = args.body;
        return {
          data: {
            id: 9,
            html_url:
              "https://github.com/igloo/gha-agent-pipeline/pull/88#pullrequestreview-9",
            state: "COMMENTED",
          },
        };
      },
    },
  } as unknown as Octokit;
  return { octokit, publishedBody: () => publishedBody };
}

describe("PR-opened review publication", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("publishes a PR-opened review with the code review mark and agent-pr-opened-review", async () => {
    vi.stubEnv("PR_OPENED_REVIEW", "true");
    const { octokit, publishedBody } = octokitCapturingReviewBody();
    const tools = await createCodeReviewTools(
      octokit,
      "igloo",
      "gha-agent-pipeline",
      42,
      88,
      unpublishedReview(),
    );
    const submitReview = tools.find((tool) => tool.name === "submitReview");
    if (!submitReview) {
      throw new Error("submitReview tool missing");
    }

    await submitReview.execute({
      event: "COMMENT",
      body: WALKTHROUGH,
    });

    expect(publishedBody()).toBe(
      `<!-- agent-code-review -->\n<!-- agent-pr-opened-review -->\n${WALKTHROUGH}`,
    );
  });

  it("does not publish agent-pr-opened-review on a code review that is not a PR-opened review", async () => {
    delete process.env.PR_OPENED_REVIEW;
    const { octokit, publishedBody } = octokitCapturingReviewBody();
    const tools = await createCodeReviewTools(
      octokit,
      "igloo",
      "gha-agent-pipeline",
      42,
      88,
      unpublishedReview(),
    );
    const submitReview = tools.find((tool) => tool.name === "submitReview");
    if (!submitReview) {
      throw new Error("submitReview tool missing");
    }

    await submitReview.execute({
      event: "COMMENT",
      body: WALKTHROUGH,
    });

    expect(publishedBody()).toBe(`<!-- agent-code-review -->\n${WALKTHROUGH}`);
  });

  it("publishes the fallback PR-opened review with the code review mark and agent-pr-opened-review", async () => {
    vi.stubEnv("PR_OPENED_REVIEW", "true");
    const { octokit, publishedBody } = octokitCapturingReviewBody();
    const review = unpublishedReview();

    await ensureReviewPosted(
      octokit,
      "igloo",
      "gha-agent-pipeline",
      88,
      `The model finished.\n\n${WALKTHROUGH}`,
      review,
    );

    expect(publishedBody()).toBe(
      `<!-- agent-code-review -->\n<!-- agent-pr-opened-review -->\n${WALKTHROUGH}`,
    );
  });

  it("does not publish agent-pr-opened-review from the fallback when the run is not a PR-opened review", async () => {
    delete process.env.PR_OPENED_REVIEW;
    const { octokit, publishedBody } = octokitCapturingReviewBody();

    await ensureReviewPosted(
      octokit,
      "igloo",
      "gha-agent-pipeline",
      88,
      `The model finished.\n\n${WALKTHROUGH}`,
      unpublishedReview(),
    );

    expect(publishedBody()).toBe(`<!-- agent-code-review -->\n${WALKTHROUGH}`);
  });

  it("does not write agent-pr-opened-review when the fallback publishes no review", async () => {
    vi.stubEnv("PR_OPENED_REVIEW", "true");
    const { octokit, publishedBody } = octokitCapturingReviewBody();
    const review = unpublishedReview();

    await ensureReviewPosted(
      octokit,
      "igloo",
      "gha-agent-pipeline",
      88,
      "The model finished without a review section.",
      review,
    );

    expect(review.posted).toBe(false);
    expect(publishedBody()).toBeUndefined();
  });
});

function liveReviewablePullRequest() {
  return {
    number: 88,
    state: "open",
    draft: false,
    body: "Adds a widget.",
    head: {
      ref: "agent/42-add-widget",
      sha: "live-tip",
      repo: { full_name: "igloo/gha-agent-pipeline" },
    },
    base: {
      ref: "develop",
      repo: { full_name: "igloo/gha-agent-pipeline" },
    },
  };
}

describe("PR-opened review startup", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not start the phase when a published PR-opened review already exists", async () => {
    vi.stubEnv("PR_OPENED_REVIEW", "true");
    let started = false;
    const octokit = {
      pulls: {
        get: async () => ({ data: liveReviewablePullRequest() }),
        listReviews: async () => ({ data: [] }),
      },
      paginate: async () => [
        {
          id: 3,
          state: "DISMISSED",
          body: "<!-- agent-code-review -->\n<!-- agent-pr-opened-review -->\nWalkthrough",
        },
      ],
      issues: {
        createComment: async () => {
          throw new Error("startup comment posted");
        },
      },
    } as unknown as Octokit;

    await runCodeReviewPhase({
      octokit,
      owner: "igloo",
      repo: "gha-agent-pipeline",
      prNumber: 88,
      branchPrefix: "agent",
      start: async () => {
        started = true;
        throw new Error("phase started");
      },
    });

    expect(started).toBe(false);
  });

  it("starts a PR-opened review when the live pull request is closed and no review contains the PR-opened review mark", async () => {
    vi.stubEnv("PR_OPENED_REVIEW", "true");
    let started = false;
    const octokit = {
      pulls: {
        get: async () => ({
          data: { ...liveReviewablePullRequest(), state: "closed" },
        }),
      },
      paginate: async () => [],
    } as unknown as Octokit;

    await runCodeReviewPhase({
      octokit,
      owner: "igloo",
      repo: "gha-agent-pipeline",
      prNumber: 88,
      branchPrefix: "agent",
      start: async () => {
        started = true;
      },
    });

    expect(started).toBe(true);
  });

  it("does not start a PR-opened review when the live pull request is closed and a review contains the PR-opened review mark", async () => {
    vi.stubEnv("PR_OPENED_REVIEW", "true");
    let started = false;
    const octokit = {
      pulls: {
        get: async () => ({
          data: { ...liveReviewablePullRequest(), state: "closed" },
        }),
        listReviews: async () => ({ data: [] }),
      },
      paginate: async () => [
        {
          id: 3,
          state: "DISMISSED",
          body: "<!-- agent-code-review -->\n<!-- agent-pr-opened-review -->\nWalkthrough",
        },
      ],
      issues: {
        createComment: async () => {
          throw new Error("startup comment posted");
        },
      },
    } as unknown as Octokit;

    await runCodeReviewPhase({
      octokit,
      owner: "igloo",
      repo: "gha-agent-pipeline",
      prNumber: 88,
      branchPrefix: "agent",
      start: async () => {
        started = true;
        throw new Error("phase started");
      },
    });

    expect(started).toBe(false);
  });

  it("starts a PR-opened review when no review contains agent-pr-opened-review", async () => {
    vi.stubEnv("PR_OPENED_REVIEW", "true");
    let started = false;
    const octokit = {
      pulls: {
        get: async () => ({ data: liveReviewablePullRequest() }),
      },
      paginate: async () => [
        {
          id: 1,
          state: "COMMENTED",
          body: "<!-- agent-code-review -->\nA manual code review",
        },
      ],
    } as unknown as Octokit;

    await runCodeReviewPhase({
      octokit,
      owner: "igloo",
      repo: "gha-agent-pipeline",
      prNumber: 88,
      branchPrefix: "agent",
      start: async () => {
        started = true;
      },
    });

    expect(started).toBe(true);
  });

  it("starts a code review that is not a PR-opened review without applying the once-only decision", async () => {
    delete process.env.PR_OPENED_REVIEW;
    let started = false;
    const octokit = {
      pulls: {
        get: async () => {
          throw new Error(
            "ordinary code review consulted the PR-opened review decision",
          );
        },
      },
    } as unknown as Octokit;

    await runCodeReviewPhase({
      octokit,
      owner: "igloo",
      repo: "gha-agent-pipeline",
      prNumber: 88,
      branchPrefix: "agent",
      start: async () => {
        started = true;
      },
    });

    expect(started).toBe(true);
  });
});
