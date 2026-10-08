import type { Octokit } from "@octokit/rest";
import type { AgentConfig } from "./config.js";
import { dispatchPhaseFromEnv } from "./phase-dispatch.js";

/**
 * Slash flags (`--recheck` / `+code-review` / `--code-review`) are detected and
 * stripped in the workflow (`dispatch.yml`), which sets `chain_code_review`.
 * The runtime only reads the env + config signals, so review-fix here must not
 * re-parse `REVIEW_FEEDBACK` for slash flags (review context is loaded at runtime).
 */
export function shouldChainCodeReviewAfterReviewFix(
  config: AgentConfig,
  options: {
    chainCodeReviewEnv?: string;
  },
): boolean {
  if (options.chainCodeReviewEnv === "true") {
    return true;
  }
  if (config.review_fix?.follow_up?.code_review === true) {
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
  await dispatchPhaseFromEnv(octokit, owner, repo, {
    phase: "code-review",
    issueNumber: params.issueNumber,
    prNumber: params.prNumber,
    headRef: params.headRef,
    reviewInstructions: params.reviewInstructions,
  });
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
  },
): Promise<void> {
  if (
    !shouldChainCodeReviewAfterReviewFix(config, {
      chainCodeReviewEnv: process.env.REVIEW_FIX_CHAIN_CODE_REVIEW,
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
