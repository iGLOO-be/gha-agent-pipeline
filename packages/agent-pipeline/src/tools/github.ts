import { Octokit } from "@octokit/rest";

export function createOctokit(token: string): Octokit {
  return new Octokit({ auth: token });
}

export function buildRunUrl(): string | null {
  const serverUrl = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!serverUrl || !repository || !runId) {
    return null;
  }
  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}

/** Canonical HTML comment markers the agent runner posts on GitHub comments. */
export const AGENT_COMMENT_MARKERS = {
  startup: "agent-startup",
  prOpened: "agent-pr-opened",
  plan: "agent-plan",
  implement: "agent-implement",
  planFailed: "agent-plan-failed",
  implementFailed: "agent-implement-failed",
  yoloFailed: "agent-yolo-failed",
  reviewFixFailed: "agent-review-fix-failed",
  ciFixFailed: "agent-ci-fix-failed",
  yolo: "agent-yolo",
  reviewFix: "agent-review-fix",
  ciFix: "agent-ci-fix",
  ciSuccess: "agent-ci-success",
  blocked: "agent-blocked",
  ask: "agent-ask",
  askFailed: "agent-ask-failed",
  codeReview: "agent-code-review",
  codeReviewFailed: "agent-code-review-failed",
  reviewFixReply: "agent-review-fix-reply",
} as const;

/** Lifecycle label applied while an agent phase is running. */
export const AGENT_WORKING_LABEL = "agent-working";

export type AgentCommentMarker =
  (typeof AGENT_COMMENT_MARKERS)[keyof typeof AGENT_COMMENT_MARKERS];

/** Render a marker as a self-contained HTML comment, e.g. `<!-- agent-plan -->`. */
export function markerFor(marker: AgentCommentMarker): string {
  return `<!-- ${marker} -->`;
}

/** Prepend a marker as the first line of a comment body. */
export function prependAgentMarker(
  body: string,
  marker: AgentCommentMarker,
): string {
  return `${markerFor(marker)}\n${body}`;
}

export async function readIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
) {
  const { data } = await octokit.issues.get({
    owner,
    repo,
    issue_number: issueNumber,
  });
  return data;
}

const MAX_AGENT_COMMENT_BODY_CHARS = 4_000;

/** Keep tool/prompt payloads bounded (plan comments can be very large). */
export function truncateCommentBodyForAgent(body: string): string {
  if (body.length <= MAX_AGENT_COMMENT_BODY_CHARS) {
    return body;
  }
  const omitted = body.length - MAX_AGENT_COMMENT_BODY_CHARS;
  return `${body.slice(0, MAX_AGENT_COMMENT_BODY_CHARS)}\n\n…(truncated ${omitted} characters for agent context)`;
}

export async function readComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
) {
  const { data } = await octokit.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  return data;
}

export async function postComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
) {
  const { data } = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
  return data;
}

export async function updateComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  body: string,
) {
  const { data } = await octokit.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body,
  });
  return data;
}

function latestPlanComment(
  comments: Awaited<ReturnType<typeof readComments>>,
): (typeof comments)[number] | undefined {
  const marker = markerFor(AGENT_COMMENT_MARKERS.plan);
  const plans = comments.filter(
    (comment) =>
      comment.body?.includes("## Agent Plan") || comment.body?.includes(marker),
  );
  return plans.at(-1);
}

export function findPlanComment(
  comments: Awaited<ReturnType<typeof readComments>>,
): string | null {
  return latestPlanComment(comments)?.body ?? null;
}

export function findPlanCommentUrl(
  comments: Awaited<ReturnType<typeof readComments>>,
): string | null {
  return latestPlanComment(comments)?.html_url ?? null;
}

export function formatCommentsForPrompt(
  comments: Awaited<ReturnType<typeof readComments>>,
): string {
  if (comments.length === 0) {
    return "(no comments yet)";
  }

  return comments
    .map((comment) => {
      const author = comment.user?.login ?? "unknown";
      const body = (comment.body ?? "").trim();
      return `--- Comment by ${author} ---\n${body}`;
    })
    .join("\n\n");
}

export function unescapeToolString(value: string): string {
  return value.replace(/\\(n|t|r|"|\\)/g, (_, char: string) => {
    switch (char) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case '"':
        return '"';
      case "\\":
        return "\\";
      default:
        return `\\${char}`;
    }
  });
}

export function normalizeAgentPlanBody(body: string): string {
  const normalizedHeading = body.replace(
    /^##\s*(?:Revised\s+)?Agent Plan\s*$/m,
    "## Agent Plan",
  );

  // ClineCore tool args sometimes arrive with JSON-style escapes as literal text.
  if (normalizedHeading.includes("\\n")) {
    return unescapeToolString(normalizedHeading);
  }

  return normalizedHeading;
}

