import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OPENROUTER_DEFAULT_REQUEST_TIMEOUT_MS,
  buildOpenRouterHttpHeaders,
  buildOpenRouterProviderConfig,
  getOpenRouterApiKey,
  getOpenRouterRequestTimeoutMs,
} from "./gateway.js";

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "GITHUB_REPOSITORY",
  "OPENROUTER_HTTP_REFERER",
  "OPENROUTER_APP_TITLE",
  "OPENROUTER_REQUEST_TIMEOUT_MS",
] as const;

describe("openrouter gateway", () => {
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

  describe("getOpenRouterApiKey", () => {
    it("throws when missing", () => {
      expect(() => getOpenRouterApiKey()).toThrow(/OPENROUTER_API_KEY/);
    });

    it("returns the configured key", () => {
      process.env.OPENROUTER_API_KEY = "sk-test";
      expect(getOpenRouterApiKey()).toBe("sk-test");
    });
  });

  describe("buildOpenRouterHttpHeaders", () => {
    it("defaults referer and title from GITHUB_REPOSITORY", () => {
      process.env.GITHUB_REPOSITORY = "iGLOO-be/gha-agent-demo";
      expect(buildOpenRouterHttpHeaders()).toEqual({
        "HTTP-Referer": "https://github.com/iGLOO-be/gha-agent-demo",
        "X-Title": "gha-agent-demo",
      });
    });

    it("honors explicit appName override", () => {
      process.env.GITHUB_REPOSITORY = "iGLOO-be/gha-agent-demo";
      expect(buildOpenRouterHttpHeaders("my-consumer-app")).toEqual({
        "HTTP-Referer": "https://github.com/iGLOO-be/gha-agent-demo",
        "X-Title": "my-consumer-app",
      });
    });

    it("prefers env title over appName and repository", () => {
      process.env.GITHUB_REPOSITORY = "iGLOO-be/gha-agent-demo";
      process.env.OPENROUTER_APP_TITLE = "env-title";
      expect(buildOpenRouterHttpHeaders("my-consumer-app")).toEqual({
        "HTTP-Referer": "https://github.com/iGLOO-be/gha-agent-demo",
        "X-Title": "env-title",
      });
    });

    it("falls back to generic app name when nothing is set", () => {
      expect(buildOpenRouterHttpHeaders()).toEqual({
        "HTTP-Referer": "",
        "X-Title": "gha-agent",
      });
    });

    it("falls back to appName when GITHUB_REPOSITORY is missing", () => {
      expect(buildOpenRouterHttpHeaders("my-consumer-app")).toEqual({
        "HTTP-Referer": "",
        "X-Title": "my-consumer-app",
      });
    });
  });

  describe("getOpenRouterRequestTimeoutMs", () => {
    it("defaults to 600_000 ms", () => {
      expect(getOpenRouterRequestTimeoutMs()).toBe(
        OPENROUTER_DEFAULT_REQUEST_TIMEOUT_MS,
      );
    });

    it("parses OPENROUTER_REQUEST_TIMEOUT_MS", () => {
      process.env.OPENROUTER_REQUEST_TIMEOUT_MS = "120000";
      expect(getOpenRouterRequestTimeoutMs()).toBe(120_000);
    });

    it("falls back on invalid values", () => {
      process.env.OPENROUTER_REQUEST_TIMEOUT_MS = "nope";
      expect(getOpenRouterRequestTimeoutMs()).toBe(
        OPENROUTER_DEFAULT_REQUEST_TIMEOUT_MS,
      );
    });
  });

  describe("buildOpenRouterProviderConfig", () => {
    it("wraps timeout for Cline providerConfig", () => {
      process.env.OPENROUTER_REQUEST_TIMEOUT_MS = "90000";
      expect(buildOpenRouterProviderConfig()).toEqual({ timeout: 90_000 });
    });
  });
});
