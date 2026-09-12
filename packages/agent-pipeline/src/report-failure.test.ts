import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  buildBody,
  failureMarkerForPhase,
  formatError,
  redactSecrets,
  truncateDetails,
} from "./report-failure.js";

const ENV_KEYS = [
  "GITHUB_RUN_ID",
  "GITHUB_TOKEN",
  "OPENROUTER_API_KEY",
] as const;

describe("report-failure", () => {
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

  describe("formatError", () => {
    it("formats Error instances", () => {
      const error = new Error("boom");
      error.stack = "Error: boom\n    at file.ts:1:1";
      const { message, details } = formatError(error);
      expect(message).toBe("boom");
      expect(details).toBe("Error: boom\n    at file.ts:1:1");
    });

    it("formats strings", () => {
      const { message, details } = formatError("simple error");
      expect(message).toBe("simple error");
      expect(details).toBe("simple error");
    });

    it("formats objects as JSON", () => {
      const error = { code: 500, message: "bad" };
      const { message, details } = formatError(error);
      expect(message).toBe("{");
      expect(details).toBe(JSON.stringify(error, null, 2));
    });

    it("falls back to String for non-serializable objects", () => {
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      const { message } = formatError(obj);
      expect(message).toBe("[object Object]");
    });
  });

  describe("truncateDetails", () => {
    it("leaves short details unchanged", () => {
      expect(truncateDetails("short")).toBe("short");
    });

    it("truncates long details to 8000 characters with a suffix", () => {
      const longDetails = "x".repeat(10_000);
      const result = truncateDetails(longDetails);
      expect(result.length).toBeLessThan(8_100);
      expect(result).toContain("…(truncated)");
      expect(result.startsWith("x".repeat(100))).toBe(true);
    });
  });

  describe("redactSecrets", () => {
    it("masks GITHUB_TOKEN and OPENROUTER_API_KEY", () => {
      process.env.GITHUB_TOKEN = "ghs_abc123";
      process.env.OPENROUTER_API_KEY = "sk-or-key";

      expect(redactSecrets("token=ghs_abc123 key=sk-or-key end")).toBe(
        "token=*** key=*** end",
      );
    });

    it("leaves values unchanged when secrets are not set", () => {
      expect(redactSecrets("nothing secret here")).toBe("nothing secret here");
    });
  });

  describe("failureMarkerForPhase", () => {
    it("uses plan-failed marker for plan phase", () => {
      expect(failureMarkerForPhase("plan")).toBe("agent-plan-failed");
    });

    it("uses dedicated failed marker for each phase", () => {
      expect(failureMarkerForPhase("implement")).toBe("agent-implement-failed");
      expect(failureMarkerForPhase("yolo")).toBe("agent-yolo-failed");
      expect(failureMarkerForPhase("ci-fix")).toBe("agent-ci-fix-failed");
      expect(failureMarkerForPhase("review-fix")).toBe(
        "agent-review-fix-failed",
      );
    });
  });

  describe("buildBody", () => {
    it("builds a plan failure body", () => {
      process.env.GITHUB_RUN_ID = "99";
      const body = buildBody("plan", new Error("plan failed"));

      expect(body).toContain("## Agent Plan Failed");
      expect(body).toContain("agent-plan-failed");
      expect(body).toContain("plan failed");
      expect(body).toContain("<!-- agent-failed-run:99 -->");
    });

    it("builds an implement failure body", () => {
      process.env.GITHUB_RUN_ID = "99";
      const body = buildBody("implement", new Error("implement failed"));

      expect(body).toContain("## Agent Implement Failed");
      expect(body).toContain("agent-implement-failed");
      expect(body).toContain("implement failed");
    });

    it("builds a yolo failure body", () => {
      process.env.GITHUB_RUN_ID = "99";
      const body = buildBody("yolo", new Error("yolo failed"));

      expect(body).toContain("## Agent Yolo Failed");
      expect(body).toContain("agent-yolo-failed");
      expect(body).toContain("yolo failed");
    });

    it("builds a review-fix failure body", () => {
      process.env.GITHUB_RUN_ID = "99";
      const body = buildBody("review-fix", new Error("review-fix failed"));

      expect(body).toContain("## Agent Review Fix Failed");
      expect(body).toContain("agent-review-fix-failed");
      expect(body).toContain("review-fix failed");
    });

    it("builds a ci-fix failure body", () => {
      process.env.GITHUB_RUN_ID = "99";
      const body = buildBody("ci-fix", new Error("ci-fix failed"));

      expect(body).toContain("## Agent CI Fix Failed");
      expect(body).toContain("agent-ci-fix-failed");
      expect(body).toContain("ci-fix failed");
    });

    it("falls back to a local run marker when GITHUB_RUN_ID is missing", () => {
      const body = buildBody("ci-fix", "oops");

      expect(body).toContain("<!-- agent-failed-run:local -->");
    });

    it("mentions that run URL is unavailable outside GitHub Actions", () => {
      const body = buildBody("yolo", "oops");
      expect(body).toContain("(not available outside GitHub Actions)");
    });
  });
});
