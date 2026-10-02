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
      low: "agent-risk-low",
      medium: "agent-risk-medium",
      high: "agent-risk-high",
    });
  });
});

describe("applyCodeReviewLabels", () => {
  function makeOctokit() {
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
    return { calls, octokit };
  }

  it("applies status and merge-risk labels on the PR", async () => {
    const { calls, octokit } = makeOctokit();

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

  it("does not label status when the review event is unset", async () => {
    const { calls, octokit } = makeOctokit();

    await applyCodeReviewLabels({
      octokit: octokit as never,
      owner: "o",
      repo: "r",
      prNumber: 42,
      issueNumber: 7,
      review: {
        posted: true,
        body: "## Merge risk\n\n**High** — breaking API.",
      },
      labelsConfig: {
        applyTo: "pr",
        statusOk: "ai-review:ok",
        statusPending: "ai-review:pending",
        mergeRisk: {
          low: "agent-risk-low",
          medium: "agent-risk-medium",
          high: "agent-risk-high",
        },
      },
    });

    const added = calls
      .filter((c) => c.method === "issues.addLabels")
      .map((c) => (c.args[0] as { labels: string[] }).labels)
      .flat();
    expect(added).toEqual(["agent-risk-high"]);
    expect(added).not.toContain("ai-review:ok");
  });

  it("clears a stale status label when the event has no configured label", async () => {
    const { calls, octokit } = makeOctokit();

    await applyCodeReviewLabels({
      octokit: octokit as never,
      owner: "o",
      repo: "r",
      prNumber: 42,
      issueNumber: 7,
      review: {
        posted: true,
        event: "REQUEST_CHANGES",
        body: "no merge risk section",
      },
      labelsConfig: { applyTo: "pr", statusOk: "ai-review:ok" },
    });

    const added = calls
      .filter((c) => c.method === "issues.addLabels")
      .map((c) => (c.args[0] as { labels: string[] }).labels)
      .flat();
    expect(added).toEqual([]);

    const removed = calls
      .filter((c) => c.method === "issues.removeLabel")
      .map((c) => (c.args[0] as { name: string }).name);
    expect(removed).toContain("ai-review:ok");
  });

  it("clears a stale merge-risk label when no level parses", async () => {
    const { calls, octokit } = makeOctokit();

    await applyCodeReviewLabels({
      octokit: octokit as never,
      owner: "o",
      repo: "r",
      prNumber: 42,
      issueNumber: 7,
      review: {
        posted: true,
        event: "COMMENT",
        body: "no merge risk section",
      },
      labelsConfig: {
        applyTo: "pr",
        mergeRisk: {
          low: "agent-risk-low",
          medium: "agent-risk-medium",
          high: "agent-risk-high",
        },
      },
    });

    const added = calls.filter((c) => c.method === "issues.addLabels");
    expect(added).toEqual([]);

    const removed = calls
      .filter((c) => c.method === "issues.removeLabel")
      .map((c) => (c.args[0] as { name: string }).name);
    expect(removed).toEqual(
      expect.arrayContaining([
        "agent-risk-low",
        "agent-risk-medium",
        "agent-risk-high",
      ]),
    );
  });

  it("applies labels only to the issue when apply_to is issue", async () => {
    const { calls, octokit } = makeOctokit();

    await applyCodeReviewLabels({
      octokit: octokit as never,
      owner: "o",
      repo: "r",
      prNumber: 42,
      issueNumber: 7,
      review: { posted: true, event: "COMMENT", body: "x" },
      labelsConfig: { applyTo: "issue", statusOk: "ai-review:ok" },
    });

    const targets = calls
      .filter((c) => c.method === "issues.addLabels")
      .map((c) => (c.args[0] as { issue_number: number }).issue_number);
    expect(targets).toEqual([7]);
  });

  it("dedupes the target when apply_to is both and numbers coincide", async () => {
    const { calls, octokit } = makeOctokit();

    await applyCodeReviewLabels({
      octokit: octokit as never,
      owner: "o",
      repo: "r",
      prNumber: 42,
      issueNumber: 42,
      review: {
        posted: true,
        event: "COMMENT",
        body: "## Merge risk\n\n**High** — breaking API.",
      },
      labelsConfig: {
        applyTo: "both",
        statusOk: "ai-review:ok",
        mergeRisk: {
          low: "agent-risk-low",
          medium: "agent-risk-medium",
          high: "agent-risk-high",
        },
      },
    });

    const added = calls.filter((c) => c.method === "issues.addLabels");
    expect(added).toHaveLength(2);
    expect(
      added.map((c) => (c.args[0] as { issue_number: number }).issue_number),
    ).toEqual([42, 42]);
  });
});
