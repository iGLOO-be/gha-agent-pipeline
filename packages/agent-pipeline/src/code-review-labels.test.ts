import { describe, expect, it } from "vitest";
import type { AgentConfig } from "./config.js";
import {
  applyCodeReviewLabels,
  resolveCodeReviewLabelsConfig,
} from "./code-review-labels.js";

function configWithLabels(labels: unknown): AgentConfig {
  return {
    code_review: { labels },
  } as unknown as AgentConfig;
}

describe("resolveCodeReviewLabelsConfig", () => {
  it("returns null when labels block is absent", () => {
    expect(resolveCodeReviewLabelsConfig({} as AgentConfig)).toBeNull();
    expect(
      resolveCodeReviewLabelsConfig({
        code_review: { path_filters: [] },
      } as unknown as AgentConfig),
    ).toBeNull();
  });

  it("returns null when labels block is empty", () => {
    expect(resolveCodeReviewLabelsConfig(configWithLabels({}))).toBeNull();
  });

  it("resolves Foldio-style status labels", () => {
    const resolved = resolveCodeReviewLabelsConfig(
      configWithLabels({
        status: { ok: "ai-review:ok", pending: "ai-review:pending" },
      }),
    );
    expect(resolved).toMatchObject({
      applyTo: "pr",
      statusOk: "ai-review:ok",
      statusPending: "ai-review:pending",
    });
    expect(resolved?.mergeRisk).toBeUndefined();
  });

  it("resolves merge_risk with defaults", () => {
    const resolved = resolveCodeReviewLabelsConfig(
      configWithLabels({ merge_risk: {} }),
    );
    expect(resolved?.mergeRisk).toEqual({
      enabled: true,
      low: "agent-risk-low",
      medium: "agent-risk-medium",
      high: "agent-risk-high",
    });
  });
});

describe("applyCodeReviewLabels", () => {
  it("applies status and merge-risk labels on the PR", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const octokit = {
      issues: {
        getLabel: async (...args: unknown[]) => {
          calls.push({ method: "issues.getLabel", args });
          throw Object.assign(new Error("Not found"), { status: 404 });
        },
        createLabel: async (...args: unknown[]) => {
          calls.push({ method: "issues.createLabel", args });
          return { data: {} };
        },
        addLabels: async (...args: unknown[]) => {
          calls.push({ method: "issues.addLabels", args });
          return { data: {} };
        },
        removeLabel: async (...args: unknown[]) => {
          calls.push({ method: "issues.removeLabel", args });
          return { data: {} };
        },
      },
    };

    await applyCodeReviewLabels({
      octokit: octokit as never,
      owner: "o",
      repo: "r",
      prNumber: 42,
      issueNumber: 7,
      review: {
        posted: true,
        event: "COMMENT",
        body: "## Walkthrough\n\nx\n\n## Merge risk\n\n**Moderate** — touches auth.",
      },
      labelsConfig: {
        applyTo: "pr",
        statusOk: "ai-review:ok",
        statusPending: "ai-review:pending",
        mergeRisk: {
          enabled: true,
          low: "agent-risk-low",
          medium: "agent-risk-medium",
          high: "agent-risk-high",
        },
      },
    });

    const addLabels = calls.filter((c) => c.method === "issues.addLabels");
    expect(addLabels).toHaveLength(2);
    expect(addLabels[0].args[0]).toMatchObject({
      issue_number: 42,
      labels: ["ai-review:ok"],
    });
    expect(addLabels[1].args[0]).toMatchObject({
      issue_number: 42,
      labels: ["agent-risk-medium"],
    });

    const removed = calls
      .filter((c) => c.method === "issues.removeLabel")
      .map((c) => (c.args[0] as { name: string }).name);
    expect(removed).toContain("ai-review:pending");
    expect(removed).toContain("agent-risk-low");
    expect(removed).toContain("agent-risk-high");
  });
});
