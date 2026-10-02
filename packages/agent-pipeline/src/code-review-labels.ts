import type { Octokit } from "@octokit/rest";
import type { AgentConfig } from "./config.js";
import type { ReviewTracker } from "./tools/index.js";
import {
  manageExclusiveLabels,
  parseMergeRiskLevel,
  riskLabelEnsureOptions,
  type PullRequestReviewEvent,
} from "./tools/github.js";

export type CodeReviewLabelsApplyTo = "pr" | "issue" | "both";

export type ResolvedCodeReviewMergeRiskLabels = {
  low: string;
  medium: string;
  high: string;
};

export type ResolvedCodeReviewLabelsConfig = {
  applyTo: CodeReviewLabelsApplyTo;
  statusOk?: string;
  statusPending?: string;
  mergeRisk?: ResolvedCodeReviewMergeRiskLabels;
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

  if (!resolved.statusOk && !resolved.statusPending && !resolved.mergeRisk) {
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
  // Fail safe: an unknown review event must not be labelled as `status.ok`
  // (a possibly-blocking review would look approved). Both writers set
  // `event`, so this only guards against future regressions.
  const statusLabel = review.event
    ? statusLabelForEvent(review.event, labelsConfig)
    : null;
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
    }
  }
}
