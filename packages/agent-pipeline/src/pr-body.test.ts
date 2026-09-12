import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { buildAgentPrBody } from "./pr-body.js";

const ENV_KEYS = [
  "GITHUB_SERVER_URL",
  "GITHUB_REPOSITORY",
  "GITHUB_RUN_ID",
] as const;

describe("pr-body", () => {
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

  it("includes required markers and issue link without run/plan", () => {
    const body = buildAgentPrBody({
      issueNumber: 88,
      issueTitle: "Tests unitaires Vitest",
      issueUrl: "https://github.com/iGLOO-be/gha-agent-demo/issues/88",
    });

    expect(body).toContain("Closes #88");
    expect(body).toContain("<!-- agent-pr -->");
    expect(body).toContain("## 🤖 Agent PR");
    expect(body).toContain(
      "[#88 — Tests unitaires Vitest](https://github.com/iGLOO-be/gha-agent-demo/issues/88)",
    );
    expect(body).toContain(
      "- **Feedback:** review comments or failing CI → comment `/agent fix` on this PR",
    );
    expect(body).toContain("- **Run:** not available outside GitHub Actions");
  });

  it("includes plan comment URL when provided", () => {
    const body = buildAgentPrBody({
      issueNumber: 1,
      issueTitle: "Issue",
      issueUrl: "https://github.com/iGLOO-be/gha-agent-demo/issues/1",
      planCommentUrl:
        "https://github.com/iGLOO-be/gha-agent-demo/issues/1#issuecomment-123",
    });

    expect(body).toContain(
      "- **Plan:** [Agent Plan comment](https://github.com/iGLOO-be/gha-agent-demo/issues/1#issuecomment-123)",
    );
  });

  it("includes risk score and justification when provided", () => {
    const body = buildAgentPrBody({
      issueNumber: 1,
      issueTitle: "Issue",
      issueUrl: "https://github.com/iGLOO-be/gha-agent-demo/issues/1",
      riskLevel: "medium",
      riskJustification: "touches agent prompts",
    });

    expect(body).toContain("- **Risk score:** medium — touches agent prompts");
  });

  it("includes run link when GITHUB Actions env is present", () => {
    process.env.GITHUB_SERVER_URL = "https://github.com";
    process.env.GITHUB_REPOSITORY = "iGLOO-be/gha-agent-demo";
    process.env.GITHUB_RUN_ID = "123456";

    const body = buildAgentPrBody({
      issueNumber: 1,
      issueTitle: "Issue",
      issueUrl: "https://github.com/iGLOO-be/gha-agent-demo/issues/1",
    });

    expect(body).toContain(
      "- **Run:** [GitHub Actions](https://github.com/iGLOO-be/gha-agent-demo/actions/runs/123456)",
    );
  });
});
