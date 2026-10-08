import { readClampedEnvInt } from "./env.js";
import {
  PullRequestStillConflictingError,
  type PullRequestMergeState,
} from "./tools/github.js";

export { PullRequestStillConflictingError };
export type { PullRequestMergeState };

/** Total agent passes when upstream may drift during a long fix session (includes the first pass). */
export function getUpstreamDriftMaxPasses(): number {
  return readClampedEnvInt("AGENT_UPSTREAM_DRIFT_MAX_PASSES", {
    fallback: 2,
    min: 1,
    max: 3,
  });
}

export function isUpstreamDriftAfterPush(
  state: PullRequestMergeState,
): boolean {
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
