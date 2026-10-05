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
  reviewLoopActive?: boolean;
  reviewLoopRound?: number;
};

/**
 * Outcome of a follow-up dispatch. `reason` tells callers why nothing was
 * dispatched so they can post an accurate remedy (a missing `COMMENT_ID` is not
 * fixed by the same checklist as a GitHub-rejected workflow dispatch).
 */
export type PhaseDispatchResult =
  | { dispatched: true }
  | { dispatched: false; reason: PhaseDispatchFailureReason };

export type PhaseDispatchFailureReason =
  "missing-comment-id" | "dispatch-rejected";

/**
 * Single dispatch skeleton for follow-up phases (chained code-review, review loop).
 *
 * Reads `COMMENT_ID` from the environment (the slash command that started the
 * chain) and never throws: a failed dispatch must not fail the current phase,
 * it is only reported as a warning. Returns whether the dispatch was issued and,
 * when it was not, the reason.
 */
export async function dispatchPhaseFromEnv(
  octokit: Octokit,
  owner: string,
  repo: string,
  input: DispatchPhaseFromEnvInput,
): Promise<PhaseDispatchResult> {
  const commentId = process.env.COMMENT_ID;
  if (!commentId) {
    console.warn(
      `Follow-up ${input.phase} skipped: COMMENT_ID is missing for workflow dispatch`,
    );
    return { dispatched: false, reason: "missing-comment-id" };
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
      reviewLoopActive: input.reviewLoopActive,
      reviewLoopRound: input.reviewLoopRound,
    });
    console.log(`Dispatched follow-up ${input.phase} workflow`);
    return { dispatched: true };
  } catch (error) {
    console.warn(
      `Could not dispatch follow-up ${input.phase}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { dispatched: false, reason: "dispatch-rejected" };
  }
}
