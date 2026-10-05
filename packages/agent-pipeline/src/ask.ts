import { loadClineSdk } from "./cline.js";
import {
  loadAgentConfig,
  loadAskEnv,
  parseRepository,
  ASK_MODEL,
} from "./config.js";
import {
  applyCommandGithubTools,
  prepareCommandRuntime,
} from "./command-runtime.js";
import { reportPhaseFailure } from "./report-failure.js";
import {
  runAgentMain,
  runAgentSession,
  type AgentSessionResult,
} from "./runtime.js";
import { runAgentPhase } from "./lifecycle.js";
import {
  appendRunFrictionStepSummary,
  createRunFrictionCollector,
} from "./run-friction.js";
import { formatPhaseCompletionMarkdown } from "./phase-report.js";
import {
  AGENT_COMMENT_MARKERS,
  createOctokit,
  extractAgentAnswer,
  formatCommentsForPrompt,
  prependAgentMarker,
  readComments,
  readIssue,
  updateComment,
} from "./tools/github.js";
import { createAskTools, type AnswerCommentTracker } from "./tools/index.js";
import { withReportRunFrictionTool } from "./tools/run-friction-tool.js";

const MAX_ASK_ANSWER_ATTEMPTS = 2;

async function main() {
  const env = loadAskEnv();
  const config = loadAgentConfig();
  const cmd = prepareCommandRuntime("ask", ASK_MODEL, config);
  const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
  const octokit = createOctokit(env.GITHUB_TOKEN);

  try {
    const issue = await readIssue(octokit, owner, repo, env.ISSUE_NUMBER);
    const comments = await readComments(octokit, owner, repo, env.ISSUE_NUMBER);
    const conversation = formatCommentsForPrompt(comments);
    const runFriction = createRunFrictionCollector();
    const answerComment: AnswerCommentTracker = { posted: false };

    let tools = await withReportRunFrictionTool(
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
    tools = applyCommandGithubTools(tools, cmd.resolved.tools.github);

    const question = env.QUESTION;
    const prContext = env.PR_NUMBER
      ? `\nPull request: #${env.PR_NUMBER} — use readPrComments to read the PR discussion.`
      : "";

    let session: AgentSessionResult | undefined;
    for (
      let answerAttempt = 1;
      answerAttempt <= MAX_ASK_ANSWER_ATTEMPTS;
      answerAttempt++
    ) {
      const retryNote =
        answerAttempt > 1
          ? "\n\nIMPORTANT: Your previous run did not post an answer (submitAnswer was not called). You MUST call submitAnswer with markdown starting with ## Agent answer before finishing.\n"
          : "";

      session = await runAgentSession({
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
          prNumber: env.PR_NUMBER,
          askAnswerAttempt: answerAttempt,
        },
        prompt: `Answer the following question about GitHub issue #${env.ISSUE_NUMBER} in ${env.GITHUB_REPOSITORY}.

Issue title: ${issue.title}
Issue body:
${issue.body ?? "(empty)"}

Issue conversation:
${conversation}
${prContext}
Question: ${question}${retryNote}`,
      });

      try {
        await ensureAnswerCommentPosted(
          octokit,
          owner,
          repo,
          env.ISSUE_NUMBER,
          session.outputText,
          answerComment,
        );
        break;
      } catch (error) {
        if (answerAttempt === MAX_ASK_ANSWER_ATTEMPTS) {
          throw error;
        }
        console.warn(
          `Ask run did not post an answer (attempt ${answerAttempt}/${MAX_ASK_ANSWER_ATTEMPTS}); retrying session.`,
        );
        answerComment.posted = false;
        answerComment.id = undefined;
        answerComment.body = undefined;
      }
    }

    appendRunFrictionStepSummary(runFriction, "ask");

    if (!session) {
      throw new Error("Ask agent did not run a session");
    }

    // Build a unified comment: marker + Question + answer + completion block
    const completionBlock = formatPhaseCompletionMarkdown({
      phase: "ask",
      sessionUsage: session.usage,
      sessionId: session.sessionId,
      modelId: session.modelId,
      servedModelIds: session.servedModelIds,
      openRouterCostUsd: session.openRouterCostUsd,
      iterations: session.iterations,
      toolCallsCount: session.toolCallsCount,
      runFriction,
      collapsibleMetrics: true,
      skipEmptyPhaseReportPlaceholder: true,
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

  const answerBody = extractAgentAnswer(outputText);
  if (!answerBody) {
    throw new Error(
      "Ask agent finished without posting an answer comment or producing answer output",
    );
  }

  const { postComment } = await import("./tools/github.js");
  const markedBody = prependAgentMarker(answerBody, AGENT_COMMENT_MARKERS.ask);
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
}

const env = loadAskEnv();
const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
const octokit = createOctokit(env.GITHUB_TOKEN);
const bootCmd = prepareCommandRuntime("ask", ASK_MODEL, loadAgentConfig());

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
