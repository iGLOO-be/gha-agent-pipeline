import type { Octokit } from "@octokit/rest";
import {
  assertPullRequestNotConflicting,
  getPullRequestMergeState,
  PullRequestStillConflictingError,
} from "./tools/github.js";

export { PullRequestStillConflictingError };

export type PrMergeState = Awaited<ReturnType<typeof getPullRequestMergeState>>;

const DEFAULT_MAX_PASSES = 2;
const MIN_MAX_PASSES = 1;
const MAX_MAX_PASSES = 3;

/** Total agent passes when upstream may drift during a long fix session (includes the first pass). */
export function getUpstreamDriftMaxPasses(): number {
  const raw = process.env.AGENT_UPSTREAM_DRIFT_MAX_PASSES;
  if (!raw) {
    return DEFAULT_MAX_PASSES;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MAX_PASSES;
  }
  return Math.min(MAX_MAX_PASSES, Math.max(MIN_MAX_PASSES, parsed));
}

export function isUpstreamDriftAfterPush(state: PrMergeState): boolean {
  return state.conflicts && (state.behind_by ?? 0) > 0;
}

export function shouldRetryUpstreamDriftAfterPush(
  error: PullRequestStillConflictingError,
  passIndex: number,
  maxPasses: number,
): boolean {
  return isUpstreamDriftAfterPush(error.state) && passIndex < maxPasses - 1;
}

export function formatMergeStillBlockedStatusLine(
  pushedLine: string,
  baseBranch: string,
  error: PullRequestStillConflictingError,
): string {
  const behind =
    error.behind_by != null ? `, \`behind_by: ${error.behind_by}\`` : "";
  return `${pushedLine} However, GitHub still reports the PR cannot merge into \`${baseBranch}\` (\`mergeable_state: ${error.mergeable_state}\`${behind}). Re-run \`/agent fix\` or resolve conflicts manually.`;
}

export async function assertPullRequestMergeAfterPush(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  await assertPullRequestNotConflicting(octokit, owner, repo, prNumber);
}
