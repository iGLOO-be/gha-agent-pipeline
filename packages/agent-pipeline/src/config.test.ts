import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPhaseSystemPrompt,
  buildToolPolicies,
  getAppName,
  getCiMaxRounds,
  IMPLEMENT_MODEL,
  loadAgentConfig,
  loadAgentEnv,
  loadCiFixEnv,
  loadReviewFixEnv,
  parseRepository,
  PLAN_MODEL,
} from "./config.js";
import { FILE_EDIT_SYSTEM_HINT } from "./prompts/file-edits.js";
import { RUN_FRICTION_SYSTEM_HINT } from "./prompts/run-friction.js";
import { resolvePhaseModel } from "./session-retry.js";

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "GITHUB_TOKEN",
  "GITHUB_REPOSITORY",
  "ISSUE_NUMBER",
  "PR_NUMBER",
  "HEAD_SHA",
  "AGENT_BRANCH",
  "REVIEW_FEEDBACK",
  "CI_MAX_ROUNDS",
  "AGENT_MODEL_PLAN",
  "AGENT_MODEL_IMPLEMENT",
] as const;

describe("config", () => {
  let originalValues: Record<string, string | undefined> = {};
  let tempDir: string;

  beforeEach(() => {
    originalValues = {};
    for (const key of ENV_KEYS) {
      originalValues[key] = process.env[key];
      delete process.env[key];
    }
    tempDir = mkdtempSync(join(tmpdir(), "agent-config-test-"));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalValues[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValues[key];
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("parseRepository", () => {
    it("parses owner/repo", () => {
      expect(parseRepository("iGLOO-be/gha-agent-demo")).toEqual({
        owner: "iGLOO-be",
        repo: "gha-agent-demo",
      });
    });

    it("throws for invalid input", () => {
      expect(() => parseRepository("invalid")).toThrow(
        "Invalid GITHUB_REPOSITORY: invalid",
      );
      expect(() => parseRepository("")).toThrow("Invalid GITHUB_REPOSITORY:");
    });
  });

  describe("loadAgentEnv", () => {
    it("loads valid environment", () => {
      process.env.OPENROUTER_API_KEY = "or-key";
      process.env.GITHUB_TOKEN = "gh-token";
      process.env.GITHUB_REPOSITORY = "owner/repo";
      process.env.ISSUE_NUMBER = "88";

      expect(loadAgentEnv()).toEqual({
        OPENROUTER_API_KEY: "or-key",
        GITHUB_TOKEN: "gh-token",
        GITHUB_REPOSITORY: "owner/repo",
        ISSUE_NUMBER: 88,
      });
    });

    it("reports missing or invalid fields", () => {
      process.env.OPENROUTER_API_KEY = "or-key";
      process.env.GITHUB_TOKEN = "gh-token";
      process.env.GITHUB_REPOSITORY = "owner/repo";

      expect(() => loadAgentEnv()).toThrow(
        "Missing or invalid agent environment: ISSUE_NUMBER",
      );
    });
  });

  describe("loadCiFixEnv", () => {
    it("loads valid environment", () => {
      process.env.OPENROUTER_API_KEY = "or-key";
      process.env.GITHUB_TOKEN = "gh-token";
      process.env.GITHUB_REPOSITORY = "owner/repo";
      process.env.ISSUE_NUMBER = "88";
      process.env.PR_NUMBER = "123";
      process.env.HEAD_SHA = "abc123";

      expect(loadCiFixEnv()).toEqual({
        OPENROUTER_API_KEY: "or-key",
        GITHUB_TOKEN: "gh-token",
        GITHUB_REPOSITORY: "owner/repo",
        ISSUE_NUMBER: 88,
        PR_NUMBER: 123,
        HEAD_SHA: "abc123",
      });
    });

    it("reports missing ci-fix fields", () => {
      process.env.OPENROUTER_API_KEY = "or-key";
      process.env.GITHUB_TOKEN = "gh-token";
      process.env.GITHUB_REPOSITORY = "owner/repo";
      process.env.ISSUE_NUMBER = "88";

      expect(() => loadCiFixEnv()).toThrow(
        "Missing or invalid ci-fix environment: PR_NUMBER, HEAD_SHA",
      );
    });
  });

  describe("loadReviewFixEnv", () => {
    it("loads valid environment", () => {
      process.env.OPENROUTER_API_KEY = "or-key";
      process.env.GITHUB_TOKEN = "gh-token";
      process.env.GITHUB_REPOSITORY = "owner/repo";
      process.env.ISSUE_NUMBER = "88";
      process.env.PR_NUMBER = "123";
      process.env.AGENT_BRANCH = "agent/88-fix";
      process.env.REVIEW_FEEDBACK = "Please address comments.";

      expect(loadReviewFixEnv()).toEqual({
        OPENROUTER_API_KEY: "or-key",
        GITHUB_TOKEN: "gh-token",
        GITHUB_REPOSITORY: "owner/repo",
        ISSUE_NUMBER: 88,
        PR_NUMBER: 123,
        AGENT_BRANCH: "agent/88-fix",
        REVIEW_FEEDBACK: "Please address comments.",
      });
    });

    it("reports missing review-fix fields", () => {
      process.env.OPENROUTER_API_KEY = "or-key";
      process.env.GITHUB_TOKEN = "gh-token";
      process.env.GITHUB_REPOSITORY = "owner/repo";
      process.env.ISSUE_NUMBER = "88";

      expect(() => loadReviewFixEnv()).toThrow(
        "Missing or invalid review-fix environment: PR_NUMBER, AGENT_BRANCH, REVIEW_FEEDBACK",
      );
    });
  });

  describe("buildToolPolicies", () => {
    it("auto-approves read tools everywhere", () => {
      for (const phase of [
        "plan",
        "implement",
        "yolo",
        "ci-fix",
        "review-fix",
      ] as const) {
        const policies = buildToolPolicies(phase, []);
        for (const tool of [
          "read_files",
          "search_codebase",
          "run_commands",
          "fetch_web_content",
        ]) {
          expect(policies[tool]).toEqual({ autoApprove: true });
        }
      }
    });

    it("approves write tools only for implement/yolo/ci-fix/review-fix", () => {
      for (const phase of [
        "implement",
        "yolo",
        "ci-fix",
        "review-fix",
      ] as const) {
        const policies = buildToolPolicies(phase, []);
        expect(policies["editor"]).toEqual({ autoApprove: true });
        expect(policies["apply_patch"]).toEqual({ autoApprove: true });
      }

      const planPolicies = buildToolPolicies("plan", []);
      expect(planPolicies["editor"]).toBeUndefined();
      expect(planPolicies["apply_patch"]).toBeUndefined();
    });

    it("disables ask_question, skills, and submit_and_exit", () => {
      const policies = buildToolPolicies("implement", []);
      for (const tool of ["ask_question", "skills", "submit_and_exit"]) {
        expect(policies[tool]).toEqual({ enabled: false });
      }
    });

    it("auto-approves custom tools", () => {
      const policies = buildToolPolicies("plan", ["customOne", "customTwo"]);
      expect(policies["customOne"]).toEqual({ autoApprove: true });
      expect(policies["customTwo"]).toEqual({ autoApprove: true });
    });
  });

  describe("loadAgentConfig", () => {
    it("returns built-in defaults when the config file is missing", () => {
      const config = loadAgentConfig(join(tempDir, "agent.config.yml"));

      expect(config.version).toBe(1);
      expect(config.git.base_branch).toBe("main");
      expect(config.git.pr_target).toBe("main");
      expect(config.git.branch_prefix).toBe("agent");
      expect(config.git.merge_strategy).toBe("merge");
      expect(config.models.plan).toBe("deepseek/deepseek-v4-pro");
      expect(config.models.implement).toBe("moonshotai/kimi-k2.7-code");
      expect(config.models["ci-fix"]).toBe("moonshotai/kimi-k2.7-code");
      expect(config.models["review-fix"]).toBe("moonshotai/kimi-k2.7-code");
      expect(config.ci.max_rounds).toBe(3);
    });

    it("loads values from a valid YAML config", () => {
      const configPath = join(tempDir, "agent.config.yml");
      writeFileSync(
        configPath,
        [
          "version: 1",
          "git:",
          "  base_branch: develop",
          "  pr_target: develop",
          "  branch_prefix: bot",
          "  merge_strategy: rebase",
          "models:",
          "  plan: openai/gpt-4o",
          "  implement: anthropic/claude-sonnet-4",
          "  ci-fix: anthropic/claude-sonnet-4",
          "  review-fix: anthropic/claude-sonnet-4",
          "ci:",
          "  max_rounds: 5",
        ].join("\n"),
      );

      const config = loadAgentConfig(configPath);

      expect(config.git.base_branch).toBe("develop");
      expect(config.git.pr_target).toBe("develop");
      expect(config.git.branch_prefix).toBe("bot");
      expect(config.git.merge_strategy).toBe("rebase");
      expect(config.models.plan).toBe("openai/gpt-4o");
      expect(config.models.implement).toBe("anthropic/claude-sonnet-4");
      expect(config.ci.max_rounds).toBe(5);
    });

    it("defaults pr_target to base_branch when omitted", () => {
      const configPath = join(tempDir, "agent.config.yml");
      writeFileSync(
        configPath,
        ["version: 1", "git:", "  base_branch: develop"].join("\n"),
      );

      const config = loadAgentConfig(configPath);

      expect(config.git.pr_target).toBe("develop");
    });

    it("throws a clear error for invalid YAML", () => {
      const configPath = join(tempDir, "agent.config.yml");
      writeFileSync(
        configPath,
        ["version: 2", "ci:", "  max_rounds: -1"].join("\n"),
      );

      expect(() => loadAgentConfig(configPath)).toThrow(/Invalid/);
    });
  });

  describe("getCiMaxRounds", () => {
    it("returns the configured default", () => {
      expect(getCiMaxRounds()).toBe(3);
    });

    it("prefers the CI_MAX_ROUNDS environment variable", () => {
      process.env.CI_MAX_ROUNDS = "7";
      expect(getCiMaxRounds()).toBe(7);
    });

    it("falls back to the config value when the env override is invalid", () => {
      process.env.CI_MAX_ROUNDS = "not-a-number";
      expect(getCiMaxRounds()).toBe(3);
    });
  });

  describe("model constants and env overrides", () => {
    it("exports config-driven model defaults", () => {
      expect(PLAN_MODEL).toBe("deepseek/deepseek-v4-pro");
      expect(IMPLEMENT_MODEL).toBe("moonshotai/kimi-k2.7-code");
    });

    it("lets AGENT_MODEL_<PHASE> override the config default", () => {
      process.env.AGENT_MODEL_PLAN = "openai/gpt-4o";
      expect(resolvePhaseModel("plan", PLAN_MODEL)).toBe("openai/gpt-4o");
    });
  });

  describe("prompts", () => {
    it("uses generic role descriptions by default", () => {
      const config = loadAgentConfig(join(tempDir, "missing.yml"));
      const prompt = buildPhaseSystemPrompt("plan", config);
      expect(prompt).toMatch(/^You are a planning agent for this repository\./);
      expect(prompt).toContain("submitPlan");
    });

    it("loads custom role descriptions from YAML", () => {
      const configPath = join(tempDir, "agent.config.yml");
      writeFileSync(
        configPath,
        [
          "version: 1",
          "prompts:",
          "  plan:",
          "    role_description: You are a senior architect for a design system.",
          "  implement:",
          "    role_description: You are a full-stack engineer.",
        ].join("\n"),
      );

      const config = loadAgentConfig(configPath);
      expect(buildPhaseSystemPrompt("plan", config)).toMatch(
        /^You are a senior architect for a design system\./,
      );
      expect(buildPhaseSystemPrompt("implement", config)).toMatch(
        /^You are a full-stack engineer\./,
      );
    });

    it("preserves operational text across phases", () => {
      const config = loadAgentConfig(join(tempDir, "missing.yml"));
      expect(buildPhaseSystemPrompt("implement", config)).toContain(
        FILE_EDIT_SYSTEM_HINT,
      );
      expect(buildPhaseSystemPrompt("implement", config)).toContain(
        RUN_FRICTION_SYSTEM_HINT,
      );
      expect(buildPhaseSystemPrompt("ci-fix", config)).toContain(
        "The pull request failed CI.",
      );
      expect(buildPhaseSystemPrompt("yolo", config)).toContain(
        "### Risk Score:",
      );
    });

    it("interpolates review-fix merge handling from config", () => {
      const configPath = join(tempDir, "agent.config.yml");
      writeFileSync(
        configPath,
        [
          "version: 1",
          "git:",
          "  base_branch: develop",
          "  merge_strategy: rebase",
        ].join("\n"),
      );

      const config = loadAgentConfig(configPath);
      const prompt = buildPhaseSystemPrompt("review-fix", config);
      expect(prompt).toContain("develop");
      expect(prompt).toContain("rebase");
    });
  });

  describe("app metadata", () => {
    it("derives app name from config", () => {
      const config = loadAgentConfig(join(tempDir, "missing.yml"));
      expect(getAppName({ ...config, app: { name: "my-consumer-app" } })).toBe(
        "my-consumer-app",
      );
    });

    it("derives app name from GITHUB_REPOSITORY when config omits app.name", () => {
      process.env.GITHUB_REPOSITORY = "acme-corp/widget-app";
      const config = loadAgentConfig(join(tempDir, "missing.yml"));
      expect(getAppName(config)).toBe("widget-app");
    });

    it("falls back to a generic app name when nothing is set", () => {
      delete process.env.GITHUB_REPOSITORY;
      const config = loadAgentConfig(join(tempDir, "missing.yml"));
      expect(getAppName(config)).toBe("gha-agent");
    });
  });

  describe("dogfood config", () => {
    it("validates .github/agent.config.yml at repo root", () => {
      expect(
        existsSync(".github/agent.config.yml"),
        ".github/agent.config.yml must exist at repo root",
      ).toBe(true);

      const config = loadAgentConfig(".github/agent.config.yml");
      expect(config.version).toBe(1);
    });
  });
});
