import type { Octokit } from "@octokit/rest";
import { loadClineSdk } from "../cline.js";
import { readCacheValue, writeCacheValue } from "../state/cache.js";
import {
  addLabelToIssue,
  AGENT_COMMENT_MARKERS,
  createPullRequestReview,
  getPullRequestMergeState,
  postComment,
  prependAgentMarker,
  readCheckLogs,
  readCheckRuns,
  readComments,
  readIssue,
  truncateCommentBodyForAgent,
  type PullRequestReviewCommentInput,
  type PullRequestReviewEvent,
} from "./github.js";
import { getConflictFiles } from "../git/sync.js";
import { listFiles } from "./list-files.js";
import {
  appendSubmitPhaseReportTool,
  type PhaseReportTracker,
} from "../phase-report.js";

export async function createAgentTools(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
) {
  const { createTool } = await loadClineSdk();

  const readIssueTool = createTool({
    name: "readIssue",
    description: "Read the GitHub issue title and body.",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      const issue = await readIssue(octokit, owner, repo, issueNumber);
      return {
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        state: issue.state,
        labels: issue.labels.map((label) =>
          typeof label === "string" ? label : label.name,
        ),
      };
    },
  });

  const readCommentsTool = createTool({
    name: "readComments",
    description: "Read all comments on the GitHub issue.",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      const comments = await readComments(octokit, owner, repo, issueNumber);
      return comments.map((comment) => ({
        id: comment.id,
        author: comment.user?.login ?? "unknown",
        body: truncateCommentBodyForAgent(comment.body ?? ""),
        createdAt: comment.created_at,
      }));
    },
  });

  const listFilesTool = createTool({
    name: "list_files",
    description:
      "List directory contents relative to the repo root. Supports recursive listing and respects .gitignore plus default ignores.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to list (defaults to repository root)",
        },
        recursive: {
          type: "boolean",
          description: "Whether to list recursively",
        },
        limit: {
          type: "number",
          description: "Maximum entries to return (default 200, max 1000)",
        },
      },
    },
    async execute(input: {
      path?: string;
      recursive?: boolean;
      limit?: number;
    }) {
      const entries = listFiles(process.cwd(), input);
      return { entries };
    },
  });

  const postCommentTool = createTool({
    name: "postComment",
    description: "Post a comment on the GitHub issue.",
    inputSchema: {
      type: "object",
      properties: {
        body: {
          type: "string",
          description: "Markdown body for the issue comment",
        },
      },
      required: ["body"],
    },
    async execute(input: { body: string }) {
      const comment = await postComment(
        octokit,
        owner,
        repo,
        issueNumber,
        input.body,
      );
      return { id: comment.id, url: comment.html_url };
    },
  });

  const addLabelTool = createTool({
    name: "addLabel",
    description: "Add a label to the GitHub issue.",
    inputSchema: {
      type: "object",
      properties: {
        labelName: {
          type: "string",
          description: "Name of the label to add to the issue",
        },
      },
      required: ["labelName"],
    },
    async execute(input: { labelName: string }) {
      const labels = await addLabelToIssue(
        octokit,
        owner,
        repo,
        issueNumber,
        input.labelName,
      );
      return { added: true, labels: labels.map((label) => label.name) };
    },
  });

  return [
    readIssueTool,
    readCommentsTool,
    listFilesTool,
    postCommentTool,
    addLabelTool,
  ];
}

export async function createImplementTools(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  tracker?: PhaseReportTracker,
) {
  const baseTools = await createAgentTools(octokit, owner, repo, issueNumber);
  const withoutPost = baseTools.filter((tool) => tool.name !== "postComment");
  if (tracker) {
    return appendSubmitPhaseReportTool(withoutPost, tracker);
  }
  return withoutPost;
}

