import type { AgentPhase } from "./config.js";
import { loadClineSdk } from "./cline.js";
import { normalizeRiskLevel, type RiskLevel } from "./tools/github.js";
import { redactSensitiveStrings, safeFormatUsageMarkdown } from "./gha-log.js";
import { PHASE_LABELS } from "./lifecycle.js";
import {
  formatRunFrictionMarkdown,
  type RunFrictionCollector,
} from "./run-friction.js";
import type { SessionAccumulatedUsage } from "./types/usage.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface PhaseReport {
  /** Markdown summary (required, truncated to ~8k chars after redaction). */
  summary: string;
  /** Optional test plan (truncated to ~4k chars after redaction). */
  testPlan?: string;
  /** Yolo (and future phases): structured risk for labels — not parsed from markdown. */
  riskLevel?: RiskLevel;
  riskJustification?: string;
}

export type SubmitPhaseReportOptions = {
  /** When true, riskLevel and riskJustification are required tool args (yolo). */
  requireRiskAssessment?: boolean;
};

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

export async function createSubmitPhaseReportTool(
  tracker: PhaseReportTracker,
  options: SubmitPhaseReportOptions = {},
) {
  const { createTool } = await loadClineSdk();
  const requireRisk = options.requireRiskAssessment === true;

  const riskProperties = {
    riskLevel: {
      type: "string",
      enum: ["low", "medium", "high"],
      description:
        "Overall implementation risk for agent-risk-* labels and the issue comment.",
    },
    riskJustification: {
      type: "string",
      description:
        "One short paragraph explaining the risk level (scope, reversibility, infra, security).",
    },
  };

  const required = requireRisk
    ? ["summary", "riskLevel", "riskJustification"]
    : ["summary"];

  return createTool({
    name: SUBMIT_PHASE_REPORT_TOOL_NAME,
    description:
      "Submit a structured markdown report for the current phase. " +
      "Call this after finishing all edits to summarize what was done for human reviewers. " +
      (requireRisk
        ? "You must include riskLevel and riskJustification for labeling. "
        : "") +
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
        ...(requireRisk ? riskProperties : {}),
      },
      required,
    },
    async execute(input: {
      summary: string;
      testPlan?: string;
      riskLevel?: string;
      riskJustification?: string;
    }) {
      let riskLevel: RiskLevel | undefined;
      let riskJustification: string | undefined;

      if (requireRisk) {
        const level = normalizeRiskLevel(input.riskLevel ?? "");
        if (!level) {
          throw new Error(`Invalid riskLevel: ${input.riskLevel}`);
        }
        const justification = (input.riskJustification ?? "").trim();
        if (!justification) {
          throw new Error("riskJustification must not be empty");
        }
        riskLevel = level;
        riskJustification = truncate(
          redactSensitiveStrings(justification),
          TEST_PLAN_MAX_CHARS,
        );
      } else if (input.riskLevel || input.riskJustification) {
        const level = normalizeRiskLevel(input.riskLevel ?? "");
        const justification = (input.riskJustification ?? "").trim();
        if (level && justification) {
          riskLevel = level;
          riskJustification = truncate(
            redactSensitiveStrings(justification),
            TEST_PLAN_MAX_CHARS,
          );
        }
      }

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
        riskLevel,
        riskJustification,
      };
      tracker.submit(report);
      return {
        submitted: true,
        summaryLength: report.summary.length,
        testPlanLength: report.testPlan?.length,
        riskLevel: report.riskLevel,
      };
    },
  });
}

// ── Formatters ──────────────────────────────────────────────────────────────

/**
 * Format the phase report for inclusion in a PR body (implement / yolo).
 * Emits the marker and the agent-provided summary (which should include its
 * own heading per AGENTS.md). Does not inject a heading — the PR body
 * already provides the structural `## 🤖 Agent PR` heading.
 */
