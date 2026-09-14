import { loadClineSdk } from "./cline.js";
import {
  loadAgentConfig,
  buildPhaseSystemPrompt,
  loadAgentEnv,
  parseRepository,
  PLAN_MODEL,
} from "./config.js";
import { safeFormatUsageMarkdown } from "./gha-log.js";
import { reportPhaseFailure } from "./report-failure.js";
import { runAgentMain, runAgentSession } from "./runtime.js";
import { runAgentPhase } from "./lifecycle.js";
import {
  addLabelToIssue,
  AGENT_COMMENT_MARKERS,
  createOctokit,
  ensureLabel,
  extractAgentPlan,
  findPlanComment,
  formatCommentsForPrompt,
  manageRiskLabels,
  normalizeAgentPlanBody,
  parseRiskLevel,
  postComment,
  prependAgentMarker,
  readComments,
  readIssue,
  updateComment,
} from "./tools/github.js";
import { createAgentTools } from "./tools/index.js";

type PlanCommentTracker = {
  posted: boolean;
  id?: number;
  body?: string;
};

async function createPlanTools(
  octokit: ReturnType<typeof createOctokit>,
  owner: string,
  repo: string,
  issueNumber: number,
  planComment: PlanCommentTracker,
) {
  const { createTool } = await loadClineSdk();
  const baseTools = await createAgentTools(octokit, owner, repo, issueNumber);
  const exploreTools = baseTools.filter((tool) => tool.name !== "postComment");

  const submitPlan = createTool({
    name: "submitPlan",
    description:
      "Post the implementation plan as an issue comment. Required on every run — even when re-posting an unchanged plan. The run is incomplete until you call this.",
    inputSchema: {
      type: "object",
      properties: {
        body: {
          type: "string",
          description: "Markdown plan starting with ## Agent Plan",
        },
      },
      required: ["body"],
    },
    lifecycle: { completesRun: true },
    async execute(input: { body: string }) {
      const normalizedBody = normalizeAgentPlanBody(input.body);
      const markedBody = prependAgentMarker(
        normalizedBody,
        AGENT_COMMENT_MARKERS.plan,
      );
      const comment = await postComment(
        octokit,
        owner,
        repo,
        issueNumber,
        markedBody,
      );

      // Add the "agent-plan" label to the issue
      try {
        await addLabelToIssue(octokit, owner, repo, issueNumber, "agent-plan");
      } catch (error) {
        console.warn("Failed to add agent-plan label:", error);
        // Continue execution even if label addition fails
      }

      // Add the "agent-waiting-human" label to indicate the plan needs review
      try {
        await ensureLabel(octokit, owner, repo, "agent-waiting-human", {
          color: "f9d0c4",
          description: "Waiting for human decision on this issue.",
        });
        await addLabelToIssue(
          octokit,
          owner,
          repo,
          issueNumber,
          "agent-waiting-human",
        );
      } catch (error) {
        console.warn("Failed to add agent-waiting-human label:", error);
        // Continue execution even if label addition fails
      }

      // Manage risk label based on the plan's risk score
      const parsedRiskLevel = parseRiskLevel(normalizedBody);
      if (!parsedRiskLevel) {
        console.warn(
          "Could not parse risk level from plan; defaulting to medium.",
        );
      }
      const riskLevel = parsedRiskLevel ?? "medium";
      try {
        await manageRiskLabels(octokit, owner, repo, issueNumber, riskLevel);
      } catch (error) {
        console.warn("Failed to manage risk labels:", error);
      }

      planComment.posted = true;
      planComment.id = comment.id;
      planComment.body = markedBody;
      return { posted: true };
    },
  });

  return [...exploreTools, submitPlan];
}

