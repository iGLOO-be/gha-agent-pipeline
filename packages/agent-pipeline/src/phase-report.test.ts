import { describe, expect, it, beforeEach } from "vitest";
import {
  createPhaseReportTracker,
  formatPhaseReportForPr,
  formatPhaseReportForComment,
  formatPhaseCompletionMarkdown,
  SUBMIT_PHASE_REPORT_TOOL_NAME,
  type PhaseReport,
} from "./phase-report.js";
import { createRunFrictionCollector } from "./run-friction.js";

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

  describe("formatPhaseCompletionMarkdown", () => {
    it("renders full block with report, session metrics, and friction", () => {
      const collector = createRunFrictionCollector();
      collector.record({
        source: "runtime",
        category: "tool_error",
        summary: "apply_patch failed due to mismatch",
      });

      const output = formatPhaseCompletionMarkdown({
        phase: "ci-fix",
        statusLine: "Pushed CI fix commit.",
        phaseReport: {
          summary: "Fixed lint issues.",
          testPlan: "Run pnpm test.",
        },
        sessionUsage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 200,
          cacheWriteTokens: 0,
          totalCost: 0.0015,
        },
        sessionId: "sess-1",
        modelId: "deepseek/v3",
        iterations: 3,
        toolCallsCount: 5,
        runFriction: collector,
      });

      expect(output).toContain("<!-- agent-phase-report -->");
      expect(output).toContain("## Agent phase report (CI Fix)");
      expect(output).toContain("Pushed CI fix commit.");
      expect(output).toContain("Fixed lint issues.");
      expect(output).toContain("### Test plan");
      expect(output).toContain("Run pnpm test.");
      expect(output).toContain("### Run metrics");
      expect(output).toContain("`sess-1`");
      expect(output).toContain("`deepseek/v3`");
      expect(output).toContain("### Run friction");
      expect(output).toContain("apply_patch failed");
    });

    it("omits test plan section when not provided", () => {
      const output = formatPhaseCompletionMarkdown({
        phase: "review-fix",
        statusLine: "Pushed review fixes.",
        phaseReport: { summary: "Addressed feedback." },
        sessionUsage: {
          inputTokens: 500,
          outputTokens: 200,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalCost: 0.0005,
        },
        sessionId: "sess-2",
      });

      expect(output).toContain("## Agent phase report (Review Fix)");
      expect(output).toContain("Addressed feedback.");
      expect(output).not.toContain("### Test plan");
      expect(output).toContain("### Run metrics");
    });

    it("shows neutral fallback when phase report is absent", () => {
      const output = formatPhaseCompletionMarkdown({
        phase: "implement",
        statusLine: "PR #42 created.",
        sessionUsage: {
          inputTokens: 2000,
          outputTokens: 800,
          cacheReadTokens: 300,
          cacheWriteTokens: 0,
          totalCost: 0.003,
        },
        sessionId: "sess-3",
        modelId: "deepseek/v3",
      });

      expect(output).toContain("## Agent phase report (Implement)");
      expect(output).toContain("PR #42 created.");
      expect(output).toContain("_No business summary was submitted._");
      expect(output).toContain("### Run metrics");
      expect(output).not.toContain("### Run friction");
      expect(output).not.toContain("### Test plan");
    });

    it("omits metrics section when sessionUsage is absent", () => {
      const collector = createRunFrictionCollector();
      collector.record({
        source: "agent",
        category: "missing_context",
        summary: "AGENTS.md was stale",
      });

      const output = formatPhaseCompletionMarkdown({
        phase: "ci-fix",
        statusLine: "No changes needed.",
        phaseReport: { summary: "Nothing to fix." },
        runFriction: collector,
      });

      expect(output).toContain("## Agent phase report (CI Fix)");
      expect(output).toContain("Nothing to fix.");
      expect(output).not.toContain("### Run metrics");
      expect(output).toContain("### Run friction");
    });

    it("omits friction section when collector has no notes", () => {
      const collector = createRunFrictionCollector();

      const output = formatPhaseCompletionMarkdown({
        phase: "yolo",
        statusLine: "PR #10 created.",
        phaseReport: { summary: "Built feature." },
        sessionUsage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalCost: 0.0001,
        },
        runFriction: collector,
      });

      expect(output).not.toContain("### Run friction");
      expect(output).toContain("### Run metrics");
    });

    it("renders minimal block when all optional sections are absent", () => {
      const output = formatPhaseCompletionMarkdown({
        phase: "plan",
        statusLine: "Plan completed.",
      });

      expect(output).toContain("<!-- agent-phase-report -->");
      expect(output).toContain("## Agent phase report (Plan)");
      expect(output).toContain("Plan completed.");
      expect(output).toContain("_No business summary was submitted._");
      expect(output).not.toContain("### Run metrics");
      expect(output).not.toContain("### Run friction");
      expect(output).not.toContain("### Test plan");
    });
  });
});
