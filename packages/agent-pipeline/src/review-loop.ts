import type { Octokit } from "@octokit/rest";
import type { AgentConfig } from "./config.js";
import type { ReviewTracker } from "./tools/index.js";
import {
  dispatchAgentPhaseWorkflow,
  listReviewCommentsForReview,
  postComment,
} from "./tools/github.js";

export type ReviewLoopDispatchOptions = {
  reviewLoopActive?: boolean;
  reviewLoopRound?: number;
  chainCodeReview?: boolean;
};

export function isReviewLoopEnabled(config: AgentConfig): boolean {
  return config.review_loop?.enabled === true;
}

export function getReviewLoopMaxRounds(config: AgentConfig): number {
  return config.review_loop?.max_rounds ?? 3;
}

export function isReviewLoopActiveFromEnv(): boolean {
  return process.env.REVIEW_LOOP_ACTIVE === "true";
}

export function parseReviewLoopRoundFromEnv(): number {
  const raw = process.env.REVIEW_LOOP_ROUND?.trim();
  if (!raw) {
    return 0;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function requireCommentId(): string | null {
  const commentId = process.env.COMMENT_ID;
  if (!commentId) {
    console.warn(
      "Review loop dispatch skipped: COMMENT_ID is missing for workflow dispatch",
    );
    return null;
  }
  return commentId;
}

export async function dispatchReviewLoopPhase(
  octokit: Octokit,
  owner: string,
  repo: string,
  input: {
    phase: string;
    issueNumber: number;
    prNumber: number;
    headRef: string;
    reviewInstructions?: string;
    reviewFeedback?: string;
    reactionTarget?: string;
    chain?: ReviewLoopDispatchOptions;
  },
): Promise<void> {
  const commentId = requireCommentId();
  if (!commentId) {
    return;
  }

  try {
    await dispatchAgentPhaseWorkflow(octokit, owner, repo, {
      phase: input.phase,
      commentId,
      issueNumber: input.issueNumber,
      prNumber: input.prNumber,
      headRef: input.headRef,
      reviewInstructions: input.reviewInstructions,
      reviewFeedback: input.reviewFeedback,
      reactionTarget: input.reactionTarget ?? process.env.REACTION_TARGET,
      chainCodeReview: input.chain?.chainCodeReview,
      reviewLoopActive: input.chain?.reviewLoopActive,
      reviewLoopRound: input.chain?.reviewLoopRound,
    });
    console.log(`Dispatched review-loop phase: ${input.phase}`);
  } catch (error) {
    console.warn(
      `Could not dispatch review-loop phase ${input.phase}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function startReviewLoopAfterImplement(
  octokit: Octokit,
  owner: string,
  repo: string,
  params: {
    issueNumber: number;
    prNumber: number;
    agentBranch: string;
  },
): Promise<void> {
  await dispatchReviewLoopPhase(octokit, owner, repo, {
    phase: "code-review",
    issueNumber: params.issueNumber,
    prNumber: params.prNumber,
    headRef: params.agentBranch,
    reviewInstructions:
      "Initial code review after implement (review loop). Review the new PR diff against repo standards and the issue/plan scope.",
    chain: {
      reviewLoopActive: true,
      reviewLoopRound: 0,
    },
  });
}

export async function buildChainedReviewFixFeedback(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  review: ReviewTracker,
): Promise<string> {
  const parts: string[] = [
    "Automated review-fix from the review loop after agent code-review.",
    "",
    "Address hard findings from the latest agent review below.",
  ];

  if (review.body) {
    parts.push("", "### Review body", "", review.body);
  }

  if (review.id) {
    try {
      const inline = await listReviewCommentsForReview(
        octokit,
        owner,
        repo,
        prNumber,
        review.id,
      );
      if (inline.length > 0) {
        parts.push("", "### Inline review comments");
        for (const comment of inline) {
          parts.push(
            "",
            `- **${comment.path}:${comment.line ?? "?"}**`,
            comment.body ?? "",
          );
        }
      }
    } catch (error) {
      parts.push(
        "",
        `(Could not load inline review comments: ${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  return parts.join("\n");
}

export async function afterCodeReviewInReviewLoop(
  octokit: Octokit,
  owner: string,
  repo: string,
  config: AgentConfig,
  params: {
    issueNumber: number;
    prNumber: number;
    headRef: string;
    review: ReviewTracker;
  },
): Promise<void> {
  if (!isReviewLoopActiveFromEnv()) {
    return;
  }

  if (!params.review.posted) {
    console.warn("Review loop: skipping follow-up — review was not posted.");
    return;
  }

  const round = parseReviewLoopRoundFromEnv();
  const maxRounds = getReviewLoopMaxRounds(config);
  const event = params.review.event ?? "COMMENT";

  if (event === "COMMENT") {
    await postComment(
      octokit,
      owner,
      repo,
      params.prNumber,
      "<!-- agent-review-loop -->\nReview loop complete: latest code-review finished with no hard findings (`COMMENT`).",
    );
    return;
  }

  if (event !== "REQUEST_CHANGES") {
    return;
  }

  if (round >= maxRounds) {
    await postComment(
      octokit,
      owner,
      repo,
      params.prNumber,
      `<!-- agent-review-loop -->\nReview loop stopped: \`REQUEST_CHANGES\` after code-review round ${round}, but \`review_loop.max_rounds\` is ${maxRounds}. Run \`/agent fix\` manually or adjust config.`,
    );
    return;
  }

  const reviewFeedback = await buildChainedReviewFixFeedback(
    octokit,
    owner,
    repo,
    params.prNumber,
    params.review,
  );

  await dispatchReviewLoopPhase(octokit, owner, repo, {
    phase: "review-fix",
    issueNumber: params.issueNumber,
    prNumber: params.prNumber,
    headRef: params.headRef,
    reviewFeedback,
    reactionTarget: "issue_comment",
    chain: {
      reviewLoopActive: true,
      reviewLoopRound: round,
      chainCodeReview: true,
    },
  });
}

export async function afterReviewFixPushInReviewLoop(
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
  if (!isReviewLoopActiveFromEnv()) {
    return;
  }

  const nextRound = parseReviewLoopRoundFromEnv() + 1;
  const maxRounds = getReviewLoopMaxRounds(config);

  if (nextRound > maxRounds) {
    await postComment(
      octokit,
      owner,
      repo,
      params.prNumber,
      `<!-- agent-review-loop -->\nReview loop stopped: would start code-review round ${nextRound} but \`review_loop.max_rounds\` is ${maxRounds}.`,
    );
    return;
  }

  await dispatchReviewLoopPhase(octokit, owner, repo, {
    phase: "code-review",
    issueNumber: params.issueNumber,
    prNumber: params.prNumber,
    headRef: params.agentBranch,
    reviewInstructions:
      "Follow-up code review after review-fix (review loop). Verify prior review findings are addressed in the latest commit.",
    chain: {
      reviewLoopActive: true,
      reviewLoopRound: nextRound,
    },
  });
}

export async function onReviewFixNoChangesInReviewLoop(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  if (!isReviewLoopActiveFromEnv()) {
    return;
  }

  await postComment(
    octokit,
    owner,
    repo,
    prNumber,
    "<!-- agent-review-loop -->\nReview loop stopped: review-fix completed with no code changes. Address findings manually or re-run `/agent fix`.",
  );
}
