import { describe, expect, it, vi } from "vitest";
import {
  appendCodeReviewRunnerFooter,
  appendRunnerFooterToPostedReview,
  buildCodeReviewRunnerFooter,
} from "./code-review-completion.js";
import { createRunFrictionCollector } from "./run-friction.js";

const sampleUsage = {
  inputTokens: 1200,
  outputTokens: 400,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalCost: 0.002,
};

describe("buildCodeReviewRunnerFooter", () => {
  it("includes collapsible run metrics and omits phase report wrapper", () => {
    const output = buildCodeReviewRunnerFooter({
      sessionUsage: sampleUsage,
      sessionId: "sess-cr-1",
      modelId: "deepseek/deepseek-v4-pro",
      iterations: 2,
      toolCallsCount: 4,
      runFriction: createRunFrictionCollector(),
    });

    expect(output).toMatch(/^---/);
    expect(output).toContain("<summary>Run metrics</summary>");
    expect(output).toContain("#### Run metrics");
    expect(output).toContain("`sess-cr-1`");
    expect(output).not.toContain("## Agent phase report");
    expect(output).not.toContain("agent-code-review");
    expect(output).not.toContain("Review posted");
  });

  it("returns empty string when usage is absent and friction is empty", () => {
    const output = buildCodeReviewRunnerFooter({
      runFriction: createRunFrictionCollector(),
    });

    expect(output).toBe("");
  });
});

describe("appendCodeReviewRunnerFooter", () => {
  it("appends footer to review body", () => {
    const reviewBody =
      "<!-- agent-code-review -->\n## Walkthrough\n\nLooks good.";
    const footer = "---\n\n<details><summary>Run metrics</summary></details>";
    expect(appendCodeReviewRunnerFooter(reviewBody, footer)).toBe(
      `${reviewBody}\n\n${footer}`,
    );
  });

  it("returns review body unchanged when footer is empty", () => {
    const reviewBody = "Review only";
    expect(appendCodeReviewRunnerFooter(reviewBody, "")).toBe(reviewBody);
  });
});

describe("appendRunnerFooterToPostedReview", () => {
  it("updates review body via GitHub API", async () => {
    const updateReview = vi.fn().mockResolvedValue({ data: { id: 9 } });
    const octokit = {
      pulls: { updateReview },
    } as unknown as Parameters<typeof appendRunnerFooterToPostedReview>[0];

    const review = {
      id: 9,
      body: "<!-- agent-code-review -->\n## Walkthrough",
    };

    await appendRunnerFooterToPostedReview(octokit, "o", "r", 1, review, {
      sessionUsage: sampleUsage,
      sessionId: "sess-cr-1",
      modelId: "deepseek/deepseek-v4-pro",
      iterations: 1,
      toolCallsCount: 1,
      runFriction: createRunFrictionCollector(),
    });

    expect(updateReview).toHaveBeenCalledOnce();
    const call = updateReview.mock.calls[0][0];
    expect(call.owner).toBe("o");
    expect(call.repo).toBe("r");
    expect(call.pull_number).toBe(1);
    expect(call.review_id).toBe(9);
    expect(call.body).toContain("<!-- agent-code-review -->");
    expect(call.body).toContain("<summary>Run metrics</summary>");
    expect(review.body).toBe(call.body);
  });

  it("does not call API when review id is missing", async () => {
    const updateReview = vi.fn();
    const octokit = {
      pulls: { updateReview },
    } as unknown as Parameters<typeof appendRunnerFooterToPostedReview>[0];

    await appendRunnerFooterToPostedReview(
      octokit,
      "o",
      "r",
      1,
      { body: "review" },
      {
        sessionUsage: sampleUsage,
        sessionId: "sess-cr-1",
        modelId: "m",
        runFriction: createRunFrictionCollector(),
      },
    );

    expect(updateReview).not.toHaveBeenCalled();
  });
});
