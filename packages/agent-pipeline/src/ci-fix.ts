import {
  CI_FIX_MODEL,
  buildPhaseSystemPrompt,
  loadAgentConfig,
  loadCiFixEnv,
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
import {
  appendRunFrictionStepSummary,
  createRunFrictionCollector,
} from "./run-friction.js";
import { runAgentMain, runAgentSession } from "./runtime.js";
import { runAgentPhase } from "./lifecycle.js";
import {
  clearAgentResumeLabels,
  createOctokit,
  findPlanComment,
  formatFailedChecksForPrompt,
  assertPullRequestNotConflicting,
  hasAgentBlockedComment,
  postComment,
  readCheckRuns,
  readComments,
  getPullRequestMergeState,
  readIssue,
} from "./tools/github.js";
import { createCiFixTools } from "./tools/index.js";
import { withReportRunFrictionTool } from "./tools/run-friction-tool.js";
import {
  createPhaseReportTracker,
  formatPhaseCompletionMarkdown,
} from "./phase-report.js";

async function main() {
  const env = loadCiFixEnv();
  const config = loadAgentConfig();
  const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
  const octokit = createOctokit(env.GITHUB_TOKEN);

  try {
    if (await hasAgentBlockedComment(octokit, owner, repo, env.PR_NUMBER)) {
      console.log(
        `PR #${env.PR_NUMBER} has <!-- agent-blocked --> marker; aborting CI fix.`,
      );
      return;
    }

    const issue = await readIssue(octokit, owner, repo, env.ISSUE_NUMBER);
    const comments = await readComments(octokit, owner, repo, env.ISSUE_NUMBER);
    const plan = findPlanComment(comments);
    const checkRuns = await readCheckRuns(octokit, owner, repo, env.HEAD_SHA);
    const failedSummary = formatFailedChecksForPrompt(checkRuns);

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
        "Resolve these conflicts first, then fix the CI failures.",
        { force: forceMerge },
      ),
      "",
      "GitHub PR merge state:",
      `- mergeable_state: ${prMergeState.mergeable_state}`,
      `- conflicts: ${prMergeState.conflicts}`,
    ].join("\n");

    const runFriction = createRunFrictionCollector();
    const phaseReportTracker = createPhaseReportTracker();
    const tools = await withReportRunFrictionTool(
      await createCiFixTools(
        octokit,
        owner,
        repo,
        env.ISSUE_NUMBER,
        env.PR_NUMBER,
        env.HEAD_SHA,
        phaseReportTracker,
      ),
      runFriction,
    );

    const session = await runAgentSession({
      phase: "ci-fix",
      modelId: CI_FIX_MODEL,
      systemPrompt: buildPhaseSystemPrompt("ci-fix", config),
      tools,
      runFriction,
      sessionMetadata: {
        phase: "ci-fix",
        issueNumber: env.ISSUE_NUMBER,
        prNumber: env.PR_NUMBER,
        headSha: env.HEAD_SHA,
        repository: env.GITHUB_REPOSITORY,
      },
      prompt: `Fix CI for PR #${env.PR_NUMBER} (issue #${env.ISSUE_NUMBER}).

Merge context:
${mergeContext}

Head SHA: ${env.HEAD_SHA}
Issue: ${issue.title}

Approved plan (context):
${plan ?? "(no plan comment found)"}

Failed checks:
${failedSummary}

Repository: ${env.GITHUB_REPOSITORY}`,
    });

    appendRunFrictionStepSummary(runFriction, "ci-fix");

    const phaseReport = phaseReportTracker.report;

    await prepareResolvedMergeForCommit();

    const branch = process.env.AGENT_BRANCH;
    if (!branch) {
      throw new Error("AGENT_BRANCH is required to push CI fixes.");
    }

    const pushResult = await commitAndPushBranch(
      branch,
      `fix(ci): address failures for PR #${env.PR_NUMBER}`,
    );

    const buildCiFixComment = (body: string): string => {
      const completion = formatPhaseCompletionMarkdown({
        phase: "ci-fix",
        statusLine: body,
        phaseReport,
        sessionUsage: session.usage,
        sessionId: session.sessionId,
        modelId: session.modelId,
        iterations: session.iterations,
        toolCallsCount: session.toolCallsCount,
        runFriction,
      });
      return `<!-- agent-ci-fix -->\n${completion}`;
    };

    if (pushResult.status === "noChanges") {
      await postComment(
        octokit,
        owner,
        repo,
        env.PR_NUMBER,
        buildCiFixComment(
          `No commit was needed: the branch is already synced with \`${config.git.base_branch}\` and the agent made no code changes.`,
        ),
      );
      console.log(`\nCI fix completed with no changes on branch ${branch}`);
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
      buildCiFixComment(
        `Pushed a CI fix commit for \`${env.HEAD_SHA.slice(0, 7)}\`.`,
      ),
    );

    await clearAgentResumeLabels(octokit, owner, repo, {
      issueNumber: env.ISSUE_NUMBER,
      prNumber: env.PR_NUMBER,
    });

    console.log(`\nCI fix pushed on branch ${branch}`);
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
      "ci-fix",
      error,
    );
    throw error;
  }
}

const env = loadCiFixEnv();
const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
const octokit = createOctokit(env.GITHUB_TOKEN);

runAgentMain(() =>
  runAgentPhase({
    phase: "ci-fix",
    octokit,
    owner,
    repo,
    issueNumber: env.ISSUE_NUMBER,
    prNumber: env.PR_NUMBER,
    main,
  }),
);
