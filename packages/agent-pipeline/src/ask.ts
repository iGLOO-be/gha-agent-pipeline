import { loadClineSdk } from "./cline.js";
import {
  loadAgentConfig,
  buildPhaseSystemPrompt,
  loadAskEnv,
  parseRepository,
  ASK_MODEL,
} from "./config.js";
import { safeFormatUsageMarkdown } from "./gha-log.js";
import { reportPhaseFailure } from "./report-failure.js";
import { runAgentMain, runAgentSession } from "./runtime.js";
import { runAgentPhase } from "./lifecycle.js";
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

async function main() {
  const env = loadAskEnv();
  const config = loadAgentConfig();
  const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
  const octokit = createOctokit(env.GITHUB_TOKEN);

  try {
    const issue = await readIssue(octokit, owner, repo, env.ISSUE_NUMBER);
    const comments = await readComments(octokit, owner, repo, env.ISSUE_NUMBER);
    const conversation = formatCommentsForPrompt(comments);
    const answerComment: AnswerCommentTracker = { posted: false };

    const tools = await createAskTools(
      octokit,
      owner,
      repo,
      env.ISSUE_NUMBER,
      answerComment,
      env.PR_NUMBER,
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

    await ensureAnswerCommentPosted(
      octokit,
      owner,
      repo,
      env.ISSUE_NUMBER,
      session.outputText,
      answerComment,
    );

    const usageSection = safeFormatUsageMarkdown(session.usage, {
      heading: "### Usage (ask run)",
      sessionId: session.sessionId,
      modelId: session.modelId,
      iterations: session.iterations,
      toolCallsCount: session.toolCallsCount,
    });
    if (usageSection && answerComment.id && answerComment.body) {
      try {
        await updateComment(
          octokit,
          owner,
          repo,
          answerComment.id,
          answerComment.body + "\n\n" + usageSection,
        );
      } catch (error) {
        console.warn("Failed to append usage to answer comment:", error);
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
