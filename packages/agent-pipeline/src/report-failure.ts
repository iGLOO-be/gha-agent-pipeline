import type { Octokit } from "@octokit/rest";
import {
  addLabelToIssue,
  AGENT_COMMENT_MARKERS,
  type AgentCommentMarker,
  buildRunUrl,
  ensureLabel,
  postComment,
  prependAgentMarker,
} from "./tools/github.js";

const FAILED_LABEL = "agent-failed";
const WAITING_HUMAN_LABEL = "agent-waiting-human";
const MAX_DETAILS_CHARS = 8_000;

const PHASE_META = {
  plan: {
    title: "Agent Plan Failed",
    description: "creating the implementation plan",
  },
  implement: {
    title: "Agent Implement Failed",
    description: "implementing the issue",
  },
  yolo: {
    title: "Agent Yolo Failed",
    description: "implementing the issue",
  },
  "review-fix": {
    title: "Agent Review Fix Failed",
    description: "addressing the review feedback",
  },
  "ci-fix": {
    title: "Agent CI Fix Failed",
    description: "fixing the CI failures",
  },
  ask: {
    title: "Agent Ask Failed",
    description: "answering the question",
  },
} as const;

export type FailurePhase = keyof typeof PHASE_META;

type IssueTarget = { kind: "issue"; number: number };
type PrTarget = {
  kind: "pr";
  number: number;
  sourceIssueNumber?: number;
};
export type FailureTarget = IssueTarget | PrTarget;

export function formatError(error: unknown): {
  message: string;
  details: string;
} {
  if (error instanceof Error) {
    const message = error.message.split("\n")[0];
    const details = error.stack ?? error.message;
    return { message, details };
  }

  if (typeof error === "string") {
    const message = error.split("\n")[0];
    return { message, details: error };
  }

  const details = (() => {
    try {
      return JSON.stringify(error, null, 2);
    } catch {
      return String(error);
    }
  })();

  return { message: details.split("\n")[0], details };
}

export function redactSecrets(value: string): string {
  const secrets = [
    process.env.GITHUB_TOKEN,
    process.env.OPENROUTER_API_KEY,
  ].filter((s): s is string => !!s);

  let redacted = value;
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join("***");
  }
  return redacted;
}

export function truncateDetails(details: string): string {
  if (details.length <= MAX_DETAILS_CHARS) {
    return details;
  }
  return `${details.slice(0, MAX_DETAILS_CHARS)}\n\n…(truncated)`;
}

export function failureMarkerForPhase(phase: FailurePhase): AgentCommentMarker {
  switch (phase) {
    case "plan":
      return AGENT_COMMENT_MARKERS.planFailed;
    case "yolo":
      return AGENT_COMMENT_MARKERS.yoloFailed;
    case "review-fix":
      return AGENT_COMMENT_MARKERS.reviewFixFailed;
    case "ci-fix":
      return AGENT_COMMENT_MARKERS.ciFixFailed;
    case "ask":
      return AGENT_COMMENT_MARKERS.askFailed;
    default:
      return AGENT_COMMENT_MARKERS.implementFailed;
  }
}

export function buildBody(phase: FailurePhase, error: unknown): string {
  const meta = PHASE_META[phase];
  const { message: rawMessage, details: rawDetails } = formatError(error);
  const message = redactSecrets(rawMessage);
  const details = redactSecrets(truncateDetails(rawDetails));
  const runUrl = buildRunUrl();

  const runLine = runUrl
    ? `**Run:** [View in GitHub Actions](${runUrl})`
    : "**Run:** (not available outside GitHub Actions)";

  const dedupeMarker = `<!-- agent-failed-run:${process.env.GITHUB_RUN_ID ?? "local"} -->`;

  const content = `## ${meta.title}

The agent encountered an error while ${meta.description}.

**Error:** ${message}

${runLine}

<details>
<summary>Full error details</summary>

\`\`\`
${details}
\`\`\`

</details>

${dedupeMarker}`;

  return prependAgentMarker(content, failureMarkerForPhase(phase));
}

export async function reportPhaseFailure(
  octokit: Octokit,
  owner: string,
  repo: string,
  target: FailureTarget,
  phase: FailurePhase,
  error: unknown,
): Promise<void> {
  const body = buildBody(phase, error);

  try {
    await postComment(octokit, owner, repo, target.number, body);
  } catch (commentError) {
    console.warn(`Failed to post ${phase} failure comment:`, commentError);
  }

  try {
    await ensureLabel(octokit, owner, repo, FAILED_LABEL, {
      color: "d73a4a",
      description: "Agent pipeline failed on this issue or PR.",
    });
    await addLabelToIssue(octokit, owner, repo, target.number, FAILED_LABEL);
  } catch (labelError) {
    console.warn(`Failed to add ${FAILED_LABEL} label:`, labelError);
  }

  try {
    await ensureLabel(octokit, owner, repo, WAITING_HUMAN_LABEL, {
      color: "f9d0c4",
      description: "Waiting for human decision on this issue.",
    });

    if (target.kind === "issue") {
      await addLabelToIssue(
        octokit,
        owner,
        repo,
        target.number,
        WAITING_HUMAN_LABEL,
      );
    } else if (target.sourceIssueNumber) {
      await addLabelToIssue(
        octokit,
        owner,
        repo,
        target.sourceIssueNumber,
        WAITING_HUMAN_LABEL,
      );
    }
  } catch (labelError) {
    console.warn(`Failed to add ${WAITING_HUMAN_LABEL} label:`, labelError);
  }

  if (target.kind === "pr" && target.sourceIssueNumber) {
    const runUrl = buildRunUrl() ?? "(run URL unavailable)";
    const reminderBody = `## ${PHASE_META[phase].title}

The agent failed while ${PHASE_META[phase].description} on PR #${target.number}.

See PR #${target.number} for the failure comment, or [view the run](${runUrl}).`;

    try {
      await postComment(
        octokit,
        owner,
        repo,
        target.sourceIssueNumber,
        reminderBody,
      );
    } catch (reminderError) {
      console.warn(
        `Failed to post source issue reminder comment:`,
        reminderError,
      );
    }
  }
}
