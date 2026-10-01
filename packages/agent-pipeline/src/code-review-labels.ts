import type { Octokit } from "@octokit/rest";
import type { AgentConfig } from "./config.js";
import type { ReviewTracker } from "./tools/index.js";
import {
  manageExclusiveLabels,
  parseMergeRiskLevel,
  riskLabelEnsureOptions,
  type PullRequestReviewEvent,
  type RiskLevel,
} from "./tools/github.js";

export type CodeReviewLabelsApplyTo = "pr" | "issue" | "both";

export type ResolvedCodeReviewMergeRiskLabels = {
  enabled: true;
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

  if (!statusOk && !statusPending && !mergeRiskBlock) {
    return null;
  }

  const resolved: ResolvedCodeReviewLabelsConfig = {
    applyTo: labels.apply_to ?? "pr",
    statusOk,
    statusPending,
  };

  if (mergeRiskBlock && mergeRiskEnabled) {
    resolved.mergeRisk = {
      enabled: true,
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

function mergeRiskLabelName(
  level: RiskLevel,
  mergeRisk: ResolvedCodeReviewMergeRiskLabels,
): string {
  return mergeRisk[level];
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
  const event = review.event ?? "COMMENT";
  const reviewBody = review.body ?? "";
  const statusLabel = statusLabelForEvent(event, labelsConfig);
  const statusSiblingLabels = [
    labelsConfig.statusOk,
    labelsConfig.statusPending,
  ].filter((name): name is string => Boolean(name));

  const mergeLevel = labelsConfig.mergeRisk
    ? parseMergeRiskLevel(reviewBody)
    : null;

  for (const targetNumber of targets) {
    if (statusLabel && statusSiblingLabels.length > 0) {
      await manageExclusiveLabels(
        octokit,
        owner,
        repo,
        targetNumber,
        statusSiblingLabels,
        statusLabel,
      );
    } else if (statusLabel) {
      await manageExclusiveLabels(
        octokit,
        owner,
        repo,
        targetNumber,
        [statusLabel],
        statusLabel,
      );
    }

    if (labelsConfig.mergeRisk && mergeLevel) {
      const names = [
        labelsConfig.mergeRisk.low,
        labelsConfig.mergeRisk.medium,
        labelsConfig.mergeRisk.high,
      ];
      const active = mergeRiskLabelName(mergeLevel, labelsConfig.mergeRisk);
      await manageExclusiveLabels(
        octokit,
        owner,
        repo,
        targetNumber,
        names,
        active,
        riskLabelEnsureOptions,
      );
    }
  }
}
