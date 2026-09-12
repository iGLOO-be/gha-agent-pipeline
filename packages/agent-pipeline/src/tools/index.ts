import type { Octokit } from "@octokit/rest";
import { loadClineSdk } from "../cline.js";
import { readCacheValue, writeCacheValue } from "../state/cache.js";
import {
  addLabelToIssue,
  getPullRequestMergeState,
  postComment,
  readCheckLogs,
  readCheckRuns,
  readComments,
  readIssue,
  truncateCommentBodyForAgent,
} from "./github.js";
import { getConflictFiles } from "../git/sync.js";
import { listFiles } from "./list-files.js";

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
) {
  const baseTools = await createAgentTools(octokit, owner, repo, issueNumber);
  return baseTools.filter((tool) => tool.name !== "postComment");
}

export async function createCiFixTools(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  prNumber: number,
  headSha: string,
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

  return [
    ...withoutPost,
    postPrCommentTool,
    readCheckRunsTool,
    readCheckLogsTool,
    getCacheTool,
    setCacheTool,
  ];
}

export async function createReviewFixTools(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  prNumber: number,
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
  return [...withoutPost, postPrCommentTool, getMergeStatusTool];
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