export function formatPhaseReportForPr(report: PhaseReport): string {
  const lines: string[] = ["", PHASE_REPORT_MARKER, "", report.summary];

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

// ── Phase completion block ──────────────────────────────────────────────────

export interface FormatPhaseCompletionOptions {
  phase: AgentPhase;
  /** Status line summarizing the runner outcome (e.g. "Pushed a CI fix commit").
   * Omit to suppress the status line (the caller may provide its own wrapper). */
  statusLine?: string;
  /** Optional phase report from submitPhaseReport tool (agent-provided business summary). */
  phaseReport?: PhaseReport;
  /** Session usage for run metrics (omits metrics section when undefined). */
  sessionUsage?: SessionAccumulatedUsage;
  /** Session ID for the metrics table (omitted when sessionUsage is absent). */
  sessionId?: string;
  /** Model ID for the metrics table (omitted when sessionUsage is absent). */
  modelId?: string;
  /** Iterations count for the metrics table. */
  iterations?: number;
  /** Tool calls count for the metrics table. */
  toolCallsCount?: number;
  /** Run friction collector for the run friction section. */
  runFriction?: RunFrictionCollector;
  /** When true, wraps the ### Run metrics section in a
   * <details><summary>Run metrics</summary>…</details> block
   * for collapsibility in GitHub comments. Defaults to false. */
  collapsibleMetrics?: boolean;
}

/**
 * Build a unified end-of-phase markdown block suitable for PR comments
 * (ci-fix, review-fix) or issue completion comments (implement, yolo).
 *
 * Always emits the phase marker + title. The status line is optional
 * (omitted when the caller provides its own wrapper). The agent
 * business report (summary/testPlan) and runner-owned metrics + friction
 * are injected when available.
 */
export function formatPhaseCompletionMarkdown(
  opts: FormatPhaseCompletionOptions,
): string {
  const phaseLabel = PHASE_LABELS[opts.phase] ?? opts.phase;
  const sections: string[] = [
    PHASE_REPORT_MARKER,
    `## Agent phase report (${phaseLabel})`,
    "",
  ];

  // Status line (omitted when caller provides its own wrapper)
  if (opts.statusLine) {
    sections.push(opts.statusLine);
  }

  // Agent business summary
  if (opts.phaseReport) {
    sections.push("", opts.phaseReport.summary);
    if (opts.phaseReport.testPlan) {
      sections.push("", "### Test plan", "", opts.phaseReport.testPlan);
    }
  } else {
    sections.push("", "_No business summary was submitted._");
  }

  // Runner-owned run metrics
  if (opts.sessionUsage) {
    const usageMd = safeFormatUsageMarkdown(opts.sessionUsage, {
      heading: "### Run metrics",
      sessionId: opts.sessionId,
      modelId: opts.modelId,
      iterations: opts.iterations,
      toolCallsCount: opts.toolCallsCount,
    });
    if (usageMd) {
      if (opts.collapsibleMetrics) {
        // Wrap in <details> for collapsibility. The usage markdown starts
        // with a leading newline; strip it and demote the heading one level
        // so it nests properly inside the collapsible block.
        const demoted = usageMd
          .replace(/^\n/, "")
          .replace(/^### Run metrics/m, "#### Run metrics");
        const wrapper = [
          "<details>",
          "<summary>Run metrics</summary>",
          "",
          demoted,
          "",
          "</details>",
        ].join("\n");
        sections.push("", wrapper);
      } else {
        sections.push("", usageMd);
      }
    }
  }

  // Run friction
  if (opts.runFriction) {
    const frictionMd = formatRunFrictionMarkdown(opts.runFriction);
    if (frictionMd) {
      sections.push("", frictionMd);
    }
  }

  return sections.join("\n");
}

// ── Tool wiring helper ──────────────────────────────────────────────────────

/**
 * Appends a submitPhaseReport tool to an existing tool array.
 * Returns a new array; does not mutate the original.
 */
export async function appendSubmitPhaseReportTool<T extends { name: string }>(
  tools: T[],
  tracker: PhaseReportTracker,
  options?: SubmitPhaseReportOptions,
): Promise<T[]> {
  const tool = await createSubmitPhaseReportTool(tracker, options);
  return [...tools, tool as T];
}
