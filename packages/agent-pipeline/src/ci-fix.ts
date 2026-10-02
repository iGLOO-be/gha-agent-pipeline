import {
  CI_FIX_MODEL,
  buildPhaseSystemPrompt,
  loadAgentConfig,
  loadCiFixEnv,
  parseRepository,
} from "./config.js";
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
  formatFailedChecksForPrompt,
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
  resolveAgentCommitMessage,
  type PhaseReport,
} from "./phase-report.js";

function buildCiFixComment(
  body: string,
  phaseReport: PhaseReport | undefined,
  session: AgentSessionResult,
  runFriction: ReturnType<typeof createRunFrictionCollector>,
): string {
  const completion = formatPhaseCompletionMarkdown({
    phase: "ci-fix",
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
  return `<!-- agent-ci-fix -->\n${completion}`;
}

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

    const branch = process.env.AGENT_BRANCH;
    if (!branch) {
      throw new Error("AGENT_BRANCH is required to push CI fixes.");
    }

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

    let mergeContext = [
      await syncWithBaseBranch(
        config.git.base_branch,
        "Resolve these conflicts first, then fix the CI failures.",
        { force: initialForceMerge },
      ),
      "",
      "GitHub PR merge state:",
      `- mergeable_state: ${initialPrMergeState.mergeable_state}`,
      `- conflicts: ${initialPrMergeState.conflicts}`,
    ].join("\n");

    const runFriction = createRunFrictionCollector();
    const maxPasses = getUpstreamDriftMaxPasses();

    for (let pass = 0; pass < maxPasses; pass++) {
      if (pass > 0) {
        console.warn(
          `Upstream drift detected after push; starting ci-fix pass ${pass + 1}/${maxPasses}.`,
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
        mergeContext = [
          await syncWithBaseBranch(
            config.git.base_branch,
            "Resolve these conflicts with the latest base. Preserve CI fixes from the previous pass.",
            { force: forceMerge },
          ),
          "",
          "GitHub PR merge state:",
          `- mergeable_state: ${driftState.mergeable_state}`,
          `- conflicts: ${driftState.conflicts}`,
          driftState.behind_by != null
            ? `- behind_by: ${driftState.behind_by}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
      }

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

      const driftRetryPrompt =
        pass > 0
          ? `PRIORITY: ${config.git.base_branch} advanced while the previous CI-fix pass was running. Resolve merge conflicts first, then re-verify CI fixes.

`
          : "";

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
          upstreamDriftPass: pass,
        },
        prompt:
          pass === 0
            ? `Fix CI for PR #${env.PR_NUMBER} (issue #${env.ISSUE_NUMBER}).

Merge context:
${mergeContext}

Head SHA: ${env.HEAD_SHA}
Issue: ${issue.title}

Approved plan (context):
${plan ?? "(no plan comment found)"}

Failed checks:
${failedSummary}

Repository: ${env.GITHUB_REPOSITORY}`
            : `${driftRetryPrompt}Fix remaining merge issues on PR #${env.PR_NUMBER} (issue #${env.ISSUE_NUMBER}).

Merge context:
${mergeContext}

Head SHA: ${env.HEAD_SHA}

Repository: ${env.GITHUB_REPOSITORY}`,
      });

      const phaseReport = phaseReportTracker.report;

      await prepareResolvedMergeForCommit();

      const pushResult = await commitAndPushBranch(
        branch,
        resolveAgentCommitMessage(
          phaseReport,
          pass > 0
            ? `fix(ci): sync with ${config.git.base_branch} on PR #${env.PR_NUMBER}`
            : `fix(ci): address failures for PR #${env.PR_NUMBER}`,
        ),
      );

      if (pushResult.status === "noChanges") {
        await postComment(
          octokit,
          owner,
          repo,
          env.PR_NUMBER,
          buildCiFixComment(
            `No commit was needed: the branch is already synced with \`${config.git.base_branch}\` and the agent made no code changes.`,
            phaseReport,
            session,
            runFriction,
          ),
        );
        console.log(`\nCI fix completed with no changes on branch ${branch}`);
        await clearAgentResumeLabels(octokit, owner, repo, {
          issueNumber: env.ISSUE_NUMBER,
          prNumber: env.PR_NUMBER,
        });
        appendRunFrictionStepSummary(runFriction, "ci-fix");
        return;
      }

      await assertLocalMergeResolved();

      const pushedLine = `Pushed a CI fix commit for \`${env.HEAD_SHA.slice(0, 7)}\`.`;

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
          buildCiFixComment(pushedLine, phaseReport, session, runFriction),
        );
        await clearAgentResumeLabels(octokit, owner, repo, {
          issueNumber: env.ISSUE_NUMBER,
          prNumber: env.PR_NUMBER,
        });
        console.log(`\nCI fix pushed on branch ${branch}`);
        appendRunFrictionStepSummary(runFriction, "ci-fix");
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
            buildCiFixComment(
              formatMergeStillBlockedStatusLine(
                pushedLine,
                config.git.base_branch,
                error,
              ),
              phaseReport,
              session,
              runFriction,
            ),
          );
          await clearAgentResumeLabels(octokit, owner, repo, {
            issueNumber: env.ISSUE_NUMBER,
            prNumber: env.PR_NUMBER,
          });
          console.warn(
            `\nCI fix pushed on branch ${branch}, but PR is still not mergeable.`,
          );
          appendRunFrictionStepSummary(runFriction, "ci-fix");
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
