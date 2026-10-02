import type { Octokit } from "@octokit/rest";
import type { AgentConfig } from "./config.js";
import { dispatchAgentPhaseWorkflow } from "./tools/github.js";

/** Slash flags that request a follow-up /agent code-review after review-fix. */
export function parseReviewFixChainCodeReviewFromText(text: string): boolean {
  return /--recheck\b/i.test(text) || /\+code-review\b/i.test(text);
}

export function stripReviewFixChainFlags(text: string): string {
  return text
    .replace(/--recheck\b/gi, "")
    .replace(/\+code-review\b/gi, "")
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
    parseReviewFixChainCodeReviewFromText(options.reviewFeedback)
  ) {
    return true;
  }
  return false;
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

  const commentId = process.env.COMMENT_ID;
  if (!commentId) {
    console.warn(
      "Follow-up code-review skipped: COMMENT_ID is missing for workflow dispatch",
    );
    return;
  }

  try {
    await dispatchAgentPhaseWorkflow(octokit, owner, repo, {
      phase: "code-review",
      commentId,
      issueNumber: params.issueNumber,
      prNumber: params.prNumber,
      headRef: params.agentBranch,
      reviewInstructions:
        "Follow-up code review after review-fix. Verify prior review findings are addressed in the latest commit.",
    });
    console.log("Dispatched follow-up code-review workflow");
  } catch (error) {
    console.warn(
      `Could not dispatch follow-up code-review: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