export function extractAgentPlan(text: string): string | null {
  const match = text.match(/##\s*(?:Revised\s+)?Agent Plan[\s\S]*/);
  if (!match) {
    return null;
  }
  return normalizeAgentPlanBody(match[0].trim());
}

const AGENT_ANSWER_HEADING = "## Agent answer";

export function normalizeAgentAnswerBody(body: string): string {
  const normalizedHeading = body.replace(
    /^##\s*Agent answer\s*$/im,
    AGENT_ANSWER_HEADING,
  );

  if (normalizedHeading.includes("\\n")) {
    return unescapeToolString(normalizedHeading);
  }

  return normalizedHeading.startsWith(AGENT_ANSWER_HEADING)
    ? normalizedHeading
    : `${AGENT_ANSWER_HEADING}\n\n${normalizedHeading}`;
}

/** Minimum assistant text length to accept as a fallback when submitAnswer was not called. */
const MIN_ANSWER_FALLBACK_CHARS = 40;

export function extractAgentAnswer(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const sectionMatch = trimmed.match(/##\s*Agent answer\b[\s\S]*/i);
  if (sectionMatch) {
    const section = sectionMatch[0].trim();
    const withoutTrailingReport = section.replace(
      /\n##\s+Agent phase report[\s\S]*$/i,
      "",
    );
    return normalizeAgentAnswerBody(withoutTrailingReport.trim());
  }

  if (trimmed.length >= MIN_ANSWER_FALLBACK_CHARS) {
    return normalizeAgentAnswerBody(trimmed);
  }

  return null;
}

export async function findPullRequestForRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  headBranch?: string,
) {
  const pulls = await octokit.pulls.list({
    owner,
    repo,
    state: "open",
    per_page: 30,
    ...(headBranch ? { head: `${owner}:${headBranch}` } : {}),
  });

  return pulls.data.find((pr) => pr.head.sha === headSha) ?? null;
}

export type CheckRunSummary = {
  id: number;
  name: string;
  status: string | null;
  conclusion: string | null;
  detailsUrl: string | null;
  outputTitle: string | null;
  outputSummary: string | null;
  outputText: string | null;
};

export async function readCheckRuns(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<CheckRunSummary[]> {
  const { data } = await octokit.checks.listForRef({
    owner,
    repo,
    ref,
    filter: "all",
    per_page: 100,
  });

  return data.check_runs.map((run) => ({
    id: run.id,
    name: run.name ?? "unknown",
    status: run.status,
    conclusion: run.conclusion,
    detailsUrl: run.details_url ?? null,
    outputTitle: run.output?.title ?? null,
    outputSummary: run.output?.summary ?? null,
    outputText: run.output?.text ?? null,
  }));
}

const MAX_LOG_CHARS = 80_000;

export async function readCheckLogs(
  octokit: Octokit,
  owner: string,
  repo: string,
  checkRunId: number,
): Promise<string> {
  const { data: run } = await octokit.checks.get({
    owner,
    repo,
    check_run_id: checkRunId,
  });

  const chunks: string[] = [];
  if (run.output?.title) {
    chunks.push(`title: ${run.output.title}`);
  }
  if (run.output?.summary) {
    chunks.push(`summary:\n${run.output.summary}`);
  }
  if (run.output?.text) {
    chunks.push(`text:\n${run.output.text}`);
  }

  const externalId = run.external_id;
  if (externalId) {
    try {
      const jobId = Number.parseInt(externalId, 10);
      if (Number.isFinite(jobId)) {
        const { data: job } = await octokit.actions.getJobForWorkflowRun({
          owner,
          repo,
          job_id: jobId,
        });
        const logs = await octokit.actions.downloadJobLogsForWorkflowRun({
          owner,
          repo,
          job_id: jobId,
        });
        const payload = logs.data as string | Blob;
        const logText =
          typeof payload === "string" ? payload : await payload.text();
        chunks.push(
          `job: ${job.name} (workflow_run ${job.run_id})\nlogs:\n${logText}`,
        );
      }
    } catch {
      // Fall back to check run output only.
    }
  }

  const combined = chunks.join("\n\n").trim();
  if (!combined) {
    return "(no log output available for this check run)";
  }
  if (combined.length <= MAX_LOG_CHARS) {
    return combined;
  }
  return `${combined.slice(0, MAX_LOG_CHARS)}\n\n…(truncated)`;
}

export function failedCheckRuns(runs: CheckRunSummary[]): CheckRunSummary[] {
  return runs.filter(
    (run) => run.conclusion === "failure" || run.conclusion === "timed_out",
  );
}

export function hasFailedCheckRuns(runs: CheckRunSummary[]): boolean {
  return failedCheckRuns(runs).length > 0;
}

export function formatFailedChecksForPrompt(runs: CheckRunSummary[]): string {
  const failed = failedCheckRuns(runs);
  if (failed.length === 0) {
    return "(no failed check runs on this SHA)";
  }

  return failed
    .map((run) => {
      const parts = [
        `- ${run.name} (id=${run.id}, conclusion=${run.conclusion})`,
      ];
      if (run.outputSummary) {
        parts.push(`  summary: ${run.outputSummary}`);
      }
      if (run.outputText) {
        parts.push(`  text: ${run.outputText}`);
      }
      return parts.join("\n");
    })
    .join("\n");
}

export async function readPullRequestComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
) {
  const { data } = await octokit.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  return data;
}

export function formatPrCommentsForPrompt(
  comments: Awaited<ReturnType<typeof readPullRequestComments>>,
): string {
  if (comments.length === 0) {
    return "(no PR comments yet)";
  }

  return comments
    .map((comment) => {
      const author = comment.user?.login ?? "unknown";
      const body = (comment.body ?? "").trim();
      return `--- Comment by ${author} ---\n${body}`;
    })
    .join("\n\n");
}

export type PullRequestReviewCommentForPrompt = {
  id: number;
  path: string;
  line?: number | null;
  body: string | null;
  user?: { login?: string | null } | null;
  diff_hunk?: string | null;
};

export function parseReviewCommentIdsFromText(text: string): number[] {
  const ids = new Set<number>();
  const patterns = [/#discussion_r(\d+)/gi, /\/pulls\/\d+\/comments\/(\d+)/gi];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const id = Number(match[1]);
      if (Number.isFinite(id)) {
        ids.add(id);
      }
    }
  }
  return [...ids];
}

