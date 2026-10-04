import type { Octokit } from "@octokit/rest";
import { dispatchAgentPhaseWorkflow } from "./tools/github.js";

export type DispatchPhaseFromEnvInput = {
  phase: string;
  issueNumber: number;
  prNumber: number;
  headRef: string;
  reviewInstructions?: string;
  reviewFeedback?: string;
  reactionTarget?: string;
  chainCodeReview?: boolean;
  reviewLoopActive?: boolean;
  reviewLoopRound?: number;
};

/**
 * Single dispatch skeleton for follow-up phases (chained code-review, review loop).
 *
 * Reads `COMMENT_ID` from the environment (the slash command that started the
 * chain) and never throws: a failed dispatch must not fail the current phase,
 * it is only reported as a warning. Returns whether the dispatch was issued.
 */
export async function dispatchPhaseFromEnv(
  octokit: Octokit,
  owner: string,
  repo: string,
  input: DispatchPhaseFromEnvInput,
): Promise<boolean> {
  const commentId = process.env.COMMENT_ID;
  if (!commentId) {
    console.warn(
      `Follow-up ${input.phase} skipped: COMMENT_ID is missing for workflow dispatch`,
    );
    return false;
  }

  const reactionTarget = input.reactionTarget ?? process.env.REACTION_TARGET;

  try {
    await dispatchAgentPhaseWorkflow(octokit, owner, repo, {
      phase: input.phase,
      commentId,
      issueNumber: input.issueNumber,
      prNumber: input.prNumber,
      headRef: input.headRef,
      reviewInstructions: input.reviewInstructions,
      reviewFeedback: input.reviewFeedback,
      ...(reactionTarget ? { reactionTarget } : {}),
      chainCodeReview: input.chainCodeReview,
      reviewLoopActive: input.reviewLoopActive,
      reviewLoopRound: input.reviewLoopRound,
    });
    console.log(`Dispatched follow-up ${input.phase} workflow`);
    return true;
  } catch (error) {
    console.warn(
      `Could not dispatch follow-up ${input.phase}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
