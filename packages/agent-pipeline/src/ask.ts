import { loadClineSdk } from "./cline.js";
import {
  loadAgentConfig,
  buildPhaseSystemPrompt,
  loadAskEnv,
  parseRepository,
  ASK_MODEL,
} from "./config.js";
import { reportPhaseFailure } from "./report-failure.js";
import { runAgentMain, runAgentSession } from "./runtime.js";
import { runAgentPhase } from "./lifecycle.js";
import {
  appendRunFrictionStepSummary,
  createRunFrictionCollector,
} from "./run-friction.js";
import { formatPhaseCompletionMarkdown } from "./phase-report.js";
import {
  AGENT_COMMENT_MARKERS,
  createOctokit,
  formatCommentsForPrompt,
  prependAgentMarker,
  readComments,
  readIssue,
  updateComment,
} from "./tools/github.js";
import { createAskTools, type AnswerCommentTracker } from "./tools/index.js";
import { withReportRunFrictionTool } from "./tools/run-friction-tool.js";

async function main() {
  const env = loadAskEnv();
  const config = loadAgentConfig();
  const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
  const octokit = createOctokit(env.GITHUB_TOKEN);

  try {
    const issue = await readIssue(octokit, owner, repo, env.ISSUE_NUMBER);
    const comments = await readComments(octokit, owner, repo, env.ISSUE_NUMBER);
    const conversation = formatCommentsForPrompt(comments);
    const runFriction = createRunFrictionCollector();
    const answerComment: AnswerCommentTracker = { posted: false };

    const tools = await withReportRunFrictionTool(
      await createAskTools(
        octokit,
        owner,
        repo,
        env.ISSUE_NUMBER,
        answerComment,
        env.PR_NUMBER,
      ),
      runFriction,
    );

    const question = env.QUESTION;
    const prContext = env.PR_NUMBER
      ? `\nPull request: #${env.PR_NUMBER} — use readPrComments to read the PR discussion.`
      : "";

    const session = await runAgentSession({
      phase: "ask",
      modelId: ASK_MODEL,
      systemPrompt: buildPhaseSystemPrompt("ask", config),
      tools,
      runFriction,
      sessionMetadata: {
        phase: "ask",
        issueNumber: env.ISSUE_NUMBER,
        repository: env.GITHUB_REPOSITORY,
        prNumber: env.PR_NUMBER,
      },
      prompt: `Answer the following question about GitHub issue #${env.ISSUE_NUMBER} in ${env.GITHUB_REPOSITORY}.

Issue title: ${issue.title}
Issue body:
${issue.body ?? "(empty)"}

Issue conversation:
${conversation}
${prContext}
Question: ${question}`,
    });

    appendRunFrictionStepSummary(runFriction, "ask");

    await ensureAnswerCommentPosted(
      octokit,
      owner,
      repo,
      env.ISSUE_NUMBER,
      session.outputText,
      answerComment,
    );

    // Build a unified comment: marker + Question + answer + completion block
    const completionBlock = formatPhaseCompletionMarkdown({
      phase: "ask",
      sessionUsage: session.usage,
      sessionId: session.sessionId,
      modelId: session.modelId,
      iterations: session.iterations,
      toolCallsCount: session.toolCallsCount,
      runFriction,
      collapsibleMetrics: true,
    });

    if (answerComment.id && answerComment.body) {
      try {
        const markerLine = "<!-- agent-ask -->";
        let answerContent = answerComment.body;
        if (answerContent.startsWith(markerLine)) {
          answerContent = answerContent.slice(markerLine.length).trimStart();
        }
        const newBody = [
          markerLine,
          "",
          "**Question:** " + question,
          "",
          answerContent,
          "",
          completionBlock,
        ].join("\n");
        await updateComment(octokit, owner, repo, answerComment.id, newBody);
      } catch (error) {
        console.warn(
          "Failed to append completion block to answer comment:",
          error,
        );
      }
    }

    console.log("\nAsk agent completed.");
  } catch (error) {
    await reportPhaseFailure(
      octokit,
      owner,
      repo,
      { kind: "issue", number: env.ISSUE_NUMBER },
      "ask",
      error,
    );
    throw error;
  }
}

async function ensureAnswerCommentPosted(
  octokit: ReturnType<typeof createOctokit>,
  owner: string,
  repo: string,
  issueNumber: number,
  outputText: string,
  answerComment: AnswerCommentTracker,
) {
  if (answerComment.posted) {
    return;
  }

  // Fallback: parse outputText for ## Agent answer
  const answerMatch = outputText.match(
    /(## Agent answer[\s\S]*?)(?=\n##\s|\n---|\n<!--|$)/,
  );
  if (answerMatch) {
    const body = answerMatch[1].trim();
    const { postComment } = await import("./tools/github.js");
    const markedBody = prependAgentMarker(body, AGENT_COMMENT_MARKERS.ask);
    const comment = await postComment(
      octokit,
      owner,
      repo,
      issueNumber,
      markedBody,
    );
    answerComment.posted = true;
    answerComment.id = comment.id;
    answerComment.body = markedBody;
    console.log("Posted answer comment from agent output fallback.");
  } else {
    console.warn(
      "Agent session ended without submitAnswer and no ## Agent answer found in output.",
    );
  }
}

const env = loadAskEnv();
const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
const octokit = createOctokit(env.GITHUB_TOKEN);

runAgentMain(() =>
  runAgentPhase({
    phase: "ask",
    octokit,
    owner,
    repo,
    issueNumber: env.ISSUE_NUMBER,
    prNumber: env.PR_NUMBER,
    main,
  }),
);