/** True when `/agent fix` was sent without extra text or explicit #discussion_r links. */
export function isBareReviewFixFeedback(text: string): boolean {
  if (/#discussion_r\d/i.test(text)) {
    return false;
  }
  const stripped = text.replace(/\/agent\s+fix/gi, "").trim();
  return stripped.length === 0;
}

export type PullRequestReviewForPrompt = {
  id: number;
  body?: string | null;
  commit_id?: string | null;
  submitted_at?: string | null;
  html_url: string;
  user?: { login?: string | null } | null;
};

export function pickLatestAgentCodeReview<T extends PullRequestReviewForPrompt>(
  reviews: T[],
): T | undefined {
  const marker = markerFor(AGENT_COMMENT_MARKERS.codeReview);
  return reviews
    .filter((review) => (review.body ?? "").includes(marker))
    .filter((review) => review.commit_id != null)
    .sort(
      (a, b) =>
        new Date(b.submitted_at ?? 0).getTime() -
        new Date(a.submitted_at ?? 0).getTime(),
    )[0];
}

export function formatBareReviewFixReviewBodiesSection(
  reviews: PullRequestReviewForPrompt[],
): string {
  if (reviews.length === 0) {
    return "(no pull request reviews)";
  }
  const sorted = [...reviews].sort(
    (a, b) =>
      new Date(b.submitted_at ?? 0).getTime() -
      new Date(a.submitted_at ?? 0).getTime(),
  );
  const agentReview = pickLatestAgentCodeReview(sorted);
  const fallback = sorted.find(
    (review) => (review.body ?? "").trim().length > 0,
  );
  const pick = agentReview ?? fallback;
  if (!pick) {
    return "(no pull request review bodies)";
  }
  const author = pick.user?.login ?? "unknown";
  const body = truncateCommentBodyForAgent((pick.body ?? "").trim());
  return `--- PR review id=${pick.id} (${author}, ${pick.submitted_at ?? "unknown date"}) ---\n${body}\n\nReview URL: ${pick.html_url}`;
}

export function isAutomatedReviewAuthor(
  login: string | undefined | null,
): boolean {
  if (!login) {
    return true;
  }
  const lower = login.toLowerCase();
  if (lower === "github-actions[bot]") {
    return true;
  }
  return lower.endsWith("[bot]");
}

const AGENT_INLINE_REVIEW_COMMENT_TAG = /^_[^|\n]+_\s*\|\s*_[^|\n]+_\s*\|\s*_/m;

/** Matches agent code-review inline comments (_Category_ | _Severity_ | _Effort_). */
export function isAgentInlineReviewCommentBody(body: string): boolean {
  return AGENT_INLINE_REVIEW_COMMENT_TAG.test(body.trim());
}

export function formatReviewCommentsForPrompt(
  comments: PullRequestReviewCommentForPrompt[],
  options?: { maxDiffHunkChars?: number },
): string {
  if (comments.length === 0) {
    return "(no review line comments)";
  }
  const maxHunk = options?.maxDiffHunkChars ?? 400;
  return comments
    .map((comment) => {
      const author = comment.user?.login ?? "unknown";
      const line = comment.line != null ? ` line ${comment.line}` : "";
      const body = (comment.body ?? "").trim();
      const hunk = comment.diff_hunk
        ? `\nDiff context:\n${comment.diff_hunk.slice(0, maxHunk)}${
            comment.diff_hunk.length > maxHunk ? "…" : ""
          }`
        : "";
      return `--- Review comment id=${comment.id} on ${comment.path}${line} (${author}) ---\n${body}${hunk}`;
    })
    .join("\n\n");
}

export async function readPullRequestReviewComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
) {
  return octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
}

