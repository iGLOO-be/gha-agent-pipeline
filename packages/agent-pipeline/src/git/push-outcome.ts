/**
 * Decide whether a yolo run must fail when `commitAndPushBranch` reported
 * `noChanges`.
 *
 * With `git.skip_pr` the runner never opens a pull request, so an absent open
 * PR is expected and the only signal that the session produced nothing is that
 * the branch was never pushed either (`remoteBranchExists === false`). Without
 * `skip_pr`, an absent open pull request is itself the failure.
 *
 * Kept side-effect free (no imports with boot side effects) so `yolo.ts`, which
 * boots env/octokit at import time, stays out of the unit-test graph.
 */
export function shouldFailNoChanges(opts: {
  skipPr: boolean;
  remoteBranchExists: boolean;
  hasOpenPullRequest: boolean;
}): boolean {
  return opts.skipPr ? !opts.remoteBranchExists : !opts.hasOpenPullRequest;
}
