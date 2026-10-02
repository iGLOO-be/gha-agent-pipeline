import {
  REVIEW_FIX_MODEL,
  loadAgentConfig,
  loadReviewFixEnv,
  parseRepository,
} from "./config.js";
import {
  applyCommandGithubTools,
  prepareCommandRuntime,
} from "./command-runtime.js";
import {
  assertPullRequestMergeAfterPush,
  formatMergeStillBlockedStatusLine,
  getUpstreamDriftMaxPasses,
  PullRequestStillConflictingError,
  shouldRetryUpstreamDriftAfterPush,
} from "./fix-post-push.js";
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
import {
  runAgentMain,
  runAgentSession,
  type AgentSessionResult,
} from "./runtime.js";
import { runAgentPhase } from "./lifecycle.js";
import {
  clearAgentResumeLabels,
  createOctokit,
  findPlanComment,
  formatPrCommentsForPrompt,
  buildReviewFixReviewCommentContext,
  postComment,
  readComments,
  readIssue,
  getPullRequestMergeState,
  readPullRequestComments,
} from "./tools/github.js";
import { createReviewFixTools } from "./tools/index.js";
import { withReportRunFrictionTool } from "./tools/run-friction-tool.js";
import {
  createPhaseReportTracker,
  formatPhaseCompletionMarkdown,
  resolveAgentCommitMessage,
  type PhaseReport,
} from "./phase-report.js";

function buildConflictPriorityHint(
  prState: Awaited<ReturnType<typeof getPullRequestMergeState>>,
  reviewFeedback: string,
  baseBranchName: string,
): string {
  const bareFix =
    reviewFeedback.replace(/\/agent\s+fix/gi, "").trim().length === 0;
  if (!prState.conflicts || !bareFix) {
    return "";
  }
  return `

PRIORITY: GitHub reports this PR cannot merge into ${baseBranchName} (mergeable_state=${prState.mergeable_state}). Your first job is to resolve merge conflicts with ${baseBranchName} using the conflicting files in the merge context. Do not re-implement the feature from scratch.`;
}

