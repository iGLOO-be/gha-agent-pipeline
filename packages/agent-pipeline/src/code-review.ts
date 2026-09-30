import { existsSync, readFileSync } from "node:fs";
import {
  loadAgentConfig,
  buildPhaseSystemPrompt,
  loadCodeReviewEnv,
  parseRepository,
  CODE_REVIEW_MODEL,
} from "./config.js";
import {
  collectReviewDiff,
  collectReviewDiffSince,
} from "./git/review-diff.js";
import {
  buildCodeReviewFollowUpContext,
  formatFollowUpPromptSection,
  getCodeReviewFollowUpMode,
} from "./review-follow-up.js";
import {
  formatPathInstructionsForPrompt,
  resolveReviewConfig,
} from "./review-config.js";
import {
  effectivePathFilters,
  partitionChangedFiles,
} from "./review-path-filters.js";
import {
  formatReviewFileScopeMarkdown,
  parseReviewBodyFromAgentOutput,
} from "./review-prompt.js";
import { reportPhaseFailure } from "./report-failure.js";
import { runAgentMain, runAgentSession } from "./runtime.js";
import { runAgentPhase } from "./lifecycle.js";
import {
  appendRunFrictionStepSummary,
  createRunFrictionCollector,
} from "./run-friction.js";
import { buildCodeReviewPhaseComment } from "./code-review-completion.js";
import {
  AGENT_COMMENT_MARKERS,
  createOctokit,
  createPullRequestReview,
  formatCommentsForPrompt,
  postComment,
  prependAgentMarker,
  readComments,
  readIssue,
  type PullRequestReviewEvent,
} from "./tools/github.js";
import { createCodeReviewTools, type ReviewTracker } from "./tools/index.js";
import { withReportRunFrictionTool } from "./tools/run-friction-tool.js";

const STANDARD_FILES = ["AGENTS.md", "README.md", "CONTRIBUTING.md"] as const;
const MAX_STANDARD_FILE_CHARS = 8_000;

function loadStandardsSources(): string {
  const parts: string[] = [];
  for (const path of STANDARD_FILES) {
    if (!existsSync(path)) {
      continue;
    }
    const raw = readFileSync(path, "utf8");
    const body =
      raw.length > MAX_STANDARD_FILE_CHARS
        ? `${raw.slice(0, MAX_STANDARD_FILE_CHARS)}\n\n…(truncated)`
        : raw;
    parts.push(`### ${path}\n\n${body}`);
  }
  return parts.length > 0
    ? parts.join("\n\n")
    : "(no documented standards files found)";
}

function parseReviewFromOutput(outputText: string): {
  event: PullRequestReviewEvent;
  body: string;
} | null {
  const body = parseReviewBodyFromAgentOutput(outputText);
  if (!body) {
    return null;
  }
  return {
    event: "COMMENT",
    body,
  };
}

