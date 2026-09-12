import {
  REVIEW_FIX_MODEL,
  buildPhaseSystemPrompt,
  loadAgentConfig,
  loadReviewFixEnv,
  parseRepository,
} from "./config.js";
import { commitAndPushBranch } from "./git/pr.js";
import {
  assertLocalMergeResolved,
  prepareResolvedMergeForCommit,
  shouldForceMergeFromGitHub,
  syncWithBaseBranch,
} from "./git/sync.js";
import { reportPhaseFailure } from "./report-failure.js";
import { runAgentMain, runAgentSession } from "./runtime.js";
import { runAgentPhase } from "./lifecycle.js";
import {
  clearAgentResumeLabels,
  createOctokit,
  findPlanComment,
  formatPrCommentsForPrompt,
  assertPullRequestNotConflicting,
  postComment,
  readComments,
  readIssue,
  getPullRequestMergeState,
  readPullRequestComments,
} from "./tools/github.js";
import { createReviewFixTools } from "./tools/index.js";

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

async function main() {
  const env = loadReviewFixEnv();
  const config = loadAgentConfig();
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
        "Resolve these conflicts first, then address the review feedback.",
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

    const tools = await createReviewFixTools(
      octokit,
      owner,
      repo,
      env.ISSUE_NUMBER,
      env.PR_NUMBER,
    );

    await runAgentSession({
      phase: "review-fix",
      modelId: REVIEW_FIX_MODEL,
      systemPrompt: buildPhaseSystemPrompt("review-fix", config),
      tools,
      sessionMetadata: {
        phase: "review-fix",
        issueNumber: env.ISSUE_NUMBER,
        prNumber: env.PR_NUMBER,
        repository: env.GITHUB_REPOSITORY,
      },
      prompt: `Address review feedback on PR #${env.PR_NUMBER} (issue #${env.ISSUE_NUMBER}).
${conflictPriority}

Merge context:
${mergeContext}

Issue: ${issue.title}

Latest review / fix trigger:
${env.REVIEW_FEEDBACK}

Approved plan (context):
${plan ?? "(no plan comment found)"}

PR discussion:
${prThread}

Repository: ${env.GITHUB_REPOSITORY}
Branch: ${env.AGENT_BRANCH}`,
    });

    await prepareResolvedMergeForCommit();

    const pushResult = await commitAndPushBranch(
      env.AGENT_BRANCH,
      `fix(review): address feedback on PR #${env.PR_NUMBER}`,
    );

    if (pushResult.status === "noChanges") {
      await postComment(
        octokit,
        owner,
        repo,
        env.PR_NUMBER,
        `<!-- agent-review-fix -->\nNo commit was needed: the branch is already synced with \`${config.git.base_branch}\` and the agent made no code changes.`,
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

    await assertPullRequestNotConflicting(octokit, owner, repo, env.PR_NUMBER);

    await postComment(
      octokit,
      owner,
      repo,
      env.PR_NUMBER,
      `<!-- agent-review-fix -->\nPushed review fixes for PR #${env.PR_NUMBER}.`,
    );

    await clearAgentResumeLabels(octokit, owner, repo, {
      issueNumber: env.ISSUE_NUMBER,
      prNumber: env.PR_NUMBER,
    });

    console.log(`\nReview fix pushed on branch ${env.AGENT_BRANCH}`);
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

runAgentMain(() =>
  runAgentPhase({
    phase: "review-fix",
    octokit,
    owner,
    repo,
    issueNumber: env.ISSUE_NUMBER,
    prNumber: env.PR_NUMBER,
    main,
  }),
);