async function buildMergeContextBlock(
  baseBranch: string,
  prNumber: number,
  octokit: ReturnType<typeof createOctokit>,
  owner: string,
  repo: string,
  syncMessage: string,
  forceMerge: boolean,
): Promise<string> {
  const prMergeState = await getPullRequestMergeState(
    octokit,
    owner,
    repo,
    prNumber,
  );
  const syncResult = await syncWithBaseBranch(baseBranch, syncMessage, {
    force: forceMerge,
  });
  return [
    syncResult,
    "",
    "GitHub PR merge state:",
    `- mergeable: ${prMergeState.mergeable ?? "unknown"}`,
    `- mergeable_state: ${prMergeState.mergeable_state}`,
    `- conflicts: ${prMergeState.conflicts}`,
    prMergeState.conflicts && !forceMerge
      ? `- note: GitHub reports conflicts but the local branch already includes ${baseBranch}; no merge was started.`
      : "",
    prMergeState.behind_by != null
      ? `- behind_by: ${prMergeState.behind_by}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildReviewFixComment(
  body: string,
  phaseReport: PhaseReport | undefined,
  session: AgentSessionResult,
  runFriction: ReturnType<typeof createRunFrictionCollector>,
): string {
  const completion = formatPhaseCompletionMarkdown({
    phase: "review-fix",
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
  return `<!-- agent-review-fix -->\n${completion}`;
}

async function main() {
  const env = loadReviewFixEnv();
  const config = loadAgentConfig();
  const cmd = prepareCommandRuntime("review-fix", REVIEW_FIX_MODEL, config);
  const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
  const octokit = createOctokit(env.GITHUB_TOKEN);

  try {
    const issue = await readIssue(octokit, owner, repo, env.ISSUE_NUMBER);
    const issueComments = await readComments(
      octokit,
      owner,
      repo,
      env.ISSUE_NUMBER,
    );
    const plan = findPlanComment(issueComments);
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

    const initialPrMergeState = await getPullRequestMergeState(
      octokit,
      owner,
      repo,
      env.PR_NUMBER,
    );
    const initialForceMerge = await shouldForceMergeFromGitHub(
      config.git.base_branch,
      initialPrMergeState.conflicts,
    );

    let mergeContext = await buildMergeContextBlock(
      config.git.base_branch,
      env.PR_NUMBER,
      octokit,
      owner,
      repo,
      "Resolve these conflicts first, then address the review feedback.",
      initialForceMerge,
    );

    const conflictPriority = buildConflictPriorityHint(
      { ...initialPrMergeState, conflicts: initialForceMerge },
      env.REVIEW_FEEDBACK,
      config.git.base_branch,
    );

    const runFriction = createRunFrictionCollector();
    const maxPasses = getUpstreamDriftMaxPasses();
    let lastSession: AgentSessionResult | undefined;
    let lastPhaseReport = createPhaseReportTracker().report;

    for (let pass = 0; pass < maxPasses; pass++) {
      if (pass > 0) {
        console.warn(
          `Upstream drift detected after push; starting review-fix pass ${pass + 1}/${maxPasses}.`,
        );
        const driftState = await getPullRequestMergeState(
          octokit,
          owner,
          repo,
          env.PR_NUMBER,
        );
        const forceMerge = await shouldForceMergeFromGitHub(
          config.git.base_branch,
          driftState.conflicts,
        );
        mergeContext = await buildMergeContextBlock(
          config.git.base_branch,
          env.PR_NUMBER,
          octokit,
          owner,
          repo,
          "Resolve these conflicts with the latest base. Preserve review fixes from the previous pass.",
          forceMerge,
        );
      }

      const phaseReportTracker = createPhaseReportTracker();
      let tools = await withReportRunFrictionTool(
        await createReviewFixTools(
          octokit,
          owner,
          repo,
          env.ISSUE_NUMBER,
          env.PR_NUMBER,
          phaseReportTracker,
        ),
        runFriction,
      );
      tools = applyCommandGithubTools(tools, cmd.resolved.tools.github);

      const driftRetryPrompt =
        pass > 0
          ? `PRIORITY: ${config.git.base_branch} advanced while the previous review-fix pass was running. Resolve merge conflicts with ${config.git.base_branch} using the merge context below. Preserve review fixes already made on this branch; do not revert unrelated work.

`
          : "";

      const session = await runAgentSession({
        phase: cmd.runtimePhase,
        modelId: cmd.modelId,
        systemPrompt: cmd.systemPrompt,
        tools,
        runFriction,
        sessionMetadata: {
          phase: cmd.runtimePhase,
          commandId: cmd.commandId,
          issueNumber: env.ISSUE_NUMBER,
          prNumber: env.PR_NUMBER,
          repository: env.GITHUB_REPOSITORY,
          upstreamDriftPass: pass,
        },
        prompt:
          pass === 0
            ? `Address review feedback on PR #${env.PR_NUMBER} (issue #${env.ISSUE_NUMBER}).
${conflictPriority}
${
  reviewCommentContext.bareFixTrigger
    ? `
The fix trigger did not include explicit feedback. Treat the PR review bodies and line comments below (including prior /agent code-review output) as the work order. Apply suggested fixes where appropriate; skip judgement-call nits that are not required for merge.`
    : ""
}

Merge context:
${mergeContext}

Issue: ${issue.title}

Latest review / fix trigger:
${env.REVIEW_FEEDBACK}

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
Branch: ${env.AGENT_BRANCH}`
            : `${driftRetryPrompt}Address remaining merge issues on PR #${env.PR_NUMBER} (issue #${env.ISSUE_NUMBER}).

Merge context:
${mergeContext}

Repository: ${env.GITHUB_REPOSITORY}
Branch: ${env.AGENT_BRANCH}`,
      });

      lastSession = session;
      lastPhaseReport = phaseReportTracker.report;

      await prepareResolvedMergeForCommit();

      const pushResult = await commitAndPushBranch(
        env.AGENT_BRANCH,
        resolveAgentCommitMessage(
          phaseReportTracker.report,
          pass > 0
            ? `fix(review): sync with ${config.git.base_branch} on PR #${env.PR_NUMBER}`
            : `fix(review): address feedback on PR #${env.PR_NUMBER}`,
        ),
      );

      // Only the first pass can legitimately complete with "already synced".
      // On a drift-retry pass the branch was already pushed, so we must still
      // verify GitHub mergeability before reporting success.
      if (pass === 0 && pushResult.status === "noChanges") {
        await postComment(
          octokit,
          owner,
          repo,
          env.PR_NUMBER,
          buildReviewFixComment(
            `No commit was needed: the branch is already synced with \`${config.git.base_branch}\` and the agent made no code changes.`,
            lastPhaseReport,
            session,
            runFriction,
          ),
        );
        console.log(
          `\nReview fix completed with no changes on branch ${env.AGENT_BRANCH}`,
        );
        await clearAgentResumeLabels(octokit, owner, repo, {
          issueNumber: env.ISSUE_NUMBER,
          prNumber: env.PR_NUMBER,
        });
        return;
      }

      await assertLocalMergeResolved();

      try {
        await assertPullRequestMergeAfterPush(
          octokit,
          owner,
          repo,
          env.PR_NUMBER,
        );
        await postComment(
          octokit,
          owner,
          repo,
          env.PR_NUMBER,
          buildReviewFixComment(
            `Pushed review fixes for PR #${env.PR_NUMBER}.`,
            lastPhaseReport,
            session,
            runFriction,
          ),
        );
        await clearAgentResumeLabels(octokit, owner, repo, {
          issueNumber: env.ISSUE_NUMBER,
          prNumber: env.PR_NUMBER,
        });
        console.log(`\nReview fix pushed on branch ${env.AGENT_BRANCH}`);
        appendRunFrictionStepSummary(runFriction, "review-fix");
        return;
      } catch (error) {
        if (
          error instanceof PullRequestStillConflictingError &&
          shouldRetryUpstreamDriftAfterPush(error, pass, maxPasses)
        ) {
          continue;
        }
        if (error instanceof PullRequestStillConflictingError) {
          await postComment(
            octokit,
            owner,
            repo,
            env.PR_NUMBER,
            buildReviewFixComment(
              formatMergeStillBlockedStatusLine(
                `Pushed review fixes for PR #${env.PR_NUMBER}.`,
                config.git.base_branch,
                error,
              ),
              lastPhaseReport,
              session,
              runFriction,
            ),
          );
          await clearAgentResumeLabels(octokit, owner, repo, {
            issueNumber: env.ISSUE_NUMBER,
            prNumber: env.PR_NUMBER,
          });
          console.warn(
            `\nReview fix pushed on branch ${env.AGENT_BRANCH}, but PR is still not mergeable.`,
          );
          appendRunFrictionStepSummary(runFriction, "review-fix");
          return;
        }
        throw error;
      }
    }
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
      "review-fix",
      error,
    );
    throw error;
  }
}

const env = loadReviewFixEnv();
const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
const octokit = createOctokit(env.GITHUB_TOKEN);
const bootCmd = prepareCommandRuntime(
  "review-fix",
  REVIEW_FIX_MODEL,
  loadAgentConfig(),
);

runAgentMain(() =>
  runAgentPhase({
    phase: bootCmd.runtimePhase,
    displayLabel: bootCmd.displayLabel,
    octokit,
    owner,
    repo,
    issueNumber: env.ISSUE_NUMBER,
    prNumber: env.PR_NUMBER,
    main,
  }),
);