export async function getPullRequestReviewComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
) {
  const { data } = await octokit.pulls.getReviewComment({
    owner,
    repo,
    comment_id: commentId,
  });
  return data;
}

export async function createReplyForReviewComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  commentId: number,
  body: string,
) {
  const markedBody = prependAgentMarker(
    body,
    AGENT_COMMENT_MARKERS.reviewFixReply,
  );
  const { data } = await octokit.pulls.createReplyForReviewComment({
    owner,
    repo,
    pull_number: prNumber,
    comment_id: commentId,
    body: markedBody,
  });
  return data;
}

export type DispatchAgentPhaseWorkflowInput = {
  phase: string;
  commentId: string | number;
  issueNumber: number;
  prNumber: number;
  headRef: string;
  workflowFile?: string;
  ref?: string;
  reviewFeedback?: string;
  reactionTarget?: string;
  reviewInstructions?: string;
  chainCodeReview?: boolean;
  reviewLoopActive?: boolean;
  reviewLoopRound?: number;
};

/** Dispatch the consumer `agent-phase.yml` workflow (requires `actions: write` on the token). */
export async function dispatchAgentPhaseWorkflow(
  octokit: Octokit,
  owner: string,
  repo: string,
  input: DispatchAgentPhaseWorkflowInput,
): Promise<void> {
  const workflowFile = input.workflowFile ?? "agent-phase.yml";

  let ref = input.ref;
  if (!ref) {
    const { data: repoMeta } = await octokit.repos.get({ owner, repo });
    ref = repoMeta.default_branch;
  }

  const workflowPath = workflowFile.includes("/")
    ? workflowFile
    : `.github/workflows/${workflowFile}`;

  const inputs: Record<string, string> = {
    phase: input.phase,
    comment_id: String(input.commentId),
    issue_number: String(input.issueNumber),
    pr_number: String(input.prNumber),
    head_ref: input.headRef,
  };

  if (input.reviewFeedback != null && input.reviewFeedback !== "") {
    inputs.review_feedback = input.reviewFeedback;
  }
  if (input.reactionTarget) {
    inputs.reaction_target = input.reactionTarget;
  }
  if (input.reviewInstructions != null && input.reviewInstructions !== "") {
    inputs.review_instructions = input.reviewInstructions;
  }
  if (input.chainCodeReview) {
    inputs.chain_code_review = "true";
  }
  if (input.reviewLoopActive) {
    inputs.review_loop_active = "true";
  }
  if (input.reviewLoopRound !== undefined) {
    inputs.review_loop_round = String(input.reviewLoopRound);
  }

  await octokit.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: workflowPath,
    ref,
    inputs,
  });
}

export async function listReviewCommentsForReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  reviewId: number,
) {
  const { data } = await octokit.pulls.listCommentsForReview({
    owner,
    repo,
    pull_number: prNumber,
    review_id: reviewId,
  });
  return data;
}

export async function buildReviewFixReviewCommentContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  options: {
    reviewFeedback: string;
    reactionTarget?: string;
    triggerCommentId?: number;
  },
): Promise<{
  referencedSection: string;
  reviewBodiesSection: string;
  lineCommentsSection: string;
  bareFixTrigger: boolean;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const bareFixTrigger = isBareReviewFixFeedback(options.reviewFeedback);
  const referencedIds = parseReviewCommentIdsFromText(options.reviewFeedback);
  const referencedComments: PullRequestReviewCommentForPrompt[] = [];

  for (const id of referencedIds) {
    try {
      referencedComments.push(
        await getPullRequestReviewComment(octokit, owner, repo, id),
      );
    } catch {
      warnings.push(
        `Could not load review comment id=${id} from the API (it may have been deleted).`,
      );
    }
  }

  if (
    options.reactionTarget === "pull_request_review" &&
    options.triggerCommentId != null
  ) {
    try {
      const fromReview = await listReviewCommentsForReview(
        octokit,
        owner,
        repo,
        prNumber,
        options.triggerCommentId,
      );
      for (const comment of fromReview) {
        if (!referencedComments.some((c) => c.id === comment.id)) {
          referencedComments.push(comment);
        }
      }
    } catch {
      warnings.push(
        `Could not load line comments for review id=${options.triggerCommentId}.`,
      );
    }
  }

  let allLineComments: PullRequestReviewCommentForPrompt[] = [];
  try {
    allLineComments = await readPullRequestReviewComments(
      octokit,
      owner,
      repo,
      prNumber,
    );
  } catch {
    warnings.push("Could not list pull request review comments for this PR.");
  }

  const humanLineComments = allLineComments.filter(
    (comment) => !isAutomatedReviewAuthor(comment.user?.login),
  );

  const lineCommentsForSection = bareFixTrigger
    ? allLineComments.slice(0, 100)
    : humanLineComments.slice(0, 100);

  let reviewBodiesSection =
    "(not loaded — fix trigger included explicit feedback)";
  if (bareFixTrigger) {
    try {
      const reviews = await octokit.paginate(octokit.pulls.listReviews, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });
      reviewBodiesSection = formatBareReviewFixReviewBodiesSection(reviews);
    } catch {
      warnings.push("Could not list pull request reviews for this PR.");
      reviewBodiesSection = "(could not load pull request reviews)";
    }
  }

  return {
    referencedSection: formatReviewCommentsForPrompt(referencedComments),
    reviewBodiesSection,
    lineCommentsSection: formatReviewCommentsForPrompt(lineCommentsForSection),
    bareFixTrigger,
    warnings,
  };
}

