import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
import {
  JEV_ROUTER_MODEL_ID,
  buildJevRouterPlugin,
  createJevRouterFetch,
  getJevRouterPoolForPhase,
  isJevRouterEnabledForPhase,
  resolveOpenRouterModelForPhase,
} from "./jev-router.js";

const ENV_KEYS = [
  "OPENROUTER_JEV_ROUTER_ENABLED",
  "OPENROUTER_JEV_ROUTER_MODELS",
  "OPENROUTER_JEV_ROUTER_ALLOWED_MODELS",
  "OPENROUTER_JEV_ROUTER_EXCLUDED_MODELS",
] as const;

function baseConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    openrouter: undefined,
    version: 1,
    git: {
      base_branch: "main",
      pr_target: "main",
      branch_prefix: "agent",
      merge_strategy: "merge",
    },
    models: {
      plan: "deepseek/deepseek-v4-pro",
      implement: "moonshotai/kimi-k2.7-code",
      "ci-fix": "moonshotai/kimi-k2.7-code",
      "review-fix": "moonshotai/kimi-k2.7-code",
      ask: "deepseek/deepseek-v4-pro",
      "code-review": "deepseek/deepseek-v4-pro",
    },
    ci: { max_rounds: 3 },
    prompts: {
      plan: { role_description: "plan" },
      implement: { role_description: "implement" },
      "ci-fix": { role_description: "ci-fix" },
      yolo: { role_description: "yolo" },
      "review-fix": { role_description: "review-fix" },
      ask: { role_description: "ask" },
      "code-review": { role_description: "code-review" },
    },
    tools: { run_commands_timeout_ms: 600_000 },
    app: {},
    ...overrides,
  } as AgentConfig;
}

function openrouterConfig(
  jev_router: Record<string, unknown>,
): AgentConfig["openrouter"] {
  return { jev_router } as unknown as AgentConfig["openrouter"];
}

describe("jev-router", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  describe("isJevRouterEnabledForPhase", () => {
    it("is disabled by default", () => {
      expect(isJevRouterEnabledForPhase("implement", baseConfig())).toBe(false);
    });

    it("honors global enabled", () => {
      const config = baseConfig({
        openrouter: openrouterConfig({ enabled: true }),
      });
      expect(isJevRouterEnabledForPhase("implement", config)).toBe(true);
    });

    it("allows per-phase enable when global is off", () => {
      const config = baseConfig({
        openrouter: openrouterConfig({
          enabled: false,
          phases: { implement: { enabled: true } },
        }),
      });
      expect(isJevRouterEnabledForPhase("implement", config)).toBe(true);
      expect(isJevRouterEnabledForPhase("plan", config)).toBe(false);
    });

    it("allows per-phase disable when global is on", () => {
      const config = baseConfig({
        openrouter: openrouterConfig({
          enabled: true,
          phases: { plan: { enabled: false } },
        }),
      });
      expect(isJevRouterEnabledForPhase("plan", config)).toBe(false);
      expect(isJevRouterEnabledForPhase("implement", config)).toBe(true);
    });

    it("honors OPENROUTER_JEV_ROUTER_ENABLED env", () => {
      process.env.OPENROUTER_JEV_ROUTER_ENABLED = "true";
      expect(isJevRouterEnabledForPhase("implement", baseConfig())).toBe(true);
    });
  });

  describe("getJevRouterPoolForPhase", () => {
    it("defaults to the resolved phase model slug", () => {
      const pool = getJevRouterPoolForPhase(
        "implement",
        "anthropic/claude-sonnet-4",
        baseConfig(),
      );
      expect(pool).toEqual({
        models: ["anthropic/claude-sonnet-4"],
        excluded_models: [],
      });
    });

    it("merges models and allowed_models", () => {
      const config = baseConfig({
        openrouter: openrouterConfig({
          enabled: true,
          models: ["anthropic/*"],
          allowed_models: ["google/*"],
          excluded_models: ["anthropic/claude-opus*"],
        }),
      });
      const pool = getJevRouterPoolForPhase("implement", "ignored", config);
      expect(pool.models).toEqual(["anthropic/*", "google/*"]);
      expect(pool.excluded_models).toEqual(["anthropic/claude-opus*"]);
    });

    it("prefers phase pool overrides", () => {
      const config = baseConfig({
        openrouter: openrouterConfig({
          enabled: true,
          models: ["openai/*"],
          phases: {
            implement: {
              enabled: true,
              models: ["anthropic/*"],
              excluded_models: ["anthropic/claude-opus*"],
            },
          },
        }),
      });
      const pool = getJevRouterPoolForPhase("implement", "fallback", config);
      expect(pool.models).toEqual(["anthropic/*"]);
      expect(pool.excluded_models).toEqual(["anthropic/claude-opus*"]);
    });
  });

  describe("resolveOpenRouterModelForPhase", () => {
    it("returns the fixed slug when jev is off", () => {
      expect(
        resolveOpenRouterModelForPhase(
          "implement",
          "moonshotai/kimi-k2.7-code",
          baseConfig(),
        ),
      ).toEqual({
        requestModelId: "moonshotai/kimi-k2.7-code",
        logLabel: "moonshotai/kimi-k2.7-code",
      });
    });

    it("returns jev-router with context when enabled", () => {
      const config = baseConfig({
        openrouter: openrouterConfig({ enabled: true }),
      });
      const resolved = resolveOpenRouterModelForPhase(
        "implement",
        "moonshotai/kimi-k2.7-code",
        config,
      );
      expect(resolved.requestModelId).toBe(JEV_ROUTER_MODEL_ID);
      expect(resolved.jevContext?.pool.models).toEqual([
        "moonshotai/kimi-k2.7-code",
      ]);
      expect(resolved.jevContext?.metadata).toBe(true);
    });
  });

  describe("createJevRouterFetch", () => {
    it("injects the jev-router plugin for matching requests", async () => {
      const baseFetch = vi.fn<typeof fetch>(async () => new Response("{}"));
      const fetch = createJevRouterFetch(
        buildJevRouterPlugin({
          models: ["anthropic/*"],
          excluded_models: [],
        }),
        baseFetch,
      );

      await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: JEV_ROUTER_MODEL_ID,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      expect(baseFetch).toHaveBeenCalledOnce();
      const init = baseFetch.mock.calls[0]![1]!;
      const body = JSON.parse(String(init.body)) as {
        plugins: Array<{ id: string; models?: string[] }>;
      };
      expect(body.plugins).toEqual([
        { id: "jev-router", models: ["anthropic/*"] },
      ]);
    });

    it("does not modify non-jev models", async () => {
      const baseFetch = vi.fn<typeof fetch>(async () => new Response("{}"));
      const fetch = createJevRouterFetch(
        buildJevRouterPlugin({ models: ["anthropic/*"], excluded_models: [] }),
        baseFetch,
      );

      const body = JSON.stringify({
        model: "anthropic/claude-sonnet-4",
        messages: [],
      });
      await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        body,
      });

      const init = baseFetch.mock.calls[0]![1]!;
      expect(init.body).toBe(body);
    });
  });
});
