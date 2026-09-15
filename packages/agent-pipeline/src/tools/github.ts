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

export function formatFailedChecksForPrompt(runs: CheckRunSummary[]): string {
  const failed = runs.filter(
    (run) => run.conclusion === "failure" || run.conclusion === "timed_out",
  );
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
    throw new Error(
      `PR #${prNumber} still has merge conflicts (mergeable_state: ${finalState.mergeable_state}${finalState.behind_by != null ? `, behind_by: ${finalState.behind_by}` : ""}).`,
    );
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
  const { data: reviewComments } = await octokit.pulls.listCommentsForReview({
    owner,
    repo,
    pull_number: prNumber,
    review_id: reviewId,
  });
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

export function parseRiskLevel(text: string): RiskLevel | null {
  const sectionMatch = text.match(
    /### Risk [Ss]core[:\s]*\n?[\s\S]*?\b(low|medium|high)\b/,
  );
  if (sectionMatch) {
    return sectionMatch[1] as RiskLevel;
  }
  const inlineMatch = text.match(/\brisk[:\s]+(low|medium|high)\b/i);
  if (inlineMatch) {
    return inlineMatch[1].toLowerCase() as RiskLevel;
  }
  return null;
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
  await Promise.all(
    RISK_LEVELS.map((lvl) =>
      ensureLabel(octokit, owner, repo, `agent-risk-${lvl}`, {
        color: RISK_LABEL_CONFIG[lvl].color,
        description: RISK_LABEL_CONFIG[lvl].description,
      }),
    ),
  );

  const others = RISK_LEVELS.filter((lvl) => lvl !== level);
  await Promise.all(
    others.map((lvl) =>
      removeLabelFromIssue(
        octokit,
        owner,
        repo,
        issueNumber,
        `agent-risk-${lvl}`,
      ).catch((error) => {
        const status = (error as { status?: number }).status;
        if (status !== 404) {
          console.warn(`Failed to remove agent-risk-${lvl} label:`, error);
        }
      }),
    ),
  );

  await addLabelToIssue(
    octokit,
    owner,
    repo,
    issueNumber,
    `agent-risk-${level}`,
  );
}
