import {
  YOLO_MODEL,
  loadAgentConfig,
  loadAgentEnv,
  parseRepository,
} from "./config.js";
import {
  applyCommandGithubTools,
  prepareCommandRuntime,
} from "./command-runtime.js";
import {
  checkoutExistingBranch,
  createAndCheckoutBranch,
  resolveYoloBranchName,
} from "./git/branch.js";
import {
  formatCommitHookRetryPrompt,
  getCommitHookRetryMaxPasses,
  runCommitWithHookRetryForPhase,
} from "./git/commit-hook-retry.js";
import {
  commitAndPushBranch,
  createPullRequest,
  findOpenPullRequestForBranch,
} from "./git/pr.js";
import { shouldFailNoChanges } from "./git/push-outcome.js";
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
  findPlanCommentUrl,
  manageRiskLabels,
  postComment,
  prependAgentMarker,
  readComments,
  readIssue,
  type RiskLevel,
} from "./tools/github.js";
import { createAgentTools } from "./tools/index.js";
import { withReportRunFrictionTool } from "./tools/run-friction-tool.js";
import {
  appendSubmitPhaseReportTool,
  createPhaseReportTracker,
  formatPhaseCompletionMarkdown,
  formatPhaseReportForPr,
  formatRunMetricsMarkdown,
  mergeSessionMetrics,
  type PhaseReport,
  type SessionMetricsSource,
} from "./phase-report.js";
import type { AgentSessionResult } from "./runtime.js";
import type { RunFrictionCollector } from "./run-friction.js";
import {
  resolveYoloRiskAssessment,
  resolveYoloRiskSourceOutput,
} from "./yolo-risk.js";

async function postYoloIssueComment(
  octokit: ReturnType<typeof createOctokit>,
  owner: string,
  repo: string,
  issueNumber: number,
  params: {
    riskLevel: string;
    riskJustification: string;
    prLine: string;
    phaseReport: PhaseReport | undefined;
    session: SessionMetricsSource;
    runFriction: RunFrictionCollector;
  },
): Promise<void> {
  const implementComment = [
    `## Agent Implementation`,
    "",
    `**Risk score:** ${params.riskLevel} — ${params.riskJustification}`,
    "",
    params.prLine,
    "",
    formatPhaseCompletionMarkdown({
      phase: "yolo",
      phaseReport: params.phaseReport,
      sessionUsage: params.session.usage,
      sessionId: params.session.sessionId,
      modelId: params.session.modelId,
      servedModelIds: params.session.servedModelIds,
      openRouterCostUsd: params.session.openRouterCostUsd,
      iterations: params.session.iterations,
      toolCallsCount: params.session.toolCallsCount,
      runFriction: params.runFriction,
    }),
  ].join("\n\n");

  await postComment(
    octokit,
    owner,
    repo,
    issueNumber,
    prependAgentMarker(implementComment, AGENT_COMMENT_MARKERS.yolo),
  );
}

async function applyYoloRiskLabels(
  octokit: ReturnType<typeof createOctokit>,
  owner: string,
  repo: string,
  issueNumber: number,
  prNumber: number | undefined,
  riskLevel: RiskLevel,
): Promise<void> {
  try {
    await manageRiskLabels(octokit, owner, repo, issueNumber, riskLevel);
    if (prNumber !== undefined) {
      await manageRiskLabels(octokit, owner, repo, prNumber, riskLevel);
    }
  } catch (error) {
    console.warn("Failed to manage risk labels:", error);
  }
}

