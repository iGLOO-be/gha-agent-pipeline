/** Matches `path` in install-agent-pipeline composite action (GHA checkout). */
export const PIPELINE_GHA_CHECKOUT_DIR = "gha-agent-pipeline";

/** Stage all changes without the pipeline checkout (avoids accidental submodule gitlinks). */
export function gitAddAllExcludingPipelineCheckoutCommand(): string {
  return `git add -A -- . ':!${PIPELINE_GHA_CHECKOUT_DIR}'`;
}

/** Unstage/remove the pipeline checkout if it was picked up by a plain `git add -A`. */
export function unstagePipelineCheckoutCommand(): string {
  const dir = PIPELINE_GHA_CHECKOUT_DIR;
  return (
    `git rm -r --cached --ignore-unmatch ${dir} 2>/dev/null; ` +
    `git reset HEAD -- ${dir} 2>/dev/null; ` +
    "true"
  );
}
