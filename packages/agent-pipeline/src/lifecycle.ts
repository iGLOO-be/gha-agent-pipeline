import type { Octokit } from "@octokit/rest";
import type { AgentPhase } from "./config.js";
import {
  addLabelToIssue,
  addReactionToIssueComment,
  addReactionToPullRequestReview,
  AGENT_COMMENT_MARKERS,
  AGENT_WORKING_LABEL,
  buildRunUrl,
  clearAgentResumeLabels,
  ensureLabel,
  markerFor,
  postComment,
  removeLabelFromIssue,
  type ReactionContent,
} from "./tools/github.js";

const PHASE_LABELS: Record<AgentPhase, string> = {
  plan: "Plan",
  implement: "Implement",
  yolo: "Yolo",
  "ci-fix": "CI Fix",
  "review-fix": "Review Fix",
};

export type StartupTarget =
  { type: "issue"; number: number } | { type: "pr"; number: number };

export function buildStartupComment(
  phase: AgentPhase,
  targetType: "issue" | "pr",
  targetNumber: number,
): string {
  const runUrl = buildRunUrl();
  const phaseLabel = PHASE_LABELS[phase] ?? phase;
  const targetLabel =
    targetType === "pr" ? `PR #${targetNumber}` : `issue #${targetNumber}`;
  const runLink = runUrl
    ? `[Suivre l'exécution](${runUrl})`
    : "(run URL unavailable)";
  return `${markerFor(AGENT_COMMENT_MARKERS.startup)}\n🚀 **Agent ${phaseLabel}** démarré pour ${targetLabel} — ${runLink}`;
}

export function resolveStartupTarget(
  phase: AgentPhase,
  issueNumber: number,
  prNumber?: number,
): StartupTarget {
  const effectivePr =
    prNumber != null && Number.isFinite(prNumber) ? prNumber : undefined;
  if (effectivePr != null) {
    return { type: "pr", number: effectivePr };
  }
  return { type: "issue", number: issueNumber };
}

export async function manageAgentWorkingLabel(
  octokit: Octokit,
  owner: string,
  repo: string,
  action: "add" | "remove",
  issueNumber: number,
  prNumber?: number,
): Promise<void> {
  const targets = new Set<number>();
  targets.add(issueNumber);
  if (prNumber != null && prNumber !== issueNumber) {
    targets.add(prNumber);
  }

  if (action === "add") {
    await ensureLabel(octokit, owner, repo, AGENT_WORKING_LABEL, {
      color: "f9d0c4",
      description: "Agent job in progress.",
    });
  }

  for (const targetNumber of targets) {
    if (action === "add") {
      try {
        await addLabelToIssue(
          octokit,
          owner,
          repo,
          targetNumber,
          AGENT_WORKING_LABEL,
        );
        console.log(`Added ${AGENT_WORKING_LABEL} to #${targetNumber}`);
      } catch (error) {
        console.warn(
          `Failed to add ${AGENT_WORKING_LABEL} to #${targetNumber}:`,
          error,
        );
      }
    } else {
      try {
        await removeLabelFromIssue(
          octokit,
          owner,
          repo,
          targetNumber,
          AGENT_WORKING_LABEL,
        );
        console.log(`Removed ${AGENT_WORKING_LABEL} from #${targetNumber}`);
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 404) {
          console.log(
            `${AGENT_WORKING_LABEL} was not present on #${targetNumber}`,
          );
        } else {
          console.warn(
            `Failed to remove ${AGENT_WORKING_LABEL} from #${targetNumber}:`,
            error,
          );
        }
      }
    }
  }
}

export type ReactionOutcome = "success" | "failure";

export async function reactToAgentTrigger(
  octokit: Octokit,
  owner: string,
  repo: string,
  outcome: ReactionOutcome,
): Promise<void> {
  const commentIdRaw = process.env.COMMENT_ID;
  if (!commentIdRaw) {
    return;
  }
  const commentId = Number(commentIdRaw);
  if (!Number.isFinite(commentId)) {
    console.warn(`Invalid COMMENT_ID: ${commentIdRaw}`);
    return;
  }

  const reactionTarget = process.env.REACTION_TARGET || "issue_comment";
  const successReaction = (process.env.SUCCESS_REACTION ||
    "+1") as ReactionContent;
  const content: ReactionContent =
    outcome === "success" ? successReaction : "confused";

  if (reactionTarget === "issue_comment") {
    await addReactionToIssueComment(octokit, owner, repo, commentId, content);
    return;
  }

  if (reactionTarget === "pull_request_review") {
    const prNumberRaw = process.env.PR_NUMBER;
    const prNumber = prNumberRaw ? Number(prNumberRaw) : NaN;
    if (!Number.isFinite(prNumber)) {
      console.warn("PR_NUMBER is required to react to a pull request review");
      return;
    }
    await addReactionToPullRequestReview(
      octokit,
      owner,
      repo,
      prNumber,
      commentId,
      content,
    );
    return;
  }

  console.warn(`Unknown reaction_target: ${reactionTarget}`);
}

export type RunAgentPhaseOptions = {
  phase: AgentPhase;
  octokit: Octokit;
  owner: string;
  repo: string;
  issueNumber: number;
  prNumber?: number;
  main: () => Promise<void>;
};

export async function runAgentPhase(
  options: RunAgentPhaseOptions,
): Promise<void> {
  const { phase, octokit, owner, repo, issueNumber, prNumber, main } = options;
  const startupTarget = resolveStartupTarget(phase, issueNumber, prNumber);

  try {
    await manageAgentWorkingLabel(
      octokit,
      owner,
      repo,
      "add",
      issueNumber,
      prNumber,
    );

    await postComment(
      octokit,
      owner,
      repo,
      startupTarget.number,
      buildStartupComment(phase, startupTarget.type, startupTarget.number),
    );

    await clearAgentResumeLabels(octokit, owner, repo, {
      issueNumber,
      prNumber,
    });

    await main();

    await reactToAgentTrigger(octokit, owner, repo, "success");
  } catch (error) {
    await reactToAgentTrigger(octokit, owner, repo, "failure");
    throw error;
  } finally {
    await manageAgentWorkingLabel(
      octokit,
      owner,
      repo,
      "remove",
      issueNumber,
      prNumber,
    );
  }
}
