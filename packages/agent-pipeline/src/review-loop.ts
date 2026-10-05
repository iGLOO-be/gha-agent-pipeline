import type { Octokit } from "@octokit/rest";
import type { AgentConfig } from "./config.js";
import type { PhaseDispatchFailureReason } from "./phase-dispatch.js";
import { dispatchPhaseFromEnv } from "./phase-dispatch.js";
import type { ReviewTracker } from "./tools/index.js";
import { listReviewCommentsForReview, postComment } from "./tools/github.js";

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

/**
 * Post a review-loop comment. The `<!-- agent-review-loop -->` marker and the
 * stop/status phrasing live here so every stop path stays consistent and easy
 * to find.
 */
async function postReviewLoopComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  message: string,
): Promise<void> {
  await postComment(
    octokit,
    owner,
    repo,
    prNumber,
    `<!-- agent-review-loop -->\n${message}`,
  );
}

/**
 * Report a follow-up dispatch that GitHub rejected (or that was skipped because
 * `COMMENT_ID` is missing) instead of ending the loop silently. `remedy` is a
 * caller-supplied imperative sentence so each failure path points at the right
 * fix.
 */
async function postUnableToDispatchComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  params: {
    headline: string;
    detail: string;
    manualCommand: string;
    remedy: string;
  },
): Promise<void> {
  await postReviewLoopComment(
    octokit,
    owner,
    repo,
    prNumber,
    `${params.headline}: could not dispatch ${params.detail}. ${params.remedy}. Run \`${params.manualCommand}\` manually as a fallback.`,
  );
}

/**
 * Turn a dispatch failure into the action the reader should take. Both branches
 * are imperative sentences so the posted comment stays grammatical: a missing
 * `COMMENT_ID` is fixed by the run inputs, not by the App token scope.
 */
function remedyForDispatchFailure(reason: PhaseDispatchFailureReason): string {
  return reason === "missing-comment-id"
    ? "Add the missing `COMMENT_ID` to the run environment (check the `agent-phase-run` `comment_id` input and the App token)"
    : "Check the App token `actions: write` scope and the `agent-phase.yml` inputs";
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
  const result = await dispatchPhaseFromEnv(octokit, owner, repo, {
    phase: "code-review",
    issueNumber: params.issueNumber,
    prNumber: params.prNumber,
    headRef: params.agentBranch,
    reviewInstructions:
      "Initial code review after implement (review loop). Review the new PR diff against repo standards and the issue/plan scope.",
    reviewLoopActive: true,
    reviewLoopRound: 0,
  });

  if (!result.dispatched) {
    await postUnableToDispatchComment(octokit, owner, repo, params.prNumber, {
      headline: "Review loop not started",
      detail: "the initial code-review (round 0)",
      manualCommand: "/agent code-review",
      remedy: remedyForDispatchFailure(result.reason),
    });
  }
}

/**
 * `workflow_dispatch` inputs have a per-value size ceiling (64 KB in practice);
 * the review body plus every inline comment easily exceeds it. Truncate before
 * dispatch so a large review cannot make the loop end silently.
 */
export const REVIEW_FIX_FEEDBACK_MAX_CHARS = 60_000;
const REVIEW_FIX_BODY_MAX_CHARS = 20_000;
const REVIEW_FIX_INLINE_COMMENT_MAX_CHARS = 4_000;

function truncateForFeedback(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n…(truncated)`;
}

export async function buildChainedReviewFixFeedback(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  review: ReviewTracker,
): Promise<string> {
  const header: string[] = [
    "Automated review-fix from the review loop after agent code-review.",
    "",
    "Address hard findings from the latest agent review below.",
  ];
  const parts: string[] = [...header];

  if (review.body) {
    parts.push(
      "",
      "### Review body",
      "",
      truncateForFeedback(review.body, REVIEW_FIX_BODY_MAX_CHARS),
    );
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
            truncateForFeedback(
              comment.body ?? "",
              REVIEW_FIX_INLINE_COMMENT_MAX_CHARS,
            ),
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

  const feedback = parts.join("\n");
  if (feedback.length <= REVIEW_FIX_FEEDBACK_MAX_CHARS) {
    return feedback;
  }

  const reviewUrl = review.htmlUrl ? ` (${review.htmlUrl})` : "";
  const note = `\n…(review feedback truncated to fit the workflow_dispatch input limit; read the posted review${reviewUrl} for the full text)`;
  const head = `${header.join("\n")}\n`;
  const budget = REVIEW_FIX_FEEDBACK_MAX_CHARS - head.length - note.length;
  const rest = parts.slice(header.length).join("\n");
  return `${head}${rest.slice(0, Math.max(0, budget))}${note}`;
}

/**
 * Continue the review loop after a code-review run. `code-review.ts` always
 * calls this (even when the review could not be posted), so the
 * `review.posted` guard below is the single source of truth for the
 * "review not posted" stop condition.
 *
 * `round` is a 0-based code-review round index: review-fix is dispatched while
 * `round < max_rounds`, so `max_rounds: 3` allows fixes after rounds 0–2.
 */
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
    await postReviewLoopComment(
      octokit,
      owner,
      repo,
      params.prNumber,
      "Review loop complete: latest code-review finished with no hard findings (`COMMENT`).",
    );
    return;
  }

  if (event !== "REQUEST_CHANGES") {
    return;
  }

  if (round >= maxRounds) {
    await postReviewLoopComment(
      octokit,
      owner,
      repo,
      params.prNumber,
      `Review loop stopped: \`REQUEST_CHANGES\` after code-review round ${round}, but \`review_loop.max_rounds\` is ${maxRounds}. Run \`/agent fix\` manually or adjust config.`,
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

  const result = await dispatchPhaseFromEnv(octokit, owner, repo, {
    phase: "review-fix",
    issueNumber: params.issueNumber,
    prNumber: params.prNumber,
    headRef: params.headRef,
    reviewFeedback,
    reactionTarget: "issue_comment",
    reviewLoopActive: true,
    reviewLoopRound: round,
  });

  if (!result.dispatched) {
    await postUnableToDispatchComment(octokit, owner, repo, params.prNumber, {
      headline: "Review loop stopped",
      detail: `\`review-fix\` after code-review round ${round}`,
      manualCommand: "/agent fix",
      remedy: remedyForDispatchFailure(result.reason),
    });
  }
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
    await postReviewLoopComment(
      octokit,
      owner,
      repo,
      params.prNumber,
      `Review loop stopped: would start code-review round ${nextRound} but \`review_loop.max_rounds\` is ${maxRounds}.`,
    );
    return;
  }

  const result = await dispatchPhaseFromEnv(octokit, owner, repo, {
    phase: "code-review",
    issueNumber: params.issueNumber,
    prNumber: params.prNumber,
    headRef: params.agentBranch,
    reviewInstructions:
      "Follow-up code review after review-fix (review loop). Verify prior review findings are addressed in the latest commit.",
    reviewLoopActive: true,
    reviewLoopRound: nextRound,
  });

  if (!result.dispatched) {
    await postUnableToDispatchComment(octokit, owner, repo, params.prNumber, {
      headline: "Review loop stopped",
      detail: `code-review round ${nextRound}`,
      manualCommand: "/agent code-review",
      remedy: remedyForDispatchFailure(result.reason),
    });
  }
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

  await postReviewLoopComment(
    octokit,
    owner,
    repo,
    prNumber,
    "Review loop stopped: review-fix completed with no code changes. Address findings manually or re-run `/agent fix`.",
  );
}
