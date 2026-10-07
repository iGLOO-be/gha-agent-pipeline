import {
  IMPLEMENT_MODEL,
  loadAgentConfig,
  loadAgentEnv,
  parseRepository,
} from "./config.js";
import {
  applyCommandGithubTools,
  prepareCommandRuntime,
} from "./command-runtime.js";
import { branchName, createAndCheckoutBranch } from "./git/branch.js";
import {
  formatCommitHookRetryPrompt,
  getCommitHookRetryMaxPasses,
  runCommitWithHookRetry,
} from "./git/commit-hook-retry.js";
import { commitAll, createPullRequest, pushBranch } from "./git/pr.js";
import { buildAgentPrBody } from "./pr-body.js";
import { reportPhaseFailure } from "./report-failure.js";
import {
  appendRunFrictionStepSummary,
  createRunFrictionCollector,
} from "./run-friction.js";
import { runAgentMain, runAgentSession } from "./runtime.js";
import { runAgentPhase } from "./lifecycle.js";
import {
  addLabelToIssue,
  AGENT_COMMENT_MARKERS,
  buildRunUrl,
  createOctokit,
  ensureLabel,
  findPlanComment,
  findPlanCommentUrl,
  postComment,
  prependAgentMarker,
  readComments,
  readIssue,
} from "./tools/github.js";
import { createImplementTools } from "./tools/index.js";
import { withReportRunFrictionTool } from "./tools/run-friction-tool.js";
import {
  createPhaseReportTracker,
  formatPhaseCompletionMarkdown,
  formatPhaseReportForPr,
  formatRunMetricsMarkdown,
} from "./phase-report.js";
import { chainCodeReviewAfterImplement } from "./code-review-chain.js";
import {
  isReviewLoopEnabled,
  startReviewLoopAfterImplement,
} from "./review-loop.js";

