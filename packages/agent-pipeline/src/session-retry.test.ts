import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IMPLEMENT_MODEL, REVIEW_FIX_MODEL } from "./config.js";
import {
  AgentSessionError,
  getSessionMaxAttempts,
  getSessionRetryBaseDelayMs,
  isRetriableSessionFinishReason,
  resolvePhaseModel,
} from "./session-retry.js";

const ENV_KEYS = [
  "AGENT_SESSION_MAX_ATTEMPTS",
  "AGENT_SESSION_RETRY_BASE_DELAY_MS",
  "AGENT_MODEL_PLAN",
  "AGENT_MODEL_IMPLEMENT",
  "AGENT_MODEL_REVIEW_FIX",
] as const;

describe("session-retry", () => {
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

  describe("isRetriableSessionFinishReason", () => {
    it("treats aborted and error as retriable", () => {
      expect(isRetriableSessionFinishReason("aborted")).toBe(true);
      expect(isRetriableSessionFinishReason("error")).toBe(true);
    });

    it("does not retry terminal finish reasons", () => {
      expect(isRetriableSessionFinishReason("completed")).toBe(false);
      expect(isRetriableSessionFinishReason("mistake_limit")).toBe(false);
      expect(isRetriableSessionFinishReason("max_iterations")).toBe(false);
    });
  });

  describe("getSessionMaxAttempts", () => {
    it("defaults to 3", () => {
      expect(getSessionMaxAttempts()).toBe(3);
    });

    it("parses a valid override", () => {
      process.env.AGENT_SESSION_MAX_ATTEMPTS = "5";
      expect(getSessionMaxAttempts()).toBe(5);
    });

    it("falls back when out of range", () => {
      process.env.AGENT_SESSION_MAX_ATTEMPTS = "0";
      expect(getSessionMaxAttempts()).toBe(3);
      process.env.AGENT_SESSION_MAX_ATTEMPTS = "99";
      expect(getSessionMaxAttempts()).toBe(3);
    });
  });

  describe("getSessionRetryBaseDelayMs", () => {
    it("defaults to 10_000", () => {
      expect(getSessionRetryBaseDelayMs()).toBe(10_000);
    });

    it("parses a valid override", () => {
      process.env.AGENT_SESSION_RETRY_BASE_DELAY_MS = "2500";
      expect(getSessionRetryBaseDelayMs()).toBe(2500);
    });

    it("allows zero delay", () => {
      process.env.AGENT_SESSION_RETRY_BASE_DELAY_MS = "0";
      expect(getSessionRetryBaseDelayMs()).toBe(0);
    });
  });

  describe("resolvePhaseModel", () => {
    it("returns the config-driven default when no override is set", () => {
      expect(resolvePhaseModel("implement", IMPLEMENT_MODEL)).toBe(
        IMPLEMENT_MODEL,
      );
    });

    it("reads AGENT_MODEL_<PHASE> with hyphens mapped to underscores", () => {
      process.env.AGENT_MODEL_REVIEW_FIX = "anthropic/claude-sonnet-4";
      expect(resolvePhaseModel("review-fix", REVIEW_FIX_MODEL)).toBe(
        "anthropic/claude-sonnet-4",
      );
    });
  });

  describe("AgentSessionError", () => {
    it("exposes retriable from finishReason", () => {
      const err = new AgentSessionError("failed", {
        finishReason: "aborted",
        sessionId: "s1",
        attempt: 2,
      });
      expect(err.retriable).toBe(true);
      expect(err.name).toBe("AgentSessionError");
      expect(err.attempt).toBe(2);
    });
  });
});