export async function getPullRequestMergeState(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
) {
  const { data: pr } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  let behindBy: number | null = null;
  try {
    const { data: compare } = await octokit.repos.compareCommits({
      owner,
      repo,
      base: pr.base.label,
      head: pr.head.label,
    });
    behindBy = compare.behind_by ?? null;
  } catch {
    // Compare may fail for cross-fork PRs; ignore and leave behindBy as null.
  }

  return {
    mergeable: pr.mergeable,
    mergeable_state: pr.mergeable_state,
    behind_by: behindBy,
    conflicts: pr.mergeable_state === "dirty",
  };
}

export type PullRequestMergeState = Awaited<
  ReturnType<typeof getPullRequestMergeState>
>;

export class PullRequestStillConflictingError extends Error {
  readonly prNumber: number;
  readonly mergeable_state: string;
  readonly behind_by: number | null;
  readonly state: PullRequestMergeState;

  constructor(prNumber: number, state: PullRequestMergeState) {
    const behindSuffix =
      state.behind_by != null ? `, behind_by: ${state.behind_by}` : "";
    super(
      `PR #${prNumber} still has merge conflicts (mergeable_state: ${state.mergeable_state}${behindSuffix}).`,
    );
    this.name = "PullRequestStillConflictingError";
    this.prNumber = prNumber;
    this.mergeable_state = state.mergeable_state;
    this.behind_by = state.behind_by;
    this.state = state;
  }
}

function isPullRequestMergeStateReady(
  state: Awaited<ReturnType<typeof getPullRequestMergeState>>,
): boolean {
  return state.mergeable === true || state.mergeable_state === "clean";
}

/**
 * GitHub often reports `mergeable_state: dirty` briefly after a push while it
 * recomputes mergeability. Poll until clean or until we are confident conflicts
 * remain (stable dirty with branch still behind base).
 */
export async function assertPullRequestNotConflicting(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  options: { maxAttempts?: number; delayMs?: number } = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 20;
  const delayMs = options.delayMs ?? 3000;

  let lastState: Awaited<ReturnType<typeof getPullRequestMergeState>> | null =
    null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const state = await getPullRequestMergeState(
      octokit,
      owner,
      repo,
      prNumber,
    );
    lastState = state;

    if (isPullRequestMergeStateReady(state)) {
      return;
    }

    // `mergeable === null` or transient `dirty` — wait for GitHub to finish.
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const finalState =
    lastState ??
    (await getPullRequestMergeState(octokit, owner, repo, prNumber));

  if (isPullRequestMergeStateReady(finalState)) {
    return;
  }

  // Branch is fully up to date with base but mergeability is still stale.
  if (
    finalState.conflicts &&
    finalState.behind_by === 0 &&
    finalState.mergeable !== true
  ) {
    console.warn(
      `PR #${prNumber} mergeable_state is still "${finalState.mergeable_state}" after ${maxAttempts} polls, but compare reports behind_by=0; treating as non-conflicting.`,
    );
    return;
  }

  if (finalState.conflicts) {
    throw new PullRequestStillConflictingError(prNumber, finalState);
  }
}

export async function hasAgentBlockedComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<boolean> {
  return hasAgentMarker(
    octokit,
    owner,
    repo,
    prNumber,
    AGENT_COMMENT_MARKERS.blocked,
  );
}

/** Check whether an issue/PR already has a comment with a given agent marker. */
export async function hasAgentMarker(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  marker: AgentCommentMarker,
): Promise<boolean> {
  const { data } = await octokit.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  return data.some((comment) => comment.body?.includes(markerFor(marker)));
}

/** Check an already-fetched comment list for a given agent marker. */
export function hasAgentMarkerInComments(
  comments: Awaited<ReturnType<typeof readComments>>,
  marker: AgentCommentMarker,
): boolean {
  return comments.some((comment) => comment.body?.includes(markerFor(marker)));
}

export async function ensureLabel(
  octokit: Octokit,
  owner: string,
  repo: string,
  labelName: string,
  options: { color?: string; description?: string } = {},
) {
  try {
    const { data } = await octokit.issues.getLabel({
      owner,
      repo,
      name: labelName,
    });
    return data;
  } catch {
    const { data } = await octokit.issues.createLabel({
      owner,
      repo,
      name: labelName,
      color: options.color ?? "bfdadc",
      description:
        options.description ?? `Lifecycle label added by the agent pipeline.`,
    });
    return data;
  }
}

const AGENT_RESUME_LABELS = ["agent-waiting-human", "agent-failed"] as const;

