/** Minimal shape of a {@link runShell} result needed for probe decisions. */
export type ShellProbeResult = {
  stdout: string;
  exitCode: number;
};

/**
 * Decide whether the yolo "nothing to push" diagnostic should warn.
 *
 * `worktreeStatus` comes from the pathspec-filtered `git status --porcelain`
 * (untracked-aware, ignores runner-internal artifacts) and `ahead` from
 * `git rev-list --count origin/<base>..HEAD`. Because the porcelain probe only
 * compares the index/worktree to HEAD, a session that committed its own work
 * shows a clean tree while still being ahead of base — so we require both a
 * clean tree and zero commits ahead before warning.
 *
 * When either probe fails (e.g. missing `origin/<base>` ref) we stay silent:
 * the caller runs `commitAndPushBranch` right after this check, which already
 * fails the run when there is genuinely nothing to push.
 */
export function shouldWarnNoYoloChanges(
  worktreeStatus: ShellProbeResult,
  ahead: ShellProbeResult,
): boolean {
  const cleanTree =
    worktreeStatus.exitCode === 0 && worktreeStatus.stdout.trim() === "";
  const commitsAhead =
    ahead.exitCode === 0 ? Number.parseInt(ahead.stdout.trim(), 10) : NaN;
  return cleanTree && commitsAhead === 0;
}

/** `git rev-list` range between remote base branch and HEAD. */
export function revListRangeAheadOfBase(baseBranch: string): string {
  return `origin/${baseBranch}..HEAD`;
}

/** `git rev-list --count` command used to count commits ahead of the base branch. */
export function commitsAheadOfBaseCommand(baseBranch: string): string {
  return `git rev-list --count ${revListRangeAheadOfBase(baseBranch)}`;
}
