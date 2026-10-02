import {
  resolveFixModel,
  buildPhaseSystemPrompt,
  loadAgentConfig,
  parseRepository,
  resolveFixHeadSha,
  type FixEnvWithBranch,
  type FixPhaseEntry,
} from "./config.js";
import { commitAndPushBranch } from "./git/pr.js";
import {
  assertLocalMergeResolved,
  prepareResolvedMergeForCommit,
  shouldForceMergeFromGitHub,
  syncWithBaseBranch,
} from "./git/sync.js";
import { reportPhaseFailure } from "./report-failure.js";
import {
  appendRunFrictionStepSummary,
  createRunFrictionCollector,
} from "./run-friction.js";
import { runAgentSession } from "./runtime.js";
import {
  clearAgentResumeLabels,
  createOctokit,
  findPlanComment,
  formatPrCommentsForPrompt,
  buildReviewFixReviewCommentContext,
  assertPullRequestNotConflicting,
  formatFailedChecksForPrompt,
  hasAgentBlockedComment,
  hasFailedCheckRuns,
  isBareReviewFixFeedback,
  postComment,
  readCheckRuns,
  readComments,
  readIssue,
  getPullRequestMergeState,
  readPullRequestComments,
} from "./tools/github.js";
import { createFixTools } from "./tools/index.js";
import { withReportRunFrictionTool } from "./tools/run-friction-tool.js";
import {
  createPhaseReportTracker,
  formatPhaseCompletionMarkdown,
  resolveAgentCommitMessage,
} from "./phase-report.js";

export function buildConflictPriorityHint(
  prState: Awaited<ReturnType<typeof getPullRequestMergeState>>,
  reviewFeedback: string,
  baseBranchName: string,
): string {
  const bareFix = isBareReviewFixFeedback(reviewFeedback);
  if (!prState.conflicts || !bareFix) {
    return "";
  }
  return `

PRIORITY: GitHub reports this PR cannot merge into ${baseBranchName} (mergeable_state=${prState.mergeable_state}). Your first job is to resolve merge conflicts with ${baseBranchName} using the conflicting files in the merge context. Do not re-implement the feature from scratch.`;
}

export function buildBareFixWorkOrderHint(
  bareFix: boolean,
  hasFailedChecks: boolean,
  entry: FixPhaseEntry,
): string {
  if (!bareFix) {
    return "";
  }
  if (hasFailedChecks) {
    return `
The fix trigger did not include explicit feedback. Failed CI checks are listed below — investigate with readCheckLogs and fix them first. Also address PR review bodies and line comments (including prior /agent code-review output) when they require changes for merge.`;
  }
  if (entry === "ci-fix") {
    return `
No failed checks were preloaded on this SHA. Use readCheckRuns and readCheckLogs if needed to find CI failures.`;
  }
  return `
The fix trigger did not include explicit feedback. Treat the PR review bodies and line comments below (including prior /agent code-review output) as the work order. Apply suggested fixes where appropriate; skip judgement-call nits that are not required for merge.`;
}

async function preloadFailedChecksSummary(
  octokit: ReturnType<typeof createOctokit>,
  owner: string,
  repo: string,
  headSha: string,
  entry: FixPhaseEntry,
): Promise<{ summary: string; hasFailedChecks: boolean }> {
  try {
    const checkRuns = await readCheckRuns(octokit, owner, repo, headSha);
    return {
      summary: formatFailedChecksForPrompt(checkRuns),
      hasFailedChecks: hasFailedCheckRuns(checkRuns),
    };
  } catch (error) {
    if (entry === "ci-fix") {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `Could not preload check runs for review-fix (${message}); continuing without failed-check context.`,
    );
    return {
      summary: `(could not preload check runs: ${message}. Grant Checks read on the App installation, or call readCheckRuns during the session.)`,
      hasFailedChecks: false,
    };
  }
}

function fixCommentMarker(entry: FixPhaseEntry): string {
  return entry === "ci-fix" ? "agent-ci-fix" : "agent-review-fix";
}

function defaultCommitSubject(entry: FixPhaseEntry, prNumber: number): string {
  if (entry === "ci-fix") {
    return `fix(ci): address failures for PR #${prNumber}`;
  }
  return `fix(review): address feedback on PR #${prNumber}`;
}