async function main() {
  const env = loadAgentEnv();
  const config = loadAgentConfig();
  const cmd = prepareCommandRuntime("yolo", YOLO_MODEL, config);
  const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
  const octokit = createOctokit(env.GITHUB_TOKEN);

  try {
    const issue = await readIssue(octokit, owner, repo, env.ISSUE_NUMBER);

    const branch = resolveYoloBranchName(
      env.ISSUE_NUMBER,
      issue.title,
      env.AGENT_BRANCH,
      config.git.branch_prefix,
    );
    if (env.AGENT_BRANCH) {
      await checkoutExistingBranch(branch);
    } else {
      await createAndCheckoutBranch(branch, config.git.base_branch);
    }

    const runFriction = createRunFrictionCollector();
    const phaseReportTracker = createPhaseReportTracker();
    let tools = await withReportRunFrictionTool(
      await appendSubmitPhaseReportTool(
        await createAgentTools(octokit, owner, repo, env.ISSUE_NUMBER),
        phaseReportTracker,
        { requireRiskAssessment: true },
      ),
      runFriction,
    );
    tools = applyCommandGithubTools(tools, cmd.resolved.tools.github);

    const userArgs = process.env.AGENT_COMMAND_ARGS?.trim();
    const extraArgsBlock = userArgs
      ? `\n\nAdditional instructions:\n${userArgs}`
      : "";

    const yoloInitialPrompt = `Implement issue #${env.ISSUE_NUMBER}: ${issue.title}

Issue body (implementation instructions):
${issue.body ?? "(empty)"}

Repository: ${env.GITHUB_REPOSITORY}
Branch: ${branch}${extraArgsBlock}`;

    const runYoloSession = (prompt: string, commitHookRetry?: number) =>
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

    const sessions: AgentSessionResult[] = [];
    sessions.push(await runYoloSession(yoloInitialPrompt));
    // Snapshot the implementation summary: a hook-retry relaunch session may
    // submit a report about the hook fix only, which would otherwise overwrite
    // the report the runner was asked to publish.
    const initialPhaseReport = phaseReportTracker.report;

    const commitSubject = `feat: implement issue #${env.ISSUE_NUMBER} — ${issue.title}`;
    const hookMaxPasses = getCommitHookRetryMaxPasses();

    const pushResult = await runCommitWithHookRetryForPhase({
      phase: "yolo",
      maxPasses: hookMaxPasses,
      commit: () =>
        commitAndPushBranch(branch, commitSubject, {
          baseBranch: config.git.base_branch,
        }),
      buildRelaunchPrompt: (hookLog) =>
        `${formatCommitHookRetryPrompt(hookLog)}

Repository: ${env.GITHUB_REPOSITORY}
Branch: ${branch}`,
      relaunchSession: async (prompt, retryIndex) => {
        sessions.push(await runYoloSession(prompt, retryIndex));
      },
      runFriction,
    });

    // On the success path the summary is written after the commit so friction
    // collected by hook-retry sessions is included (exhaustion is covered by the
    // wrapper, which appends before rethrowing).
    appendRunFrictionStepSummary(runFriction, "yolo");

    // Aggregate every session of this phase (initial + hook retries).
    const metrics = mergeSessionMetrics(sessions);

    const phaseReport = initialPhaseReport ?? phaseReportTracker.report;
    const phaseReportMarkdown = phaseReport
      ? formatPhaseReportForPr(phaseReport)
      : undefined;

    const { riskLevel, riskJustification } = resolveYoloRiskAssessment(
      phaseReport,
      resolveYoloRiskSourceOutput(sessions),
    );

    // Single end-of-run record: post the issue comment and apply risk labels.
    // Used by the noChanges, skip_pr and PR-created exit paths so they cannot
    // drift apart.
    const finishYoloRun = async (
      prLine: string,
      prNumber: number | undefined,
    ): Promise<void> => {
      await postYoloIssueComment(octokit, owner, repo, env.ISSUE_NUMBER, {
        riskLevel,
        riskJustification,
        prLine,
        phaseReport,
        session: metrics,
        runFriction,
      });
      await applyYoloRiskLabels(
        octokit,
        owner,
        repo,
        env.ISSUE_NUMBER,
        prNumber,
        riskLevel,
      );
    };

    if (pushResult.status === "noChanges") {
      const skipPr = cmd.resolved.git?.skip_pr === true;
      // With skip_pr the runner never opens a PR, so an absent PR is expected;
      // there, the only signal that the session produced nothing is that the
      // branch was never pushed either. Without skip_pr, an absent open PR is
      // itself a failure.
      const existingPr = skipPr
        ? null
        : await findOpenPullRequestForBranch(branch);
      const failed = shouldFailNoChanges({
        skipPr,
        remoteBranchExists: pushResult.remoteBranchExists,
        hasOpenPullRequest: existingPr !== null,
      });
      if (failed) {
        if (phaseReport?.summary) {
          console.warn(
            `yolo: submitPhaseReport was called but nothing is ahead of origin/${branch} or origin/${config.git.base_branch}.`,
          );
        }
        throw new Error(
          skipPr
            ? `No changes detected: nothing is ahead of origin/${config.git.base_branch} and branch ${branch} was never pushed.`
            : `No changes detected and no open pull request exists for branch ${branch}.`,
        );
      }

      const prLine = existingPr
        ? `No new commits were needed; work is already tracked in pull request [#${existingPr.number}](${existingPr.url}).`
        : `No new commits were needed; the branch \`${branch}\` already contains the intended changes (PR creation skipped).`;

      await finishYoloRun(prLine, existingPr?.number);

      console.log(
        existingPr
          ? `\nYolo completed with no changes on branch ${branch} (PR #${existingPr.number})`
          : `\nYolo completed with no changes on branch ${branch} (PR creation skipped)`,
      );
      return;
    }

    if (cmd.resolved.git?.skip_pr === true) {
      // No PR is created, so the issue comment is the only durable record of
      // this run. Post it (and the issue risk labels) before returning.
      await finishYoloRun(
        `Branch \`${branch}\` was committed and pushed (PR creation skipped).`,
        undefined,
      );

      console.log(`\nSkipping PR creation (commands.git.skip_pr).`);
      return;
    }

    const comments = await readComments(octokit, owner, repo, env.ISSUE_NUMBER);

    const usageSection = formatRunMetricsMarkdown(metrics, {
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
        riskLevel,
        riskJustification,
        phaseReportMarkdown,
      }),
      branch,
      config.git.pr_target,
    );

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

    try {
      await ensureLabel(octokit, owner, repo, "agent-waiting-human", {
        color: "f9d0c4",
        description: "Waiting for human decision on this issue.",
      });
      await addLabelToIssue(
        octokit,
        owner,
        repo,
        env.ISSUE_NUMBER,
        "agent-waiting-human",
      );
    } catch (error) {
      console.warn("Failed to add agent-waiting-human label:", error);
    }

    await finishYoloRun(
      `Pull request [#${pr.number}](${pr.url}) created.`,
      pr.number,
    );

    console.log(`\nPR created: ${pr.url}`);
  } catch (error) {
    await reportPhaseFailure(
      octokit,
      owner,
      repo,
      { kind: "issue", number: env.ISSUE_NUMBER },
      "yolo",
      error,
    );
    throw error;
  }
}

const env = loadAgentEnv();
const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
const octokit = createOctokit(env.GITHUB_TOKEN);
const bootCmd = prepareCommandRuntime("yolo", YOLO_MODEL, loadAgentConfig());

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
