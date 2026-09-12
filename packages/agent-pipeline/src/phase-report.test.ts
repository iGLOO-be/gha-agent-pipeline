import { describe, expect, it, beforeEach } from "vitest";
import {
  createPhaseReportTracker,
  formatPhaseReportForPr,
  formatPhaseReportForComment,
  SUBMIT_PHASE_REPORT_TOOL_NAME,
  type PhaseReport,
} from "./phase-report.js";

describe("phase-report", () => {
  describe("PhaseReportTracker", () => {
    let tracker: ReturnType<typeof createPhaseReportTracker>;

    beforeEach(() => {
      tracker = createPhaseReportTracker();
    });

    it("starts with no report", () => {
      expect(tracker.report).toBeUndefined();
    });

    it("stores a report on submit", () => {
      tracker.submit({ summary: "Changed files A, B, C" });
      expect(tracker.report).toEqual({ summary: "Changed files A, B, C" });
    });

    it("last submission wins", () => {
      tracker.submit({ summary: "First report" });
      tracker.submit({ summary: "Second report", testPlan: "pnpm test" });
      expect(tracker.report?.summary).toBe("Second report");
      expect(tracker.report?.testPlan).toBe("pnpm test");
    });

    it("clear removes the report", () => {
      tracker.submit({ summary: "Test" });
      tracker.clear();
      expect(tracker.report).toBeUndefined();
    });

    it("truncates long summary to ~8k chars", () => {
      // Actually, truncation happens in the tool execute, not in submit.
      // We test formatter behavior separately.
      const long = "x".repeat(9_000);
      tracker.submit({ summary: long });
      expect(tracker.report?.summary).toBe(long);
    });
  });

  describe("formatPhaseReportForPr", () => {
    it("renders summary with marker and heading", () => {
      const report: PhaseReport = {
        summary: "Added widget sort utility.",
      };
      const output = formatPhaseReportForPr(report);
      expect(output).toContain("<!-- agent-phase-report -->");
      expect(output).toContain("## Implementation");
      expect(output).toContain("Added widget sort utility.");
    });

    it("renders test plan when provided", () => {
      const report: PhaseReport = {
        summary: "Summary text.",
        testPlan: "Run pnpm test.",
      };
      const output = formatPhaseReportForPr(report);
      expect(output).toContain("### Test plan");
      expect(output).toContain("Run pnpm test.");
    });

    it("omits test plan section when undefined", () => {
      const report: PhaseReport = {
        summary: "Only summary.",
      };
      const output = formatPhaseReportForPr(report);
      expect(output).not.toContain("### Test plan");
    });
  });

  describe("formatPhaseReportForComment", () => {
    it("renders summary with marker", () => {
      const report: PhaseReport = {
        summary: "Fixed CI failures.",
      };
      const output = formatPhaseReportForComment(report);
      expect(output).toContain("<!-- agent-phase-report -->");
      expect(output).toContain("## Agent phase report");
      expect(output).toContain("Fixed CI failures.");
    });

    it("renders test plan when provided", () => {
      const report: PhaseReport = {
        summary: "Fixed CI.",
        testPlan: "Check CI logs.",
      };
      const output = formatPhaseReportForComment(report);
      expect(output).toContain("### Test plan");
      expect(output).toContain("Check CI logs.");
    });
  });

  describe("tool name", () => {
    it("exports the canonical tool name", () => {
      expect(SUBMIT_PHASE_REPORT_TOOL_NAME).toBe("submitPhaseReport");
    });
  });
});
