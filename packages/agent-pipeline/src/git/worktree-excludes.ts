import { AGENT_STATE_DIR } from "../state/cache.js";

/** Matches `path` in install-agent-pipeline composite action (GHA checkout). */
export const PIPELINE_GHA_CHECKOUT_DIR = "gha-agent-pipeline";

/** Pathspecs excluding the pipeline checkout and local agent runner state. */
function excludedWorktreePathspecs(): string {
  return `':!${PIPELINE_GHA_CHECKOUT_DIR}' ':!${AGENT_STATE_DIR}'`;
}

/** Stage all changes without pipeline checkout or local agent runner state. */
export function gitAddAllExcludingPipelineCheckoutCommand(): string {
  return `git add -A -- . ${excludedWorktreePathspecs()}`;
}

/**
 * Unstage/remove the pipeline checkout if it was picked up by a plain `git add -A`.
 */
export function unstagePipelineCheckoutCommand(): string {
  const dirs = [PIPELINE_GHA_CHECKOUT_DIR, AGENT_STATE_DIR];
  const unstaging = dirs
    .map(
      (dir) =>
        `git rm -r --cached --ignore-unmatch ${dir} 2>/dev/null; ` +
        `git reset HEAD -- ${dir} 2>/dev/null; `,
    )
    .join("");
  return unstaging + "true";
}
