import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPENROUTER_APP_VISIBILITY_HEADER,
  OPENROUTER_APP_VISIBILITY_HIDDEN,
  OPENROUTER_DEFAULT_REQUEST_TIMEOUT_MS,
  OPENROUTER_METADATA_HEADER,
  OPENROUTER_PROVIDER_ID,
  OpenRouterRequestTimeoutError,
  buildOpenRouterHttpHeaders,
  buildOpenRouterProviderConfig,
  createRequestTimeoutFetch,
  getOpenRouterApiKey,
  getOpenRouterRequestTimeoutMs,
  isOpenRouterRequestTimeoutMessage,
} from "./gateway.js";
import {
  createOpenRouterUsageCostTracker,
  createServedModelTracker,
} from "./jev-router.js";

const HIDDEN_VISIBILITY = {
  [OPENROUTER_APP_VISIBILITY_HEADER]: OPENROUTER_APP_VISIBILITY_HIDDEN,
} as const;

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
        ...HIDDEN_VISIBILITY,
      });
    });

    it("honors explicit appName override", () => {
      process.env.GITHUB_REPOSITORY = "iGLOO-be/gha-agent-demo";
      expect(buildOpenRouterHttpHeaders("my-consumer-app")).toEqual({
        "HTTP-Referer": "https://github.com/iGLOO-be/gha-agent-demo",
        "X-Title": "my-consumer-app",
        ...HIDDEN_VISIBILITY,
      });
    });

    it("prefers env title over appName and repository", () => {
      process.env.GITHUB_REPOSITORY = "iGLOO-be/gha-agent-demo";
      process.env.OPENROUTER_APP_TITLE = "env-title";
      expect(buildOpenRouterHttpHeaders("my-consumer-app")).toEqual({
        "HTTP-Referer": "https://github.com/iGLOO-be/gha-agent-demo",
        "X-Title": "env-title",
        ...HIDDEN_VISIBILITY,
      });
    });

    it("falls back to generic app name when nothing is set", () => {
      expect(buildOpenRouterHttpHeaders()).toEqual({
        "HTTP-Referer": "",
        "X-Title": "gha-agent",
        ...HIDDEN_VISIBILITY,
      });
    });

    it("falls back to appName when GITHUB_REPOSITORY is missing", () => {
      expect(buildOpenRouterHttpHeaders("my-consumer-app")).toEqual({
        "HTTP-Referer": "",
        "X-Title": "my-consumer-app",
        ...HIDDEN_VISIBILITY,
      });
    });

    it("adds OpenRouter metadata header when jev metadata is enabled", () => {
      expect(
        buildOpenRouterHttpHeaders("my-consumer-app", { jevMetadata: true }),
      ).toEqual({
        "HTTP-Referer": "",
        "X-Title": "my-consumer-app",
        ...HIDDEN_VISIBILITY,
        [OPENROUTER_METADATA_HEADER]: "enabled",
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

  describe("isOpenRouterRequestTimeoutMessage", () => {
    it("matches the fetch wrapper error", () => {
      expect(
        isOpenRouterRequestTimeoutMessage(
          new OpenRouterRequestTimeoutError(600_000).message,
        ),
      ).toBe(true);
    });

    it("ignores unrelated provider errors", () => {
      expect(isOpenRouterRequestTimeoutMessage("rate limit exceeded")).toBe(
        false,
      );
      expect(isOpenRouterRequestTimeoutMessage(undefined)).toBe(false);
    });
  });

  describe("createRequestTimeoutFetch", () => {
    it("returns a body that finishes before the deadline", async () => {
      const baseFetch = vi.fn<typeof fetch>(
        async () =>
          new Response("ok", {
            headers: { "content-type": "text/plain" },
          }),
      );
      const fetch = createRequestTimeoutFetch(1_000, baseFetch);
      const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
      );
      await expect(response.text()).resolves.toBe("ok");
    });

    it("aborts a stream that stays open past the deadline", async () => {
      const hung = new ReadableStream<Uint8Array>({
        start() {
          // never enqueue or close
        },
      });
      const baseFetch = vi.fn<typeof fetch>(async () => new Response(hung));
      const fetch = createRequestTimeoutFetch(30, baseFetch);
      const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
      );
      await expect(response.text()).rejects.toBeInstanceOf(
        OpenRouterRequestTimeoutError,
      );
    });
  });

  describe("buildOpenRouterProviderConfig", () => {
    it("wraps timeout for Cline providerConfig", () => {
      process.env.OPENROUTER_REQUEST_TIMEOUT_MS = "90000";
      const config = buildOpenRouterProviderConfig();
      expect(config.providerId).toBe(OPENROUTER_PROVIDER_ID);
      expect(config.timeoutMs).toBe(90_000);
      expect(typeof config.fetch).toBe("function");
    });

    it("attaches a fetch wrapper when jev router context is provided", () => {
      const config = buildOpenRouterProviderConfig({
        pool: { models: ["anthropic/*"], excluded_models: [] },
        metadata: true,
        servedModels: createServedModelTracker(),
        usageCost: createOpenRouterUsageCostTracker(),
      });
      expect(config.providerId).toBe(OPENROUTER_PROVIDER_ID);
      expect(config.timeoutMs).toBe(OPENROUTER_DEFAULT_REQUEST_TIMEOUT_MS);
      expect(typeof config.fetch).toBe("function");
    });
  });
});