export async function clearAgentResumeLabels(
  octokit: Octokit,
  owner: string,
  repo: string,
  {
    issueNumber,
    prNumber,
  }: {
    issueNumber?: number | string | null;
    prNumber?: number | string | null;
  },
) {
  const targets = new Set<number>();
  for (const raw of [issueNumber, prNumber]) {
    if (raw == null) continue;
    const parsed = typeof raw === "string" ? Number(raw) : raw;
    if (Number.isFinite(parsed) && parsed > 0) {
      targets.add(parsed);
    }
  }

  for (const targetNumber of targets) {
    for (const labelName of AGENT_RESUME_LABELS) {
      try {
        await octokit.issues.removeLabel({
          owner,
          repo,
          issue_number: targetNumber,
          name: labelName,
        });
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== 404) {
          throw error;
        }
      }
    }
  }
}

export async function addLabelToIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  labelName: string,
) {
  const { data } = await octokit.issues.addLabels({
    owner,
    repo,
    issue_number: issueNumber,
    labels: [labelName],
  });
  return data;
}

export async function removeLabelFromIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  labelName: string,
) {
  const { data } = await octokit.issues.removeLabel({
    owner,
    repo,
    issue_number: issueNumber,
    name: labelName,
  });
  return data;
}

/**
 * Removes several labels from an issue/PR, tolerating missing labels (404).
 * Other failures are logged and swallowed so labelling never fails a phase.
 */
export async function removeLabelsFromIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  labelNames: readonly string[],
): Promise<void> {
  await Promise.all(
    labelNames.map((name) =>
      removeLabelFromIssue(octokit, owner, repo, issueNumber, name).catch(
        (error) => {
          const status = (error as { status?: number }).status;
          if (status !== 404) {
            console.warn(`Failed to remove label ${name}:`, error);
          }
        },
      ),
    ),
  );
}

export type ReactionContent =
  "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";

export async function addReactionToIssueComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  content: ReactionContent,
) {
  const { data } = await octokit.reactions.createForIssueComment({
    owner,
    repo,
    comment_id: commentId,
    content,
  });
  return data;
}

export async function addReactionToPullRequestReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  reviewId: number,
  content: ReactionContent,
) {
  const reviewComments = await listReviewCommentsForReview(
    octokit,
    owner,
    repo,
    prNumber,
    reviewId,
  );
  if (reviewComments.length === 0) {
    console.log(
      "No review comments available to react to; GitHub does not support reactions on pull request reviews directly.",
    );
    return null;
  }
  const { data } = await octokit.reactions.createForPullRequestReviewComment({
    owner,
    repo,
    comment_id: reviewComments[0].id,
    content,
  });
  return data;
}

export const RISK_LABELS = [
  "agent-risk-low",
  "agent-risk-medium",
  "agent-risk-high",
] as const;

