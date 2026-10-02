import { describe, expect, it } from "vitest";
import {
  buildBareFixWorkOrderHint,
  buildConflictPriorityHint,
} from "./fix-phase.js";

describe("fix-phase hints", () => {
  describe("buildBareFixWorkOrderHint", () => {
    it("returns empty when not a bare fix", () => {
      expect(buildBareFixWorkOrderHint(false, true, "review-fix")).toBe("");
    });

    it("prioritizes CI when checks failed", () => {
      const hint = buildBareFixWorkOrderHint(true, true, "review-fix");
      expect(hint).toContain("Failed CI checks");
      expect(hint).toContain("readCheckLogs");
    });

    it("uses review work order for slash fix without failed checks", () => {
      const hint = buildBareFixWorkOrderHint(true, false, "review-fix");
      expect(hint).toContain("PR review bodies");
    });

    it("does not use review work order for ci-fix without failed checks", () => {
      const hint = buildBareFixWorkOrderHint(true, false, "ci-fix");
      expect(hint).toContain("readCheckRuns");
      expect(hint).not.toContain("work order");
    });
  });

  describe("buildConflictPriorityHint", () => {
    it("ignores #discussion_r links as non-bare fix", () => {
      const hint = buildConflictPriorityHint(
        {
          conflicts: true,
          mergeable_state: "dirty",
          mergeable: false,
          behind_by: 0,
        },
        "/agent fix see #discussion_r12345",
        "main",
      );
      expect(hint).toBe("");
    });

    it("surfaces conflict priority on bare /agent fix", () => {
      const hint = buildConflictPriorityHint(
        {
          conflicts: true,
          mergeable_state: "dirty",
          mergeable: false,
          behind_by: 0,
        },
        "/agent fix",
        "next",
      );
      expect(hint).toContain("PRIORITY");
      expect(hint).toContain("next");
    });
  });
});
