import { afterEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";

vi.mock("./tools/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools/github.js")>();
  return {
    ...actual,
    readCheckRuns: vi.fn(async () => []),
  };
});

import {
  buildBareFixWorkOrderHint,
  buildConflictPriorityHint,
  preloadFailedChecksSummary,
} from "./fix-phase.js";
import { readCheckRuns } from "./tools/github.js";

const readCheckRunsMock = vi.mocked(readCheckRuns);

const octokit = {} as Octokit;

describe("fix-phase hints", () => {
  describe("buildBareFixWorkOrderHint", () => {
    it("returns empty when not a bare fix", () => {
      expect(buildBareFixWorkOrderHint(false, true)).toBe("");
    });

    it("prioritizes CI when checks failed", () => {
      const hint = buildBareFixWorkOrderHint(true, true);
      expect(hint).toContain("Failed CI checks");
      expect(hint).toContain("readCheckLogs");
    });

    it("uses review work order without failed checks", () => {
      const hint = buildBareFixWorkOrderHint(true, false);
      expect(hint).toContain("PR review bodies");
    });
  });

  describe("buildConflictPriorityHint", () => {
    const conflictingState = {
      conflicts: true,
      mergeable_state: "dirty",
      mergeable: false,
      behind_by: 0,
    };

    it("ignores #discussion_r links as non-bare fix", () => {
      expect(
        buildConflictPriorityHint(
          conflictingState,
          "/agent fix see #discussion_r12345",
          "main",
        ),
      ).toBe("");
    });

    it("surfaces conflict priority on bare /agent fix", () => {
      const hint = buildConflictPriorityHint(
        conflictingState,
        "/agent fix",
        "next",
      );
      expect(hint).toContain("PRIORITY");
      expect(hint).toContain("next");
    });
  });
});

describe("preloadFailedChecksSummary", () => {
  afterEach(() => {
    readCheckRunsMock.mockReset();
    readCheckRunsMock.mockResolvedValue([]);
  });

  it("reports failed check runs", async () => {
    readCheckRunsMock.mockResolvedValue([
      { id: 1, name: "CI", conclusion: "failure" },
    ] as never);

    const result = await preloadFailedChecksSummary(
      octokit,
      "o",
      "r",
      "sha",
      "review-fix",
    );

    expect(result.hasFailedChecks).toBe(true);
    expect(result.summary).toContain("CI");
  });

  it("degrades for review-fix when check runs cannot be read", async () => {
    readCheckRunsMock.mockRejectedValue(new Error("Resource not accessible"));

    await expect(
      preloadFailedChecksSummary(octokit, "o", "r", "sha", "review-fix"),
    ).resolves.toMatchObject({ hasFailedChecks: false });
  });

  it("rethrows for ci-fix when check runs cannot be read", async () => {
    readCheckRunsMock.mockRejectedValue(new Error("Resource not accessible"));

    await expect(
      preloadFailedChecksSummary(octokit, "o", "r", "sha", "ci-fix"),
    ).rejects.toThrow("Resource not accessible");
  });
});
