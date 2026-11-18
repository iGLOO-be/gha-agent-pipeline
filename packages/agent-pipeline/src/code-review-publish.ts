import type { Octokit } from "@octokit/rest";
import { parseReviewBodyFromAgentOutput } from "./review-prompt.js";
import type { ReviewTracker } from "./tools/index.js";
import {
  createPullRequestReview,
  markPublishedCodeReview,
  type PullRequestReviewEvent,
} from "./tools/github.js";

function parseReviewFromOutput(outputText: string): {
  event: PullRequestReviewEvent;
  body: string;
} | null {
  const body = parseReviewBodyFromAgentOutput(outputText);
  if (!body) {
    return null;
  }
  return {
    event: "COMMENT",
    body,
  };
}

export async function ensureReviewPosted(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  outputText: string,
  review: ReviewTracker,
) {
  if (review.posted) {
    return;
  }

  const parsed = parseReviewFromOutput(outputText);
  if (!parsed) {
    console.warn(
      "Agent session ended without submitReview and no ## Standards section found in output.",
    );
    return;
  }

  const markedBody = markPublishedCodeReview(parsed.body);
  const posted = await createPullRequestReview(octokit, owner, repo, prNumber, {
    event: parsed.event,
    body: markedBody,
  });
  review.posted = true;
  review.id = posted.id;
  review.body = markedBody;
  review.htmlUrl = posted.html_url;
  review.event = parsed.event;
  console.log("Posted code review from agent output fallback.");
}
