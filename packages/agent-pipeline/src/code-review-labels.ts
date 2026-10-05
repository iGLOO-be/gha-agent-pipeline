import type { Octokit } from "@octokit/rest";
import type { AgentConfig } from "./config.js";
import type { ReviewTracker } from "./tools/index.js";
import {
  listReviewCommentBodiesForReview,
  manageExclusiveLabels,
  maxInlineReviewSeverity,
  parseMergeRiskLevel,
  removeLabelsFromIssue,
  riskLabelEnsureOptions,
  type InlineReviewSeverity,
  type PullRequestReviewEvent,
} from "./tools/github.js";

export type CodeReviewLabelsApplyTo = "pr" | "issue" | "both";

export type ResolvedCodeReviewMergeRiskLabels = {
  low: string;
  medium: string;
  high: string;
};

export type ResolvedCodeReviewSeverityLabels = {
  minor: string;
  major: string;
  critical: string;
};

export type ResolvedCodeReviewLabelsConfig = {
  applyTo: CodeReviewLabelsApplyTo;
  statusOk?: string;
  statusPending?: string;
  mergeRisk?: ResolvedCodeReviewMergeRiskLabels;
  severity?: ResolvedCodeReviewSeverityLabels;
};

export function resolveCodeReviewLabelsConfig(
  config: AgentConfig,
): ResolvedCodeReviewLabelsConfig | null {
  const labels = config.code_review?.labels;
  if (!labels) {
    return null;
  }

  const statusOk = labels.status?.ok;
  const statusPending = labels.status?.pending;
  const mergeRiskBlock = labels.merge_risk;
  const mergeRiskEnabled = mergeRiskBlock?.enabled ?? true;
  const severityBlock = labels.severity;
  const severityEnabled = severityBlock?.enabled ?? true;

  const resolved: ResolvedCodeReviewLabelsConfig = {
    applyTo: labels.apply_to ?? "pr",
    statusOk,
    statusPending,
  };

  if (mergeRiskBlock && mergeRiskEnabled) {
    resolved.mergeRisk = {
      low: mergeRiskBlock.low ?? "agent-risk-low",
      medium: mergeRiskBlock.medium ?? "agent-risk-medium",
      high: mergeRiskBlock.high ?? "agent-risk-high",
    };
  }

  if (severityBlock && severityEnabled) {
    resolved.severity = {
      minor: severityBlock.minor ?? "ai-review:minor",
      major: severityBlock.major ?? "ai-review:major",
      critical: severityBlock.critical ?? "ai-review:critical",
    };
  }

  if (
    !resolved.statusOk &&
    !resolved.statusPending &&
    !resolved.mergeRisk &&
    !resolved.severity
  ) {
    return null;
  }

  return resolved;
}

function resolveLabelTargets(
  applyTo: CodeReviewLabelsApplyTo,
  prNumber: number,
  issueNumber: number,
): number[] {
  const targets: number[] = [];
  if (applyTo === "pr" || applyTo === "both") {
    targets.push(prNumber);
  }
  if (applyTo === "issue" || applyTo === "both") {
    targets.push(issueNumber);
  }
  return [...new Set(targets)];
}

function statusLabelForEvent(
  event: PullRequestReviewEvent,
  config: ResolvedCodeReviewLabelsConfig,
): string | null {
  if (event === "REQUEST_CHANGES") {
    return config.statusPending ?? null;
  }
  return config.statusOk ?? null;
}

function severityLabelNames(
  severity: ResolvedCodeReviewSeverityLabels,
): string[] {
  return [severity.minor, severity.major, severity.critical];
}

export async function applyCodeReviewLabels(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  issueNumber: number;
  review: ReviewTracker;
  labelsConfig: ResolvedCodeReviewLabelsConfig;
}): Promise<void> {
  const { octokit, owner, repo, prNumber, issueNumber, review, labelsConfig } =
    params;

  if (!review.posted) {
    return;
  }

  const targets = resolveLabelTargets(
    labelsConfig.applyTo,
    prNumber,
    issueNumber,
  );
  const reviewBody = review.body ?? "";

  let maxSeverity: InlineReviewSeverity | null = null;
  if (labelsConfig.severity && review.id != null) {
    const bodies = await listReviewCommentBodiesForReview(
      octokit,
      owner,
      repo,
      prNumber,
      review.id,
    );
    maxSeverity = maxInlineReviewSeverity(bodies);
  }

  // Fail safe: an unknown review event must not be labelled as `status.ok`
  // (a possibly-blocking review would look approved). Both writers set
  // `event`, so this only guards against future regressions.
  let statusLabel = review.event
    ? statusLabelForEvent(review.event, labelsConfig)
    : null;
  if (
    statusLabel &&
    labelsConfig.statusOk &&
    statusLabel === labelsConfig.statusOk &&
    maxSeverity
  ) {
    statusLabel = null;
  }

  const statusSiblingLabels = [
    labelsConfig.statusOk,
    labelsConfig.statusPending,
  ].filter((name): name is string => Boolean(name));

  const mergeLevel = labelsConfig.mergeRisk
    ? parseMergeRiskLevel(reviewBody)
    : null;

  for (const targetNumber of targets) {
    if (statusLabel) {
      await manageExclusiveLabels(
        octokit,
        owner,
        repo,
        targetNumber,
        statusSiblingLabels,
        statusLabel,
      );
    } else if (statusSiblingLabels.length > 0) {
      // No status label for this event (only one side configured, an unknown
      // event, or COMMENT with inline severity): clear stale status labels.
      await removeLabelsFromIssue(
        octokit,
        owner,
        repo,
        targetNumber,
        statusSiblingLabels,
      );
    }

    if (labelsConfig.mergeRisk && mergeLevel) {
      const names = [
        labelsConfig.mergeRisk.low,
        labelsConfig.mergeRisk.medium,
        labelsConfig.mergeRisk.high,
      ];
      await manageExclusiveLabels(
        octokit,
        owner,
        repo,
        targetNumber,
        names,
        labelsConfig.mergeRisk[mergeLevel],
        riskLabelEnsureOptions,
      );
    } else if (labelsConfig.mergeRisk) {
      // No parseable risk level this round: drop any stale risk label rather
      // than letting an old `agent-risk-*` contradict the latest review.
      await removeLabelsFromIssue(octokit, owner, repo, targetNumber, [
        labelsConfig.mergeRisk.low,
        labelsConfig.mergeRisk.medium,
        labelsConfig.mergeRisk.high,
      ]);
    }

    if (labelsConfig.severity) {
      const names = severityLabelNames(labelsConfig.severity);
      if (maxSeverity) {
        await manageExclusiveLabels(
          octokit,
          owner,
          repo,
          targetNumber,
          names,
          labelsConfig.severity[maxSeverity],
        );
      } else {
        await removeLabelsFromIssue(octokit, owner, repo, targetNumber, names);
      }
    }
  }
}