function pushedStatusLine(
  entry: FixPhaseEntry,
  prNumber: number,
  headSha: string,
): string {
  if (entry === "ci-fix") {
    return `Pushed a CI fix commit for \`${headSha.slice(0, 7)}\`.`;
  }
  return `Pushed review fixes for PR #${prNumber}.`;
}

export async function runFixPhase(
  entry: FixPhaseEntry,
  env: FixEnvWithBranch,
): Promise<void> {
  const config = loadAgentConfig();
  const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
  const octokit = createOctokit(env.GITHUB_TOKEN);

  try {
    if (await hasAgentBlockedComment(octokit, owner, repo, env.PR_NUMBER)) {
      console.log(
        `PR #${env.PR_NUMBER} has <!-- agent-blocked --> marker; aborting fix.`,
      );
      return;
    }

    const headSha = await resolveFixHeadSha(
      octokit,
      owner,
      repo,
      env.PR_NUMBER,
      env.HEAD_SHA,
    );

    const issue = await readIssue(octokit, owner, repo, env.ISSUE_NUMBER);
    const issueComments = await readComments(
      octokit,
      owner,
      repo,
      env.ISSUE_NUMBER,
    );
    const plan = findPlanComment(issueComments);
    const { summary: failedSummary, hasFailedChecks } =
      await preloadFailedChecksSummary(octokit, owner, repo, headSha, entry);

    const prComments = await readPullRequestComments(
      octokit,
      owner,
      repo,
      env.PR_NUMBER,
    );
    const prThread = formatPrCommentsForPrompt(prComments);
    const triggerCommentIdRaw = process.env.COMMENT_ID;
    const triggerCommentId =
      triggerCommentIdRaw != null && triggerCommentIdRaw !== ""
        ? Number(triggerCommentIdRaw)
        : undefined;
    const reviewCommentContext = await buildReviewFixReviewCommentContext(
      octokit,
      owner,
      repo,
      env.PR_NUMBER,
      {
        reviewFeedback: env.REVIEW_FEEDBACK,
        reactionTarget: process.env.REACTION_TARGET,
        triggerCommentId: Number.isFinite(triggerCommentId)
          ? triggerCommentId
          : undefined,
      },
    );
    const reviewContextWarnings =
      reviewCommentContext.warnings.length > 0
        ? `\n\nWarnings:\n${reviewCommentContext.warnings.map((w) => `- ${w}`).join("\n")}`
        : "";

    const prMergeState = await getPullRequestMergeState(
      octokit,
      owner,
      repo,
      env.PR_NUMBER,
    );

    const forceMerge = await shouldForceMergeFromGitHub(
      config.git.base_branch,
      prMergeState.conflicts,
    );

    const mergeContext = [
      await syncWithBaseBranch(
        config.git.base_branch,
        "Resolve these conflicts first, then fix CI failures and address review feedback.",
        { force: forceMerge },
      ),
      "",
      "GitHub PR merge state:",
      `- mergeable: ${prMergeState.mergeable ?? "unknown"}`,
      `- mergeable_state: ${prMergeState.mergeable_state}`,
      `- conflicts: ${prMergeState.conflicts}`,
      prMergeState.conflicts && !forceMerge
        ? `- note: GitHub reports conflicts but the local branch already includes ${config.git.base_branch}; no merge was started.`
        : "",
      prMergeState.behind_by != null
        ? `- behind_by: ${prMergeState.behind_by}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    const conflictPriority = buildConflictPriorityHint(
      { ...prMergeState, conflicts: forceMerge },
      env.REVIEW_FEEDBACK,
      config.git.base_branch,
    );

    const bareFixForHints =
      entry === "review-fix" && reviewCommentContext.bareFixTrigger;

    const bareFixHint = buildBareFixWorkOrderHint(
      bareFixForHints,
      hasFailedChecks,
      entry,
    );

    const runFriction = createRunFrictionCollector();
    const phaseReportTracker = createPhaseReportTracker();
    const tools = await withReportRunFrictionTool(
      await createFixTools(
        octokit,
        owner,
        repo,
        env.ISSUE_NUMBER,
        env.PR_NUMBER,
        headSha,
        phaseReportTracker,
      ),
      runFriction,
    );

    const modelId = resolveFixModel(config, entry);

    const session = await runAgentSession({
      phase: entry,
      modelId,
      systemPrompt: buildPhaseSystemPrompt(entry, config),
      tools,
      runFriction,
      sessionMetadata: {
        phase: entry,
        issueNumber: env.ISSUE_NUMBER,
        prNumber: env.PR_NUMBER,
        headSha,
        repository: env.GITHUB_REPOSITORY,
      },
      prompt: `Fix PR #${env.PR_NUMBER} (issue #${env.ISSUE_NUMBER}): resolve merge conflicts if any, fix failing CI, and address review feedback.
${conflictPriority}
${bareFixHint}

Merge context:
${mergeContext}

Head SHA: ${headSha}
Issue: ${issue.title}

Failed checks:
${failedSummary}

Latest review / fix trigger:
${env.REVIEW_FEEDBACK || "(none — bare /agent fix or CI auto-fix)"}

PR review bodies (submitted reviews on this pull request):
${reviewCommentContext.reviewBodiesSection}

Referenced review comments (from trigger / review submission):
${reviewCommentContext.referencedSection}${reviewContextWarnings}

PR review comments (line comments on diff${
        reviewCommentContext.bareFixTrigger
          ? ", all authors"
          : ", human authors"
      }):
${reviewCommentContext.lineCommentsSection}

Approved plan (context):
${plan ?? "(no plan comment found)"}

PR discussion:
${prThread}

Repository: ${env.GITHUB_REPOSITORY}
Branch: ${env.AGENT_BRANCH}`,
    });

    appendRunFrictionStepSummary(runFriction, entry);

    const phaseReport = phaseReportTracker.report;

    const buildFixComment = (body: string): string => {
      const completion = formatPhaseCompletionMarkdown({
        phase: entry,
        statusLine: body,
        phaseReport,
        sessionUsage: session.usage,
        sessionId: session.sessionId,
        modelId: session.modelId,
        servedModelIds: session.servedModelIds,
        openRouterCostUsd: session.openRouterCostUsd,
        iterations: session.iterations,
        toolCallsCount: session.toolCallsCount,
        runFriction,
      });
      return `<!-- ${fixCommentMarker(entry)} -->\n${completion}`;
    };

    await prepareResolvedMergeForCommit();

    const pushResult = await commitAndPushBranch(
      env.AGENT_BRANCH,
      resolveAgentCommitMessage(
        phaseReport,
        defaultCommitSubject(entry, env.PR_NUMBER),
      ),
    );

    if (pushResult.status === "noChanges") {
      await postComment(
        octokit,
        owner,
        repo,
        env.PR_NUMBER,
        buildFixComment(
          `No commit was needed: the branch is already synced with \`${config.git.base_branch}\` and the agent made no code changes.`,
        ),
      );
      console.log(
        `\nFix (${entry}) completed with no changes on branch ${env.AGENT_BRANCH}`,
      );
      await clearAgentResumeLabels(octokit, owner, repo, {
        issueNumber: env.ISSUE_NUMBER,
        prNumber: env.PR_NUMBER,
      });
      return;
    }

    await assertLocalMergeResolved();

    await assertPullRequestNotConflicting(octokit, owner, repo, env.PR_NUMBER);

    await postComment(
      octokit,
      owner,
      repo,
      env.PR_NUMBER,
      buildFixComment(pushedStatusLine(entry, env.PR_NUMBER, headSha)),
    );

    await clearAgentResumeLabels(octokit, owner, repo, {
      issueNumber: env.ISSUE_NUMBER,
      prNumber: env.PR_NUMBER,
    });

    console.log(`\nFix (${entry}) pushed on branch ${env.AGENT_BRANCH}`);
  } catch (error) {
    await reportPhaseFailure(
      octokit,
      owner,
      repo,
      {
        kind: "pr",
        number: env.PR_NUMBER,
        sourceIssueNumber: env.ISSUE_NUMBER,
      },
      entry,
      error,
    );
    throw error;
  }
}
