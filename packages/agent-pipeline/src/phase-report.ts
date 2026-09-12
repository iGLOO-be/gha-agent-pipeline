import { loadClineSdk } from "./cline.js";
import { redactSensitiveStrings } from "./gha-log.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface PhaseReport {
  /** Markdown summary (required, truncated to ~8k chars after redaction). */
  summary: string;
  /** Optional test plan (truncated to ~4k chars after redaction). */
  testPlan?: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

const SUMMARY_MAX_CHARS = 8_000;
const TEST_PLAN_MAX_CHARS = 4_000;

/** HTML comment injected before the phase report markdown. */
const PHASE_REPORT_MARKER = "<!-- agent-phase-report -->";

// ── Truncation helpers ──────────────────────────────────────────────────────

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

// ── Tracker ─────────────────────────────────────────────────────────────────

/**
 * Simple in-memory tracker. The tool writes here; the runner reads after the
 * session completes. Last submission wins if the agent calls the tool multiple
 * times.
 */
export class PhaseReportTracker {
  private _report: PhaseReport | undefined;

  get report(): PhaseReport | undefined {
    return this._report;
  }

  submit(report: PhaseReport): void {
    this._report = report;
  }

  clear(): void {
    this._report = undefined;
  }
}

export function createPhaseReportTracker(): PhaseReportTracker {
  return new PhaseReportTracker();
}

// ── Tool factory ────────────────────────────────────────────────────────────

export const SUBMIT_PHASE_REPORT_TOOL_NAME = "submitPhaseReport";

export async function createSubmitPhaseReportTool(tracker: PhaseReportTracker) {
  const { createTool } = await loadClineSdk();

  return createTool({
    name: SUBMIT_PHASE_REPORT_TOOL_NAME,
    description:
      "Submit a structured markdown report for the current phase. " +
      "Call this after finishing all edits to summarize what was done for human reviewers. " +
      "Last submission wins if called multiple times.",
    lifecycle: { completesRun: true },
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "Required markdown summary of changes made, files touched, and rationale.",
        },
        testPlan: {
          type: "string",
          description:
            "Optional markdown section describing how to test the changes.",
        },
      },
      required: ["summary"],
    },
    async execute(input: { summary: string; testPlan?: string }) {
      const report: PhaseReport = {
        summary: truncate(
          redactSensitiveStrings(input.summary),
          SUMMARY_MAX_CHARS,
        ),
        testPlan: input.testPlan
          ? truncate(
              redactSensitiveStrings(input.testPlan),
              TEST_PLAN_MAX_CHARS,
            )
          : undefined,
      };
      tracker.submit(report);
      return {
        submitted: true,
        summaryLength: report.summary.length,
        testPlanLength: report.testPlan?.length,
      };
    },
  });
}

// ── Formatters ──────────────────────────────────────────────────────────────

/**
 * Format the phase report for inclusion in a PR body (implement / yolo).
 * Returns the markdown section ready to append.
 */
export function formatPhaseReportForPr(report: PhaseReport): string {
  const lines: string[] = [
    "",
    PHASE_REPORT_MARKER,
    "## Implementation",
    "",
    report.summary,
  ];

  if (report.testPlan) {
    lines.push("", "### Test plan", "", report.testPlan);
  }

  return lines.join("\n");
}

/**
 * Format the phase report for inclusion in a fix PR comment (ci-fix / review-fix).
 * Returns the markdown section ready to prepend to the comment body.
 */
export function formatPhaseReportForComment(report: PhaseReport): string {
  const lines: string[] = [
    PHASE_REPORT_MARKER,
    "## Agent phase report",
    "",
    report.summary,
  ];

  if (report.testPlan) {
    lines.push("", "### Test plan", "", report.testPlan);
  }

  return lines.join("\n");
}

// ── Tool wiring helper ──────────────────────────────────────────────────────

/**
 * Appends a submitPhaseReport tool to an existing tool array.
 * Returns a new array; does not mutate the original.
 */
export async function appendSubmitPhaseReportTool<T extends { name: string }>(
  tools: T[],
  tracker: PhaseReportTracker,
): Promise<T[]> {
  const tool = await createSubmitPhaseReportTool(tracker);
  return [...tools, tool as T];
}
