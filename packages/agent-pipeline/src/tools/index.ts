import type { Octokit } from "@octokit/rest";
import {
  decorateCodeReviewBody,
  decorateInlineReviewCommentBody,
} from "../code-review-display.js";
import { loadClineSdk } from "../cline.js";
import { readCacheValue, writeCacheValue } from "../state/cache.js";
import {
  addLabelToIssue,
  AGENT_COMMENT_MARKERS,
  createPullRequestReview,
  createReplyForReviewComment,
  getPullRequestMergeState,
  postComment,
  prependAgentMarker,
  readCheckLogs,
  readCheckRuns,
  readComments,
  readIssue,
  readPullRequestReviewComments,
  resolvePullRequestReviewThread,
  getPullRequestReviewComment,
  formatReviewCommentsForPrompt,
  isAutomatedReviewAuthor,
  isBareReviewFixFeedback,
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

export async function createFixTools(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  prNumber: number,
  headSha: string,
  tracker?: PhaseReportTracker,
) {
  const { createTool } = await loadClineSdk();
  const reviewTools = await createReviewFixTools(
    octokit,
    owner,
    repo,
    issueNumber,
    prNumber,
    tracker,
  );

  const existing = new Set(reviewTools.map((tool) => tool.name));

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

  const extra = [
    readCheckRunsTool,
    readCheckLogsTool,
    getCacheTool,
    setCacheTool,
  ].filter((tool) => !existing.has(tool.name));

  return [...reviewTools, ...extra];
}

async function createResolveReviewThreadsTool(octokit: Octokit) {
  const { createTool } = await loadClineSdk();
  return createTool({
    name: "resolveReviewThreads",
    description:
      "Resolve GitHub pull request review threads after verifying the feedback is addressed in the current code.",
    inputSchema: {
      type: "object",
      properties: {
        threadIds: {
          type: "array",
          items: { type: "string" },
          description:
            "GraphQL thread ids from the follow-up context (e.g. PRRT_...).",
        },
      },
      required: ["threadIds"],
    },
    async execute(input: { threadIds: string[] }) {
      const results: {
        threadId: string;
        ok: boolean;
        error?: string;
      }[] = [];
      for (const threadId of input.threadIds) {
        try {
          await resolvePullRequestReviewThread(octokit, threadId);
          results.push({ threadId, ok: true });
        } catch (error) {
          results.push({
            threadId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { results };
    },
  });
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

  const readPullRequestReviewCommentsTool = createTool({
    name: "readPullRequestReviewComments",
    description:
      "List pull request review comments (inline comments on the diff). Optionally filter to specific comment IDs.",
    inputSchema: {
      type: "object",
      properties: {
        commentIds: {
          type: "array",
          items: { type: "number" },
          description:
            "Optional review comment IDs to fetch; when omitted, returns line comments on the PR (up to 100). After a bare /agent fix trigger, includes bot and human authors; otherwise human authors only.",
        },
      },
    },
    async execute(input: { commentIds?: number[] }) {
      if (input.commentIds != null && input.commentIds.length > 0) {
        const comments = await Promise.all(
          input.commentIds.map((id) =>
            getPullRequestReviewComment(octokit, owner, repo, id),
          ),
        );
        return {
          markdown: formatReviewCommentsForPrompt(comments),
          comments: comments.map((c) => ({
            id: c.id,
            path: c.path,
            line: c.line,
            author: c.user?.login ?? "unknown",
            body: c.body ?? "",
          })),
        };
      }
      const all = await readPullRequestReviewComments(
        octokit,
        owner,
        repo,
        prNumber,
      );
      const reviewFeedback = process.env.REVIEW_FEEDBACK ?? "";
      const includeAllAuthors = isBareReviewFixFeedback(reviewFeedback);
      const selected = includeAllAuthors
        ? all
        : all.filter((c) => !isAutomatedReviewAuthor(c.user?.login));
      return {
        markdown: formatReviewCommentsForPrompt(selected.slice(0, 100)),
        comments: selected.slice(0, 100).map((c) => ({
          id: c.id,
          path: c.path,
          line: c.line,
          author: c.user?.login ?? "unknown",
          body: c.body ?? "",
        })),
      };
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

  const replyToReviewCommentTool = createTool({
    name: "replyToReviewComment",
    description:
      "Reply in the thread of a pull request review comment (use the root comment id from the thread context).",
    inputSchema: {
      type: "object",
      properties: {
        commentId: {
          type: "number",
          description: "Database id of the root review comment to reply to",
        },
        body: {
          type: "string",
          description:
            "Short markdown: what changed, or why the feedback was not applied",
        },
      },
      required: ["commentId", "body"],
    },
    async execute(input: { commentId: number; body: string }) {
      const reply = await createReplyForReviewComment(
        octokit,
        owner,
        repo,
        prNumber,
        input.commentId,
        input.body,
      );
      return { id: reply.id, url: reply.html_url };
    },
  });

  const resolveReviewThreads = await createResolveReviewThreadsTool(octokit);

  const withoutPost = baseTools.filter((tool) => tool.name !== "postComment");

  const tools = [
    ...withoutPost,
    postPrCommentTool,
    readPullRequestReviewCommentsTool,
    replyToReviewCommentTool,
    resolveReviewThreads,
    getMergeStatusTool,
  ];

  if (tracker) {
    return appendSubmitPhaseReportTool(tools, tracker, {
      allowCommitMessage: true,
    });
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
  event?: PullRequestReviewEvent;
};

export type CodeReviewToolsOptions = {
  followUpEnabled?: boolean;
};

export async function createCodeReviewTools(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  prNumber: number,
  review: ReviewTracker,
  options: CodeReviewToolsOptions = {},
) {
  const { createTool } = await loadClineSdk();
  const baseTools = await createAgentTools(octokit, owner, repo, issueNumber);

  const readTools = baseTools.filter(
    (tool) => tool.name !== "postComment" && tool.name !== "addLabel",
  );

  const submitReview = createTool({
    name: "submitReview",
    description:
      "Submit the final code review as a GitHub pull request review (walkthrough, merge risk, pre-merge checks, Standards, Spec, plus inline comments). Required on every code-review run — the run is incomplete until you call this.",
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
            "Markdown review: ## Walkthrough, ## Merge risk, ## Pre-merge checks, ## Standards, ## Spec (in that order)",
        },
        comments: {
          type: "array",
          description:
            "Inline comments on the PR diff; required for every hard Standards or Spec finding",
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
                description:
                  "First line: _Category_ | _Severity_ | _Effort_; then explanation, optional Suggested fix (diff) and Evidence details blocks",
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
      const displayBody = decorateCodeReviewBody(input.body);
      const displayComments = input.comments?.map((comment) => ({
        ...comment,
        body: decorateInlineReviewCommentBody(comment.body),
      }));
      const markedBody = prependAgentMarker(
        displayBody,
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
          comments: displayComments,
        },
      );
      review.posted = true;
      review.id = posted.id;
      review.body = markedBody;
      review.htmlUrl = posted.html_url;
      review.event = input.event;
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

  const tools = [...readTools, submitReview, readPrCommentsTool];

  if (options.followUpEnabled) {
    const readPullRequestReviewCommentsTool = createTool({
      name: "readPullRequestReviewComments",
      description:
        "List pull request review comments (inline comments on the diff), including prior agent comments.",
      inputSchema: {
        type: "object",
        properties: {
          commentIds: {
            type: "array",
            items: { type: "number" },
            description:
              "Optional review comment IDs to fetch; when omitted, returns line comments on the PR (up to 100).",
          },
        },
      },
      async execute(input: { commentIds?: number[] }) {
        if (input.commentIds != null && input.commentIds.length > 0) {
          const comments = await Promise.all(
            input.commentIds.map((id) =>
              getPullRequestReviewComment(octokit, owner, repo, id),
            ),
          );
          return {
            markdown: formatReviewCommentsForPrompt(comments),
            comments: comments.map((c) => ({
              id: c.id,
              path: c.path,
              line: c.line,
              author: c.user?.login ?? "unknown",
              body: c.body ?? "",
            })),
          };
        }
        const all = await readPullRequestReviewComments(
          octokit,
          owner,
          repo,
          prNumber,
        );
        return {
          markdown: formatReviewCommentsForPrompt(all.slice(0, 100)),
          comments: all.slice(0, 100).map((c) => ({
            id: c.id,
            path: c.path,
            line: c.line,
            author: c.user?.login ?? "unknown",
            body: c.body ?? "",
          })),
        };
      },
    });

    const resolveReviewThreads = await createResolveReviewThreadsTool(octokit);

    tools.push(readPullRequestReviewCommentsTool, resolveReviewThreads);
  }

  return tools;
}

export const AGENT_TOOL_NAMES = [
  "readIssue",
  "readComments",
  "list_files",
  "postComment",
  "addLabel",
] as const;