async function main() {
  const env = loadCodeReviewEnv();
  const config = loadAgentConfig();
  const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
  const octokit = createOctokit(env.GITHUB_TOKEN);

  try {
    const [issue, prResponse, comments] = await Promise.all([
      readIssue(octokit, owner, repo, env.ISSUE_NUMBER),
      octokit.pulls.get({
        owner,
        repo,
        pull_number: env.PR_NUMBER,
      }),
      readComments(octokit, owner, repo, env.ISSUE_NUMBER),
    ]);
    const pr = prResponse.data;
    const conversation = formatCommentsForPrompt(comments);
    const reviewDiff = await collectReviewDiff(config.git.base_branch);
    const reviewConfig = resolveReviewConfig(config);
    const pathFilters = effectivePathFilters(
      reviewConfig.path_filters,
      reviewConfig.apply_default_ignores,
    );
    const fileScope = partitionChangedFiles(reviewDiff.files, pathFilters);
    const pathInstructionsBlock = formatPathInstructionsForPrompt(
      reviewConfig.path_instructions,
      fileScope.reviewed,
    );
    const fileScopeMarkdown = formatReviewFileScopeMarkdown(
      fileScope.reviewed,
      fileScope.ignored,
    );
    const standardsSources = loadStandardsSources();
    const runFriction = createRunFrictionCollector();
    const review: ReviewTracker = { posted: false };
    const followUpMode = getCodeReviewFollowUpMode(config);
    const followUpEnabled = followUpMode !== "off";
    let followUpSection = "";
    let deltaSection = "";

    if (followUpEnabled) {
      const followUpContext = await buildCodeReviewFollowUpContext(
        octokit,
        owner,
        repo,
        env.PR_NUMBER,
        followUpMode,
      );
      followUpSection = `\n${formatFollowUpPromptSection(followUpContext)}\n`;

      if (followUpContext.lastAgentReview?.commitSha) {
        try {
          const sinceDiff = await collectReviewDiffSince(
            followUpContext.lastAgentReview.commitSha,
          );
          deltaSection = `
Changes since last agent code review (${followUpContext.lastAgentReview.commitSha}..HEAD):
Commits:
${sinceDiff.log}

Files:
${sinceDiff.files.length > 0 ? sinceDiff.files.map((file) => `- ${file}`).join("\n") : "(no files changed)"}
${sinceDiff.truncated ? "\nThe delta diff below was truncated; use read_files for full context.\n" : ""}
\`\`\`diff
${sinceDiff.diff || "(empty diff)"}
\`\`\`
`;
        } catch (error) {
          followUpSection += `\n(Could not compute delta diff since last agent review: ${error instanceof Error ? error.message : String(error)})\n`;
        }
      }
    }

    const tools = await withReportRunFrictionTool(
      await createCodeReviewTools(
        octokit,
        owner,
        repo,
        env.ISSUE_NUMBER,
        env.PR_NUMBER,
        review,
        { followUpEnabled },
      ),
      runFriction,
    );

    const extraInstructions = env.REVIEW_INSTRUCTIONS
      ? `\nAdditional instructions from the human:\n${env.REVIEW_INSTRUCTIONS}\n`
      : "";

    const session = await runAgentSession({
      phase: "code-review",
      modelId: CODE_REVIEW_MODEL,
      systemPrompt: buildPhaseSystemPrompt("code-review", config),
      tools,
      runFriction,
      sessionMetadata: {
        phase: "code-review",
        issueNumber: env.ISSUE_NUMBER,
        repository: env.GITHUB_REPOSITORY,
        prNumber: env.PR_NUMBER,
      },
      prompt: `Review pull request #${env.PR_NUMBER} in ${env.GITHUB_REPOSITORY} against origin/${reviewDiff.baseBranch}.

Source issue #${env.ISSUE_NUMBER}: ${issue.title}
Issue body:
${issue.body ?? "(empty)"}

Issue conversation:
${conversation}

Pull request title: ${pr.title}
Pull request body:
${pr.body ?? "(empty)"}
${followUpSection}${deltaSection}${extraInstructions}
Documented standards sources:
${standardsSources}

Commits (origin/${reviewDiff.baseBranch}..HEAD):
${reviewDiff.log}

${fileScopeMarkdown}
${pathInstructionsBlock ? `\n${pathInstructionsBlock}\n` : ""}
${reviewDiff.truncated ? "\nThe unified diff below was truncated; use read_files / search_codebase for reviewed files not shown.\n" : ""}
Unified diff (origin/${reviewDiff.baseBranch}...HEAD):
\`\`\`diff
${reviewDiff.diff || "(empty diff)"}
\`\`\``,
    });

    appendRunFrictionStepSummary(runFriction, "code-review");

    await ensureReviewPosted(
      octokit,
      owner,
      repo,
      env.PR_NUMBER,
      session.outputText,
      review,
    );

    if (review.posted) {
      await postComment(
        octokit,
        owner,
        repo,
        env.PR_NUMBER,
        buildCodeReviewPhaseComment({
          reviewHtmlUrl: review.htmlUrl,
          sessionUsage: session.usage,
          sessionId: session.sessionId,
          modelId: session.modelId,
          iterations: session.iterations,
          toolCallsCount: session.toolCallsCount,
          runFriction,
        }),
      );
    }

    console.log("\nCode-review agent completed.");
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
      "code-review",
      error,
    );
    throw error;
  }
}

async function ensureReviewPosted(
  octokit: ReturnType<typeof createOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  outputText: string,
  review: ReviewTracker,
) {
  if (review.posted) {
    return;
  }

  const parsed = parseReviewFromOutput(outputText);
  if (!parsed) {
    console.warn(
      "Agent session ended without submitReview and no ## Standards section found in output.",
    );
    return;
  }

  const markedBody = prependAgentMarker(
    parsed.body,
    AGENT_COMMENT_MARKERS.codeReview,
  );
  const posted = await createPullRequestReview(octokit, owner, repo, prNumber, {
    event: parsed.event,
    body: markedBody,
  });
  review.posted = true;
  review.id = posted.id;
  review.body = markedBody;
  review.htmlUrl = posted.html_url;
  console.log("Posted code review from agent output fallback.");
}

const env = loadCodeReviewEnv();
const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
const octokit = createOctokit(env.GITHUB_TOKEN);

runAgentMain(() =>
  runAgentPhase({
    phase: "code-review",
    octokit,
    owner,
    repo,
    issueNumber: env.ISSUE_NUMBER,
    prNumber: env.PR_NUMBER,
    main,
  }),
);