export const RISK_LEVELS = ["low", "medium", "high"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

const RISK_LABEL_CONFIG: Record<
  RiskLevel,
  { color: string; description: string }
> = {
  low: {
    color: "0e8a16",
    description: "Low risk assessment from agent plan or yolo run.",
  },
  medium: {
    color: "fbca04",
    description: "Medium risk assessment from agent plan or yolo run.",
  },
  high: {
    color: "d73a4a",
    description: "High risk assessment from agent plan or yolo run.",
  },
};

export function normalizeRiskLevel(value: string): RiskLevel | null {
  const normalized = value.trim().toLowerCase();
  return RISK_LEVELS.includes(normalized as RiskLevel)
    ? (normalized as RiskLevel)
    : null;
}

export function formatRiskScoreSection(
  level: RiskLevel,
  justification: string,
): string {
  return `### Risk score\n\n${level} — ${justification.trim()}`;
}

/** Removes an embedded ### Risk score section (legacy plans that included it in body). */
export function stripRiskScoreSection(body: string): string {
  return body
    .replace(/\n?### Risk [Ss]core[:\s]*\n[\s\S]*?(?=\n### |\n## |$)/, "")
    .trimEnd();
}

export function appendRiskScoreSection(
  body: string,
  level: RiskLevel,
  justification: string,
): string {
  const withoutRisk = stripRiskScoreSection(body);
  return `${withoutRisk}\n\n${formatRiskScoreSection(level, justification)}`;
}

export function parseRiskLevel(text: string): RiskLevel | null {
  const sectionMatch = text.match(
    /### Risk [Ss]core[:\s]*\n?([\s\S]*?)(?:\n### |\n## |---|\n$|$)/,
  );
  if (sectionMatch) {
    const lines = sectionMatch[1]
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const first = lines[0];
    if (first) {
      const prefixMatch = first.match(/^[-:]?\s*(low|medium|high)\b/i);
      if (prefixMatch) {
        return prefixMatch[1].toLowerCase() as RiskLevel;
      }
    }
  }
  const inlineMatch = text.match(/\brisk[:\s]+(low|medium|high)\b/i);
  if (inlineMatch) {
    return inlineMatch[1].toLowerCase() as RiskLevel;
  }
  return null;
}

// Anchored to the start of the (bold-stripped) line so justification words
// such as "minimal blast radius" cannot win over the actual level. An optional
// short `level:` / `risk:` prefix is tolerated.
const MERGE_RISK_LEVEL_WORDS: { line: RegExp; level: RiskLevel }[] = [
  { line: /^(?:level|risk)?[:\s-]*minimal\b/i, level: "low" },
  { line: /^(?:level|risk)?[:\s-]*moderate\b/i, level: "medium" },
  { line: /^(?:level|risk)?[:\s-]*high\b/i, level: "high" },
];

/** Parses ## Merge risk (Minimal / Moderate / High) from a code-review body. */
export function parseMergeRiskLevel(body: string): RiskLevel | null {
  const sectionMatch = body.match(
    /## Merge risk[:\s]*\n([\s\S]*?)(?=\n## |\n$|$)/i,
  );
  if (!sectionMatch) {
    return null;
  }
  const firstLine = sectionMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return null;
  }
  const candidate = firstLine.replace(/\*\*/g, "").replace(/^[-*:]?\s*/, "");
  for (const { line, level } of MERGE_RISK_LEVEL_WORDS) {
    if (line.test(candidate)) {
      return level;
    }
  }
  return null;
}

export function riskLabelEnsureOptions(labelName: string): {
  color?: string;
  description?: string;
} {
  const match = /^agent-risk-(low|medium|high)$/.exec(labelName);
  if (!match) {
    return {};
  }
  const level = match[1] as RiskLevel;
  return RISK_LABEL_CONFIG[level];
}

export async function manageExclusiveLabels(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  labelNames: readonly string[],
  activeLabel: string,
  ensureOptions?: (labelName: string) => {
    color?: string;
    description?: string;
  },
) {
  await Promise.all(
    labelNames.map((name) =>
      ensureLabel(octokit, owner, repo, name, ensureOptions?.(name) ?? {}),
    ),
  );

  await removeLabelsFromIssue(
    octokit,
    owner,
    repo,
    issueNumber,
    labelNames.filter((name) => name !== activeLabel),
  );

  await addLabelToIssue(octokit, owner, repo, issueNumber, activeLabel);
}

export function extractRiskJustification(text: string): string | null {
  const sectionMatch = text.match(
    /### Risk [Ss]core[:\s]*\n?([\s\S]*?)(?:\n### |\n## |---|\n$)/,
  );
  if (!sectionMatch) {
    return null;
  }
  const lines = sectionMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const first = lines[0];
  if (!first) {
    return null;
  }
  const prefixMatch = first.match(
    /^[-:]?\s*(low|medium|high)\b\s*[-—]\s*(.*)$/i,
  );
  if (prefixMatch && prefixMatch[2]) {
    return prefixMatch[2];
  }
  // If the first line is just the level (e.g. yolo header), use the next line.
  if (/^(low|medium|high)$/i.test(first) && lines[1]) {
    return lines[1];
  }
  return first;
}

export async function manageRiskLabels(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  level: RiskLevel,
) {
  const labelNames = RISK_LEVELS.map((lvl) => `agent-risk-${lvl}`);
  await manageExclusiveLabels(
    octokit,
    owner,
    repo,
    issueNumber,
    labelNames,
    `agent-risk-${level}`,
    riskLabelEnsureOptions,
  );
}

export type PullRequestReviewEvent = "COMMENT" | "REQUEST_CHANGES";

export type PullRequestReviewCommentInput = {
  path: string;
  body: string;
  line: number;
  side?: "LEFT" | "RIGHT";
};

export type CreatePullRequestReviewInput = {
  event: PullRequestReviewEvent;
  body: string;
  comments?: PullRequestReviewCommentInput[];
};

function httpStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === "number") {
      return status;
    }
  }
  return undefined;
}

function isUnprocessable(error: unknown): boolean {
  return httpStatus(error) === 422;
}

function toReviewComments(
  comments: PullRequestReviewCommentInput[] | undefined,
) {
  if (!comments || comments.length === 0) {
    return undefined;
  }
  return comments.map((comment) => ({
    path: comment.path,
    body: comment.body,
    line: comment.line,
    side: comment.side ?? "RIGHT",
  }));
}

export async function createPullRequestReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  input: CreatePullRequestReviewInput,
) {
  const { data: pr } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  const commitId = pr.head.sha;

  const post = async (
    event: PullRequestReviewEvent,
    comments?: PullRequestReviewCommentInput[],
  ) => {
    const { data } = await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitId,
      event,
      body: input.body,
      comments: toReviewComments(comments),
    });
    return data;
  };

  const comments = input.comments;
  try {
    return await post(input.event, comments);
  } catch (error) {
    if (comments && comments.length > 0 && isUnprocessable(error)) {
      try {
        return await post(input.event, undefined);
      } catch (retryError) {
        if (input.event === "REQUEST_CHANGES" && isUnprocessable(retryError)) {
          return await post("COMMENT", undefined);
        }
        throw retryError;
      }
    }
    if (input.event === "REQUEST_CHANGES" && isUnprocessable(error)) {
      try {
        return await post("COMMENT", comments);
      } catch (retryError) {
        if (comments && comments.length > 0 && isUnprocessable(retryError)) {
          return await post("COMMENT", undefined);
        }
        throw retryError;
      }
    }
    throw error;
  }
}