export async function createCiFixTools(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  prNumber: number,
  headSha: string,
  tracker?: PhaseReportTracker,
) {
  const { createTool } = await loadClineSdk();
  const baseTools = await createAgentTools(octokit, owner, repo, issueNumber);

  const postPrCommentTool = createTool({
    name: "postComment",
    description: "Post a comment on the pull request.",
    inputSchema: {
      type: "object",
      properties: {
        body: {
          type: "string",
          description: "Markdown body for the PR comment",
        },
      },
      required: ["body"],
    },
    async execute(input: { body: string }) {
      const comment = await postComment(
        octokit,
        owner,
        repo,
        prNumber,
        input.body,
      );
      return { id: comment.id, url: comment.html_url };
    },
  });

  const readCheckRunsTool = createTool({
    name: "readCheckRuns",
    description: "List check runs for the current PR head commit.",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return readCheckRuns(octokit, owner, repo, headSha);
    },
  });

  const readCheckLogsTool = createTool({
    name: "readCheckLogs",
    description: "Read logs and output for a check run by id.",
    inputSchema: {
      type: "object",
      properties: {
        checkRunId: {
          type: "number",
          description: "Check run id from readCheckRuns",
        },
      },
      required: ["checkRunId"],
    },
    async execute(input: { checkRunId: number }) {
      const text = await readCheckLogs(octokit, owner, repo, input.checkRunId);
      return { checkRunId: input.checkRunId, logs: text };
    },
  });

  const getCacheTool = createTool({
    name: "getCache",
    description:
      "Read a string value from agent state cache (7-day retention in CI).",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Cache key" },
      },
      required: ["key"],
    },
    async execute(input: { key: string }) {
      const value = await readCacheValue(input.key);
      return { key: input.key, value };
    },
  });

  const setCacheTool = createTool({
    name: "setCache",
    description:
      "Write a string value to agent state cache (7-day retention in CI).",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Cache key" },
        value: { type: "string", description: "Value to store" },
      },
      required: ["key", "value"],
    },
    async execute(input: { key: string; value: string }) {
      await writeCacheValue(input.key, input.value);
      return { key: input.key, stored: true };
    },
  });

  const withoutPost = baseTools.filter((tool) => tool.name !== "postComment");

  const tools = [
    ...withoutPost,
    postPrCommentTool,
    readCheckRunsTool,
    readCheckLogsTool,
    getCacheTool,
    setCacheTool,
  ];

  if (tracker) {
    return appendSubmitPhaseReportTool(tools, tracker);
  }
  return tools;
}

export async function createReviewFixTools(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  prNumber: number,
  tracker?: PhaseReportTracker,
) {
  const { createTool } = await loadClineSdk();
  const baseTools = await createAgentTools(octokit, owner, repo, issueNumber);

  const postPrCommentTool = createTool({
    name: "postComment",
    description: "Post a comment on the pull request.",
    inputSchema: {
      type: "object",
      properties: {
        body: {
          type: "string",
          description: "Markdown body for the PR comment",
        },
      },
      required: ["body"],
    },
    async execute(input: { body: string }) {
      const comment = await postComment(
        octokit,
        owner,
        repo,
        prNumber,
        input.body,
      );
      return { id: comment.id, url: comment.html_url };
    },
  });

  const getMergeStatusTool = createTool({
    name: "getMergeStatus",
    description:
      "Re-check the current merge status: local conflict files and the GitHub PR mergeable state.",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      const [conflictFiles, prState] = await Promise.all([
        getConflictFiles(),
        getPullRequestMergeState(octokit, owner, repo, prNumber),
      ]);
      return { conflictFiles, prState };
    },
  });

  const withoutPost = baseTools.filter((tool) => tool.name !== "postComment");

  const tools = [...withoutPost, postPrCommentTool, getMergeStatusTool];

  if (tracker) {
    return appendSubmitPhaseReportTool(tools, tracker);
  }
  return tools;
}

export type AnswerCommentTracker = {
  posted: boolean;
  id?: number;
  body?: string;
};

