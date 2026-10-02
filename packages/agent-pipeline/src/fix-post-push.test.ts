import { afterEach, describe, expect, it, vi } from "vitest";
import { PullRequestStillConflictingError } from "./tools/github.js";
import {
  formatMergeStillBlockedStatusLine,
  getUpstreamDriftMaxPasses,
  isUpstreamDriftAfterPush,
  shouldRetryUpstreamDriftAfterPush,
} from "./fix-post-push.js";

describe("fix-post-push", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("getUpstreamDriftMaxPasses", () => {
    it("defaults to 2 passes", () => {
      expect(getUpstreamDriftMaxPasses()).toBe(2);
    });

    it("clamps AGENT_UPSTREAM_DRIFT_MAX_PASSES to 1–3", () => {
      vi.stubEnv("AGENT_UPSTREAM_DRIFT_MAX_PASSES", "9");
      expect(getUpstreamDriftMaxPasses()).toBe(3);
      vi.stubEnv("AGENT_UPSTREAM_DRIFT_MAX_PASSES", "0");
      expect(getUpstreamDriftMaxPasses()).toBe(1);
    });
  });

  describe("isUpstreamDriftAfterPush", () => {
    it("is true when dirty and behind base", () => {
      expect(
        isUpstreamDriftAfterPush({
          mergeable: false,
          mergeable_state: "dirty",
          behind_by: 5,
          conflicts: true,
        }),
      ).toBe(true);
    });

    it("is false when dirty but not behind", () => {
      expect(
        isUpstreamDriftAfterPush({
          mergeable: false,
          mergeable_state: "dirty",
          behind_by: 0,
          conflicts: true,
        }),
      ).toBe(false);
    });
  });

  describe("shouldRetryUpstreamDriftAfterPush", () => {
    const error = new PullRequestStillConflictingError(1, {
      mergeable: false,
      mergeable_state: "dirty",
      behind_by: 3,
      conflicts: true,
    });

    it("allows retry on first pass when maxPasses > 1", () => {
      expect(shouldRetryUpstreamDriftAfterPush(error, 0, 2)).toBe(true);
    });

    it("does not retry on last pass", () => {
      expect(shouldRetryUpstreamDriftAfterPush(error, 1, 2)).toBe(false);
    });
  });

  describe("formatMergeStillBlockedStatusLine", () => {
    it("includes merge state and behind_by", () => {
      const line = formatMergeStillBlockedStatusLine(
        "Pushed review fixes for PR #102.",
        "main",
        new PullRequestStillConflictingError(102, {
          mergeable: false,
          mergeable_state: "dirty",
          behind_by: 5,
          conflicts: true,
        }),
      );
      expect(line).toContain("Pushed review fixes");
      expect(line).toContain("`main`");
      expect(line).toContain("behind_by: 5");
      expect(line).toContain("/agent fix");
    });
  });
});