async function ensurePlanCommentPosted(
  octokit: ReturnType<typeof createOctokit>,
  owner: string,
  repo: string,
  issueNumber: number,
  outputText: string,
  planComment: PlanCommentTracker,
): Promise<void> {
  if (planComment.posted) {
    return;
  }

  const planBody = extractAgentPlan(outputText);
  if (!planBody) {
    throw new Error(
      "Plan agent finished without posting a plan comment or producing plan output",
    );
  }

  const markedBody = prependAgentMarker(planBody, AGENT_COMMENT_MARKERS.plan);
  const comment = await postComment(
    octokit,
    owner,
    repo,
    issueNumber,
    markedBody,
  );

  // Add the "agent-plan" label to the issue
  try {
    await addLabelToIssue(octokit, owner, repo, issueNumber, "agent-plan");
  } catch (error) {
    console.warn("Failed to add agent-plan label:", error);
    // Continue execution even if label addition fails
  }

  // Add the "agent-waiting-human" label to indicate the plan needs review
  try {
    await ensureLabel(octokit, owner, repo, "agent-waiting-human", {
      color: "f9d0c4",
      description: "Waiting for human decision on this issue.",
    });
    await addLabelToIssue(
      octokit,
      owner,
      repo,
      issueNumber,
      "agent-waiting-human",
    );
  } catch (error) {
    console.warn("Failed to add agent-waiting-human label:", error);
    // Continue execution even if label addition fails
  }

  // Manage risk label based on the plan's risk score
  const parsedRiskLevel = parseRiskLevel(planBody);
  if (!parsedRiskLevel) {
    console.warn(
      "Could not parse risk level from plan output; defaulting to medium.",
    );
  }
  const riskLevel = parsedRiskLevel ?? "medium";
  try {
    await manageRiskLabels(octokit, owner, repo, issueNumber, riskLevel);
  } catch (error) {
    console.warn("Failed to manage risk labels:", error);
  }

  planComment.posted = true;
  planComment.id = comment.id;
  planComment.body = markedBody;

  console.log("Posted plan comment from agent output fallback.");
}

async function main() {
  const env = loadAgentEnv();
  const config = loadAgentConfig();
  const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
  const octokit = createOctokit(env.GITHUB_TOKEN);

  try {
    const issue = await readIssue(octokit, owner, repo, env.ISSUE_NUMBER);
    const comments = await readComments(octokit, owner, repo, env.ISSUE_NUMBER);
    const priorPlan = findPlanComment(comments);
    const conversation = formatCommentsForPrompt(comments);
    const planComment: PlanCommentTracker = { posted: false };

    const tools = await createPlanTools(
      octokit,
      owner,
      repo,
      env.ISSUE_NUMBER,
      planComment,
    );

    const revisionNote = priorPlan
      ? "A prior ## Agent Plan comment exists. Read all comments. If human feedback asks for changes, post a revised plan. If not, you must still call submitPlan — repost the existing plan (or a refreshed copy) rather than ending in chat."
      : "This is the initial plan for the issue. You must call submitPlan before finishing.";

    const session = await runAgentSession({
      phase: "plan",
      modelId: PLAN_MODEL,
      systemPrompt: buildPhaseSystemPrompt("plan", config),
      tools,
      sessionMetadata: {
        phase: "plan",
        issueNumber: env.ISSUE_NUMBER,
        repository: env.GITHUB_REPOSITORY,
      },
      prompt: `${revisionNote}

Create an implementation plan for GitHub issue #${env.ISSUE_NUMBER} in ${env.GITHUB_REPOSITORY}.

Issue title: ${issue.title}
Issue body:
${issue.body ?? "(empty)"}

Issue conversation so far:
${conversation}`,
    });

    await ensurePlanCommentPosted(
      octokit,
      owner,
      repo,
      env.ISSUE_NUMBER,
      session.outputText,
      planComment,
    );

    const usageSection = safeFormatUsageMarkdown(session.usage, {
      heading: "### Usage (plan run)",
      sessionId: session.sessionId,
      modelId: session.modelId,
      iterations: session.iterations,
      toolCallsCount: session.toolCallsCount,
    });
    if (usageSection && planComment.id && planComment.body) {
      try {
        await updateComment(
          octokit,
          owner,
          repo,
          planComment.id,
          planComment.body + "\n\n" + usageSection,
        );
      } catch (error) {
        console.warn("Failed to append usage to plan comment:", error);
      }
    }

    console.log("\nPlan agent completed.");
  } catch (error) {
    await reportPhaseFailure(
      octokit,
      owner,
      repo,
      { kind: "issue", number: env.ISSUE_NUMBER },
      "plan",
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
    phase: "plan",
    octokit,
    owner,
    repo,
    issueNumber: env.ISSUE_NUMBER,
    main,
  }),
);