export async function createAskTools(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  answerComment: AnswerCommentTracker,
  prNumber?: number,
) {
  const { createTool } = await loadClineSdk();
  const baseTools = await createAgentTools(octokit, owner, repo, issueNumber);

  // Remove postComment and addLabel — ask is read-only
  const readTools = baseTools.filter(
    (tool) => tool.name !== "postComment" && tool.name !== "addLabel",
  );

  const submitAnswer = createTool({
    name: "submitAnswer",
    description:
      "Submit the final answer as a GitHub comment. Required on every ask run — the run is incomplete until you call this.",
    inputSchema: {
      type: "object",
      properties: {
        body: {
          type: "string",
          description: "Markdown answer starting with ## Agent answer",
        },
      },
      required: ["body"],
    },
    lifecycle: { completesRun: true },
    async execute(input: { body: string }) {
      const markedBody = prependAgentMarker(
        input.body,
        AGENT_COMMENT_MARKERS.ask,
      );
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
      return { id: comment.id, url: comment.html_url };
    },
  });

  const tools = [...readTools, submitAnswer];

  // Optionally add PR comment read tools when PR_NUMBER is set
  if (prNumber != null) {
    const readPrCommentsTool = createTool({
      name: "readPrComments",
      description: "Read all comments on the agent pull request.",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        const comments = await readComments(octokit, owner, repo, prNumber);
        return comments.map((comment) => ({
          id: comment.id,
          author: comment.user?.login ?? "unknown",
          body: truncateCommentBodyForAgent(comment.body ?? ""),
          createdAt: comment.created_at,
        }));
      },
    });
    tools.push(readPrCommentsTool);
  }

  return tools;
}

export type ReviewTracker = {
  posted: boolean;
  id?: number;
  body?: string;
  htmlUrl?: string;
};

export async function createCodeReviewTools(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  prNumber: number,
  review: ReviewTracker,
) {
  const { createTool } = await loadClineSdk();
  const baseTools = await createAgentTools(octokit, owner, repo, issueNumber);

  const readTools = baseTools.filter(
    (tool) => tool.name !== "postComment" && tool.name !== "addLabel",
  );

  const submitReview = createTool({
    name: "submitReview",
    description:
      "Submit the final two-axis code review as a GitHub pull request review. Required on every code-review run — the run is incomplete until you call this.",
    inputSchema: {
      type: "object",
      properties: {
        event: {
          type: "string",
          enum: ["COMMENT", "REQUEST_CHANGES"],
          description:
            "COMMENT when there are no hard findings; REQUEST_CHANGES for documented-standard breaches or spec misses. Never APPROVE.",
        },
        body: {
          type: "string",
          description:
            "Markdown review starting with ## Standards then ## Spec",
        },
        comments: {
          type: "array",
          description: "Optional inline comments on the PR diff",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "File path relative to the repo root",
              },
              line: {
                type: "integer",
                description: "Line number in the new file (RIGHT side)",
              },
              side: {
                type: "string",
                enum: ["LEFT", "RIGHT"],
                description: "Diff side; defaults to RIGHT",
              },
              body: {
                type: "string",
                description: "Inline comment markdown",
              },
            },
            required: ["path", "line", "body"],
          },
        },
      },
      required: ["event", "body"],
    },
    lifecycle: { completesRun: true },
    async execute(input: {
      event: PullRequestReviewEvent;
      body: string;
      comments?: PullRequestReviewCommentInput[];
    }) {
      const markedBody = prependAgentMarker(
        input.body,
        AGENT_COMMENT_MARKERS.codeReview,
      );
      const posted = await createPullRequestReview(
        octokit,
        owner,
        repo,
        prNumber,
        {
          event: input.event,
          body: markedBody,
          comments: input.comments,
        },
      );
      review.posted = true;
      review.id = posted.id;
      review.body = markedBody;
      review.htmlUrl = posted.html_url;
      return { id: posted.id, url: posted.html_url, event: posted.state };
    },
  });

  const readPrCommentsTool = createTool({
    name: "readPrComments",
    description: "Read all comments on the pull request.",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      const comments = await readComments(octokit, owner, repo, prNumber);
      return comments.map((comment) => ({
        id: comment.id,
        author: comment.user?.login ?? "unknown",
        body: truncateCommentBodyForAgent(comment.body ?? ""),
        createdAt: comment.created_at,
      }));
    },
  });

  return [...readTools, submitReview, readPrCommentsTool];
}

export const AGENT_TOOL_NAMES = [
  "readIssue",
  "readComments",
  "list_files",
  "postComment",
  "addLabel",
] as const;

export const CI_FIX_TOOL_NAMES = [
  ...AGENT_TOOL_NAMES,
  "readCheckRuns",
  "readCheckLogs",
  "getCache",
  "setCache",
] as const;
