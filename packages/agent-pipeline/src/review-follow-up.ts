import type { AgentConfig } from "./config.js";
import {
  formatReviewThreadsForPrompt,
  isAgentInlineReviewCommentBody,
  isAutomatedReviewAuthor,
  listPullRequestReviewThreads,
  pickLatestAgentCodeReview,
  type PullRequestReviewThread,
} from "./tools/github.js";
import type { Octokit } from "@octokit/rest";

export type CodeReviewFollowUpMode = "agent_only" | "all_authors" | "off";

export function getCodeReviewFollowUpMode(
  config: AgentConfig,
): CodeReviewFollowUpMode {
  return config.code_review?.follow_up?.resolve_threads ?? "agent_only";
}

export type CodeReviewFollowUpContext = {
  mode: CodeReviewFollowUpMode;
  openThreadsMarkdown: string;
  openThreads: PullRequestReviewThread[];
  lastAgentReview: {
    id: number;
    commitSha: string;
    htmlUrl: string;
    submittedAt: string;
  } | null;
  warnings: string[];
};

export function threadMatchesCodeReviewFollowUpMode(
  thread: PullRequestReviewThread,
  mode: Exclude<CodeReviewFollowUpMode, "off">,
): boolean {
  const root = thread.comments[0];
  if (!root) {
    return false;
  }
  if (mode === "all_authors") {
    return true;
  }
  return (
    isAutomatedReviewAuthor(root.authorLogin) ||
    isAgentInlineReviewCommentBody(root.body)
  );
}

export async function buildCodeReviewFollowUpContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  mode: Exclude<CodeReviewFollowUpMode, "off">,
): Promise<CodeReviewFollowUpContext> {
  const warnings: string[] = [];
  let openThreads: PullRequestReviewThread[] = [];

  try {
    const allThreads = await listPullRequestReviewThreads(
      octokit,
      owner,
      repo,
      prNumber,
    );
    openThreads = allThreads.filter(
      (thread) =>
        !thread.isResolved && threadMatchesCodeReviewFollowUpMode(thread, mode),
    );
  } catch (error) {
    warnings.push(
      `Could not list pull request review threads: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let lastAgentReview: CodeReviewFollowUpContext["lastAgentReview"] = null;
  try {
    const reviews = await octokit.paginate(octokit.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    const latest = pickLatestAgentCodeReview(reviews);
    if (latest?.commit_id) {
      lastAgentReview = {
        id: latest.id,
        commitSha: latest.commit_id,
        htmlUrl: latest.html_url,
        submittedAt: latest.submitted_at ?? "",
      };
    }
  } catch (error) {
    warnings.push(
      `Could not list prior agent code reviews: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    mode,
    openThreadsMarkdown: formatReviewThreadsForPrompt(openThreads),
    openThreads,
    lastAgentReview,
    warnings,
  };
}

export function formatFollowUpPromptSection(
  context: CodeReviewFollowUpContext,
): string {
  const parts: string[] = [
    "### Prior review follow-up",
    "",
    `Follow-up mode: \`${context.mode}\`.`,
    "",
    "Open review threads to triage (including **outdated** threads — if the feedback is fixed in the current code, call resolveReviewThreads even when GitHub marked the line outdated):",
    context.openThreadsMarkdown,
  ];

  if (context.lastAgentReview) {
    parts.push(
      "",
      `Last agent code review: id=${context.lastAgentReview.id}, commit \`${context.lastAgentReview.commitSha}\`, submitted ${context.lastAgentReview.submittedAt}, ${context.lastAgentReview.htmlUrl}`,
    );
  } else {
    parts.push("", "(No prior agent code review found on this PR.)");
  }

  if (context.warnings.length > 0) {
    parts.push(
      "",
      "Warnings:",
      ...context.warnings.map((warning) => `- ${warning}`),
    );
  }

  return parts.join("\n");
}
