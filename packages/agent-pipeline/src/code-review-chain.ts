import type { Octokit } from "@octokit/rest";
import type { AgentConfig } from "./config.js";
import { dispatchAgentPhaseWorkflow } from "./tools/github.js";

/** Slash flags that request a follow-up /agent code-review after implement or review-fix. */
export function parseChainCodeReviewFromSlashText(text: string): boolean {
  return (
    /--recheck\b/i.test(text) ||
    /\+code-review\b/i.test(text) ||
    /--code-review\b/i.test(text)
  );
}

export function stripChainCodeReviewSlashFlags(text: string): string {
  return text
    .replace(/--recheck\b/gi, "")
    .replace(/\+code-review\b/gi, "")
    .replace(/--code-review\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function shouldChainCodeReviewAfterReviewFix(
  config: AgentConfig,
  options: {
    chainCodeReviewEnv?: string;
    reviewFeedback?: string;
  },
): boolean {
  if (options.chainCodeReviewEnv === "true") {
    return true;
  }
  if (config.review_fix?.follow_up?.code_review === true) {
    return true;
  }
  if (
    options.reviewFeedback &&
    parseChainCodeReviewFromSlashText(options.reviewFeedback)
  ) {
    return true;
  }
  return false;
}

export function shouldChainCodeReviewAfterImplement(
  config: AgentConfig,
  options: {
    chainCodeReviewEnv?: string;
  },
): boolean {
  if (options.chainCodeReviewEnv === "true") {
    return true;
  }
  if (config.implement?.follow_up?.code_review === true) {
    return true;
  }
  return false;
}

async function dispatchFollowUpCodeReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  params: {
    issueNumber: number;
    prNumber: number;
    headRef: string;
    reviewInstructions: string;
  },
): Promise<void> {
  const commentId = process.env.COMMENT_ID;
  if (!commentId) {
    console.warn(
      "Follow-up code-review skipped: COMMENT_ID is missing for workflow dispatch",
    );
    return;
  }

  const reactionTarget = process.env.REACTION_TARGET;

  try {
    await dispatchAgentPhaseWorkflow(octokit, owner, repo, {
      phase: "code-review",
      commentId,
      issueNumber: params.issueNumber,
      prNumber: params.prNumber,
      headRef: params.headRef,
      reviewInstructions: params.reviewInstructions,
      ...(reactionTarget ? { reactionTarget } : {}),
    });
    console.log("Dispatched follow-up code-review workflow");
  } catch (error) {
    console.warn(
      `Could not dispatch follow-up code-review: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function chainCodeReviewAfterReviewFix(
  octokit: Octokit,
  owner: string,
  repo: string,
  config: AgentConfig,
  params: {
    issueNumber: number;
    prNumber: number;
    agentBranch: string;
    reviewFeedback: string;
  },
): Promise<void> {
  if (
    !shouldChainCodeReviewAfterReviewFix(config, {
      chainCodeReviewEnv: process.env.REVIEW_FIX_CHAIN_CODE_REVIEW,
      reviewFeedback: params.reviewFeedback,
    })
  ) {
    return;
  }

  await dispatchFollowUpCodeReview(octokit, owner, repo, {
    issueNumber: params.issueNumber,
    prNumber: params.prNumber,
    headRef: params.agentBranch,
    reviewInstructions:
      "Follow-up code review after review-fix. Verify prior review findings are addressed in the latest commit.",
  });
}

export async function chainCodeReviewAfterImplement(
  octokit: Octokit,
  owner: string,
  repo: string,
  config: AgentConfig,
  params: {
    issueNumber: number;
    prNumber: number;
    agentBranch: string;
  },
): Promise<void> {
  if (
    !shouldChainCodeReviewAfterImplement(config, {
      chainCodeReviewEnv: process.env.IMPLEMENT_CHAIN_CODE_REVIEW,
    })
  ) {
    return;
  }

  await dispatchFollowUpCodeReview(octokit, owner, repo, {
    issueNumber: params.issueNumber,
    prNumber: params.prNumber,
    headRef: params.agentBranch,
    reviewInstructions:
      "Initial code review after implement. Review the new PR diff against repo standards and the issue/plan scope.",
  });
}
