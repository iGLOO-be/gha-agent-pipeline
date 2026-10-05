import { describe, expect, it } from "vitest";
import { buildCodeReviewPhaseComment } from "./code-review-completion.js";
import { createRunFrictionCollector } from "./run-friction.js";

describe("buildCodeReviewPhaseComment", () => {
  it("includes phase marker, status line, and run metrics", () => {
    const output = buildCodeReviewPhaseComment({
      reviewHtmlUrl: "https://github.com/o/r/pull/1#pullrequestreview-9",
      sessionUsage: {
        inputTokens: 1200,
        outputTokens: 400,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalCost: 0.002,
      },
      sessionId: "sess-cr-1",
      modelId: "deepseek/deepseek-v4-pro",
      iterations: 2,
      toolCallsCount: 4,
      runFriction: createRunFrictionCollector(),
    });

    expect(output).toMatch(/^<!-- agent-code-review -->/);
    expect(output).toContain("<!-- agent-phase-report -->");
    expect(output).toContain("## Agent phase report (Code Review)");
    expect(output).toContain(
      "Review posted — [view review](https://github.com/o/r/pull/1#pullrequestreview-9)",
    );
    expect(output).toContain("<summary>Run metrics</summary>");
    expect(output).toContain("#### Run metrics");
    expect(output).toContain("`sess-cr-1`");
    expect(output).not.toContain("_No business summary was submitted._");
  });

  it("omits status line when review URL is missing", () => {
    const output = buildCodeReviewPhaseComment({
      sessionUsage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalCost: 0.0001,
      },
      sessionId: "sess-cr-2",
      modelId: "deepseek/deepseek-v4-pro",
      iterations: 1,
      toolCallsCount: 1,
      runFriction: createRunFrictionCollector(),
    });

    expect(output).not.toContain("Review posted");
    expect(output).toContain("<summary>Run metrics</summary>");
    expect(output).toContain("#### Run metrics");
  });
});