async function main() {
  const env = loadAgentEnv();
  const config = loadAgentConfig();
  const cmd = prepareCommandRuntime("implement", IMPLEMENT_MODEL, config);
  const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
  const octokit = createOctokit(env.GITHUB_TOKEN);

  try {
    const issue = await readIssue(octokit, owner, repo, env.ISSUE_NUMBER);
    const comments = await readComments(octokit, owner, repo, env.ISSUE_NUMBER);
    const plan = findPlanComment(comments);
    if (!plan && cmd.resolved.context.require_plan !== false) {
      throw new Error(
        `No plan comment found on issue #${env.ISSUE_NUMBER}. Run /agent plan first.`,
      );
    }

    const branch = branchName(
      env.ISSUE_NUMBER,
      issue.title,
      config.git.branch_prefix,
    );
    await createAndCheckoutBranch(branch, config.git.base_branch);

    const runFriction = createRunFrictionCollector();
    const phaseReportTracker = createPhaseReportTracker();
    let tools = await withReportRunFrictionTool(
      await createImplementTools(
        octokit,
        owner,
        repo,
        env.ISSUE_NUMBER,
        phaseReportTracker,
      ),
      runFriction,
    );
    tools = applyCommandGithubTools(tools, cmd.resolved.tools.github);

    const userArgs = process.env.AGENT_COMMAND_ARGS?.trim();
    const extraArgsBlock = userArgs
      ? `\n\nAdditional instructions:\n${userArgs}`
      : "";

    const implementInitialPrompt = `Implement issue #${env.ISSUE_NUMBER}: ${issue.title}

Issue body:
${issue.body ?? "(empty)"}

Approved plan:
${plan ?? "(no plan comment — proceed from issue only)"}

Repository: ${env.GITHUB_REPOSITORY}
Branch: ${branch}${extraArgsBlock}`;

    const runImplementSession = (prompt: string, commitHookRetry?: number) =>
      runAgentSession({
        phase: cmd.runtimePhase,
        modelId: cmd.modelId,
        systemPrompt: cmd.systemPrompt,
        tools,
        runFriction,
        sessionMetadata: {
          phase: cmd.runtimePhase,
          commandId: cmd.commandId,
          issueNumber: env.ISSUE_NUMBER,
          repository: env.GITHUB_REPOSITORY,
          branch,
          ...(commitHookRetry != null ? { commitHookRetry } : {}),
        },
        prompt,
      });

    let session = await runImplementSession(implementInitialPrompt);

    const commitSubject =
      cmd.resolved.git?.commit_subject ??
      `feat: implement issue #${env.ISSUE_NUMBER} — ${issue.title}`;

    const hookMaxPasses = getCommitHookRetryMaxPasses();

    await runCommitWithHookRetry({
      maxPasses: hookMaxPasses,
      commit: async () => {
        const committed = await commitAll(commitSubject);
        if (!committed) {
          throw new Error("No changes were made by the implement agent.");
        }
        await pushBranch(branch);
      },
      relaunchForHookFailure: async (hookLog, retryIndex) => {
        session = await runImplementSession(
          `${formatCommitHookRetryPrompt(hookLog)}

Repository: ${env.GITHUB_REPOSITORY}
Branch: ${branch}`,
          retryIndex,
        );
      },
    });

    appendRunFrictionStepSummary(runFriction, "implement");

    const phaseReport = phaseReportTracker.report;
    const phaseReportMarkdown = phaseReport
      ? formatPhaseReportForPr(phaseReport)
      : undefined;

    if (cmd.resolved.git?.skip_pr) {
      console.log("\nSkipping PR creation (commands.git.skip_pr).");
      return;
    }

    const usageSection = formatRunMetricsMarkdown(session, {
      collapsible: true,
    });

    const pr = await createPullRequest(
      issue.title,
      buildAgentPrBody({
        issueNumber: env.ISSUE_NUMBER,
        issueTitle: issue.title,
        issueUrl: issue.html_url,
        planCommentUrl: findPlanCommentUrl(comments),
        usageMarkdown: usageSection,
        phaseReportMarkdown,
      }),
      branch,
      config.git.pr_target,
    );

    // Add the "agent-pr" label to the PR
    await addLabelToIssue(octokit, owner, repo, pr.number, "agent-pr");

    const runUrl = buildRunUrl();
    const prOpenedBody = `PR opened by this run — ${runUrl ? `[View in GitHub Actions](${runUrl})` : "run URL unavailable"}`;
    await postComment(
      octokit,
      owner,
      repo,
      pr.number,
      prependAgentMarker(prOpenedBody, AGENT_COMMENT_MARKERS.prOpened),
    );

    const implementComment = [
      `## Agent Implementation`,
      "",
      `Pull request [#${pr.number}](${pr.url}) created.`,
      "",
      formatPhaseCompletionMarkdown({
        phase: "implement",
        phaseReport,
        sessionUsage: session.usage,
        sessionId: session.sessionId,
        modelId: session.modelId,
        servedModelIds: session.servedModelIds,
        openRouterCostUsd: session.openRouterCostUsd,
        iterations: session.iterations,
        toolCallsCount: session.toolCallsCount,
        runFriction,
      }),
    ].join("\n\n");

    await postComment(
      octokit,
      owner,
      repo,
      env.ISSUE_NUMBER,
      prependAgentMarker(implementComment, AGENT_COMMENT_MARKERS.implement),
    );

    // Add the "agent-implemented" label to the source issue
    try {
      await ensureLabel(octokit, owner, repo, "agent-implemented", {
        color: "bfdadc",
        description: "Issue has been implemented by the agent pipeline.",
      });
      await addLabelToIssue(
        octokit,
        owner,
        repo,
        env.ISSUE_NUMBER,
        "agent-implemented",
      );
    } catch (error) {
      console.warn("Failed to add agent-implemented label:", error);
      // Continue execution even if label addition fails
    }

    if (isReviewLoopEnabled(config)) {
      await startReviewLoopAfterImplement(octokit, owner, repo, {
        issueNumber: env.ISSUE_NUMBER,
        prNumber: pr.number,
        agentBranch: branch,
      });
    } else {
      await chainCodeReviewAfterImplement(octokit, owner, repo, config, {
        issueNumber: env.ISSUE_NUMBER,
        prNumber: pr.number,
        agentBranch: branch,
      });
    }

    console.log(`\nPR created: ${pr.url}`);
  } catch (error) {
    await reportPhaseFailure(
      octokit,
      owner,
      repo,
      { kind: "issue", number: env.ISSUE_NUMBER },
      "implement",
      error,
    );
    throw error;
  }
}

const env = loadAgentEnv();
const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
const octokit = createOctokit(env.GITHUB_TOKEN);
const bootCmd = prepareCommandRuntime(
  "implement",
  IMPLEMENT_MODEL,
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
    main,
  }),
);
