import {
  IMPLEMENT_MODEL,
  buildPhaseSystemPrompt,
  loadAgentConfig,
  loadAgentEnv,
  parseRepository,
} from "./config.js";
import { branchName, createAndCheckoutBranch } from "./git/branch.js";
import { commitAll, createPullRequest, pushBranch } from "./git/pr.js";
import { buildAgentPrBody } from "./pr-body.js";
import { reportPhaseFailure } from "./report-failure.js";
import { runAgentMain, runAgentSession } from "./runtime.js";
import { runAgentPhase } from "./lifecycle.js";
import { safeFormatUsageMarkdown } from "./gha-log.js";
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

async function main() {
  const env = loadAgentEnv();
  const config = loadAgentConfig();
  const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
  const octokit = createOctokit(env.GITHUB_TOKEN);

  try {
    const issue = await readIssue(octokit, owner, repo, env.ISSUE_NUMBER);
    const comments = await readComments(octokit, owner, repo, env.ISSUE_NUMBER);
    const plan = findPlanComment(comments);
    if (!plan) {
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

    const tools = await createImplementTools(
      octokit,
      owner,
      repo,
      env.ISSUE_NUMBER,
    );

    const session = await runAgentSession({
      phase: "implement",
      modelId: IMPLEMENT_MODEL,
      systemPrompt: buildPhaseSystemPrompt("implement", config),
      tools,
      sessionMetadata: {
        phase: "implement",
        issueNumber: env.ISSUE_NUMBER,
        repository: env.GITHUB_REPOSITORY,
        branch,
      },
      prompt: `Implement issue #${env.ISSUE_NUMBER}: ${issue.title}

Issue body:
${issue.body ?? "(empty)"}

Approved plan:
${plan}

Repository: ${env.GITHUB_REPOSITORY}
Branch: ${branch}`,
    });

    const committed = await commitAll(
      `feat: implement issue #${env.ISSUE_NUMBER} — ${issue.title}`,
    );
    if (!committed) {
      throw new Error("No changes were made by the implement agent.");
    }

    await pushBranch(branch);

    const usageSection = safeFormatUsageMarkdown(session.usage, {
      heading: "### Usage (implement run)",
      sessionId: session.sessionId,
      modelId: session.modelId,
    });

    const pr = await createPullRequest(
      issue.title,
      buildAgentPrBody({
        issueNumber: env.ISSUE_NUMBER,
        issueTitle: issue.title,
        issueUrl: issue.html_url,
        planCommentUrl: findPlanCommentUrl(comments),
        usageMarkdown: usageSection,
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
      usageSection ?? "",
    ].join("\n");

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

runAgentMain(() =>
  runAgentPhase({
    phase: "implement",
    octokit,
    owner,
    repo,
    issueNumber: env.ISSUE_NUMBER,
    main,
  }),
);