export async function updatePullRequestReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  reviewId: number,
  body: string,
) {
  const { data } = await octokit.pulls.updateReview({
    owner,
    repo,
    pull_number: prNumber,
    review_id: reviewId,
    body,
  });
  return data;
}

export type PullRequestReviewThreadComment = {
  id: number;
  body: string;
  path: string | null;
  line: number | null;
  authorLogin: string | null;
};

export type PullRequestReviewThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  comments: PullRequestReviewThreadComment[];
};

async function runGitHubGraphql<TData>(
  octokit: Octokit,
  query: string,
  variables: Record<string, unknown>,
): Promise<TData> {
  const auth = await octokit.auth();
  const token =
    typeof auth === "string"
      ? auth
      : auth && typeof auth === "object" && "token" in auth
        ? String((auth as { token: string }).token)
        : "";
  if (!token) {
    throw new Error("GitHub GraphQL requires an authenticated Octokit client");
  }

  const request = octokit.request as {
    endpoint?: (options: { baseUrl?: string }) => {
      DEFAULTS?: { baseUrl?: string };
    };
  };
  const baseUrl =
    request.endpoint?.({})?.DEFAULTS?.baseUrl ?? "https://api.github.com";
  const graphqlUrl = `${baseUrl.replace(/\/$/, "")}/graphql`;

  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await response.json()) as {
    data?: TData;
    errors?: { message: string }[];
  };
  if (!response.ok) {
    throw new Error(
      `GitHub GraphQL HTTP ${response.status}: ${JSON.stringify(json)}`,
    );
  }
  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join("; "));
  }
  if (!json.data) {
    throw new Error("GitHub GraphQL returned no data");
  }
  return json.data;
}

const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 50) {
            nodes {
              databaseId
              body
              path
              line
              author { login }
            }
          }
        }
      }
    }
  }
}`;

type ReviewThreadsQueryResult = {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          isResolved: boolean;
          isOutdated: boolean;
          comments: {
            nodes: {
              databaseId: number | null;
              body: string;
              path: string | null;
              line: number | null;
              author: { login: string } | null;
            }[];
          };
        }[];
      };
    } | null;
  } | null;
};

export async function listPullRequestReviewThreads(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PullRequestReviewThread[]> {
  const threads: PullRequestReviewThread[] = [];
  let after: string | null = null;

  for (;;) {
    const data: ReviewThreadsQueryResult = await runGitHubGraphql(
      octokit,
      REVIEW_THREADS_QUERY,
      {
        owner,
        name: repo,
        number: prNumber,
        after,
      },
    );
    const page = data.repository?.pullRequest?.reviewThreads;
    if (!page) {
      break;
    }

    for (const node of page.nodes) {
      threads.push({
        id: node.id,
        isResolved: node.isResolved,
        isOutdated: node.isOutdated,
        comments: node.comments.nodes.map((comment) => ({
          id: comment.databaseId ?? 0,
          body: comment.body,
          path: comment.path,
          line: comment.line,
          authorLogin: comment.author?.login ?? null,
        })),
      });
    }

    if (!page.pageInfo.hasNextPage) {
      break;
    }
    after = page.pageInfo.endCursor;
  }

  return threads;
}

const RESOLVE_THREAD_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

export async function resolvePullRequestReviewThread(
  octokit: Octokit,
  threadId: string,
): Promise<{ id: string; isResolved: boolean }> {
  const data = await runGitHubGraphql<{
    resolveReviewThread: {
      thread: { id: string; isResolved: boolean };
    };
  }>(octokit, RESOLVE_THREAD_MUTATION, { threadId });
  return data.resolveReviewThread.thread;
}

export function formatReviewThreadsForPrompt(
  threads: PullRequestReviewThread[],
  options?: { includeBody?: boolean },
): string {
  if (threads.length === 0) {
    return "(no open review threads in scope)";
  }
  const includeBody = options?.includeBody ?? true;
  return threads
    .map((thread) => {
      const root = thread.comments[0];
      const path = root?.path ?? "(no path)";
      const line = root?.line != null ? ` line ${root.line}` : "";
      const author = root?.authorLogin ?? "unknown";
      const body = includeBody ? `\n${(root?.body ?? "").trim()}` : "";
      const outdated = thread.isOutdated ? " outdated" : "";
      const rootId =
        root?.id != null && root.id > 0 ? ` rootCommentId=${root.id}` : "";
      return `--- Thread id=${thread.id} on ${path}${line} (${author}${outdated})${rootId} ---${body}`;
    })
    .join("\n\n");
}
