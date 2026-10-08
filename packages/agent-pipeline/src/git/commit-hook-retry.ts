import { readdir } from "node:fs/promises";
import { readClampedEnvInt } from "../env.js";
import {
  appendRunFrictionStepSummary,
  type RunFrictionCollector,
} from "../run-friction.js";
import { runShell } from "../tools/shell.js";
import { GitCommitError } from "./pr.js";

const HOOK_FAILURE_MARKERS = [
  /lint-staged/i,
  /lefthook/i,
  /\bhusky\b/i,
  /pre-commit hook/i,
  /commit-msg hook/i,
  /prepare-commit-msg/i,
  /failed to run tasks for staged files/i,
  /\.git\/hooks\//i,
];

/**
 * `git commit` failures that are definitely not caused by a commit hook. Used as
 * a guard for the "hooks are installed" fallback so identity/index errors are
 * not misread as hook rejections.
 */
const NON_HOOK_FAILURE_MARKERS = [
  /nothing added to commit/i,
  /cannot do a partial commit/i,
  /author identity unknown/i,
  /please tell me who you are/i,
  /not a git repository/i,
  /pathspec .* did not match/i,
  /you have not concluded your merge/i,
  /would be overwritten by merge/i,
  /unable to write new index file/i,
  /index\.lock/i,
  /gpg failed to sign/i,
  // Git-specific form only: a bare "permission denied" can legitimately appear
  // inside the log of an unrecognized hook runner that exited non-zero, and
  // matching it would suppress the relaunch this feature exists for.
  /fatal: unable to (create|write)[^\n]*permission denied/i,
  /read-only file system/i,
  /no space left on device/i,
  /unable to create .*COMMIT_EDITMSG/i,
  /failed to write commit object/i,
];

/** Total commit attempts (includes the first try after a session). Default 2 = one hook-fix relaunch. */
export function getCommitHookRetryMaxPasses(): number {
  return readClampedEnvInt("AGENT_COMMIT_HOOK_MAX_PASSES", {
    fallback: 2,
    min: 1,
    max: 3,
  });
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

export function isCommitHookFailure(commitOutput: string): boolean {
  const normalized = stripAnsi(commitOutput);
  return HOOK_FAILURE_MARKERS.some((pattern) => pattern.test(normalized));
}

/** True when the output matches a known non-hook `git commit` error. */
export function isKnownNonHookGitFailure(commitOutput: string): boolean {
  const normalized = stripAnsi(commitOutput);
  return NON_HOOK_FAILURE_MARKERS.some((pattern) => pattern.test(normalized));
}

/**
 * Hook runners we do not recognize (e.g. `pre-commit.com`, repo-local `pnpm
 * lint` hooks) print no marker from {@link HOOK_FAILURE_MARKERS}. When hooks are
 * actually installed and the output is not a known non-hook git error, treat the
 * failure as a hook rejection so the agent is still relaunched.
 */
export function isCommitHookFailureLike(
  commitOutput: string,
  hooksInstalled = false,
): boolean {
  if (isCommitHookFailure(commitOutput)) {
    return true;
  }
  // Empty output means no hook diagnostic was produced (e.g. the hook was killed
  // by a signal); relaunching the agent would spend a full session on a prompt
  // with nothing actionable in it.
  if (commitOutput.trim() === "") {
    return false;
  }
  return hooksInstalled && !isKnownNonHookGitFailure(commitOutput);
}

/**
 * True when the current checkout has real commit hooks installed: either a
 * `core.hooksPath` config value, or a non-`.sample` entry under `.git/hooks/`.
 */
export async function hasInstalledCommitHooks(): Promise<boolean> {
  const configured = await runShell("git config --get core.hooksPath");
  if (configured.exitCode === 0 && configured.stdout.trim() !== "") {
    return true;
  }

  const hooksDir = await runShell("git rev-parse --git-path hooks");
  if (hooksDir.exitCode !== 0) {
    return false;
  }
  const dir = hooksDir.stdout.trim();
  if (!dir) {
    return false;
  }

  try {
    const entries = await readdir(dir);
    return entries.some((name) => !name.endsWith(".sample"));
  } catch {
    return false;
  }
}

export function shouldRetryCommitHookFailure(
  error: unknown,
  commitAttemptIndex: number,
  maxPasses: number,
  hooksInstalled = false,
): boolean {
  if (commitAttemptIndex >= maxPasses - 1) {
    return false;
  }
  if (!(error instanceof GitCommitError)) {
    return false;
  }
  return isCommitHookFailureLike(error.commitOutput, hooksInstalled);
}

export function formatCommitHookRetryPrompt(hookLog: string): string {
  const log = stripAnsi(hookLog).trim();
  const truncated =
    log.length > 24_000 ? `${log.slice(0, 24_000)}\n…(truncated)` : log;

  return `PRIORITY: The runner tried to commit your changes after the session, but this repository's git commit hooks rejected the commit.

Fix the code in the working tree so a normal \`git commit\` would pass the same hooks. Read AGENTS.md and package.json for documented format/lint/test commands and run the checks that apply to your changed files.

Do not commit or push yourself — the runner will retry the commit when you finish.

Hook output from the failed commit:
\`\`\`
${truncated}
\`\`\``;
}

export async function runCommitWithHookRetry<T>(options: {
  maxPasses: number;
  commit: () => Promise<T>;
  relaunchForHookFailure: (
    hookLog: string,
    retryIndex: number,
  ) => Promise<void>;
}): Promise<T> {
  const { maxPasses, commit, relaunchForHookFailure } = options;

  let hooksInstalled: boolean | undefined;
  const resolveHooksInstalled = async (): Promise<boolean> => {
    hooksInstalled ??= await hasInstalledCommitHooks();
    return hooksInstalled;
  };

  for (let attempt = 0; attempt < maxPasses; attempt++) {
    try {
      return await commit();
    } catch (error) {
      const hooksInstalledForFailure =
        error instanceof GitCommitError ? await resolveHooksInstalled() : false;
      if (
        !shouldRetryCommitHookFailure(
          error,
          attempt,
          maxPasses,
          hooksInstalledForFailure,
        )
      ) {
        // Only flag the heuristic gap when nothing matched at all; when a marker
        // (or the installed-hooks fallback) matched but the retry budget is
        // exhausted the reason is the pass limit, not the detection heuristic,
        // and a recognized non-hook git error means the heuristic worked as
        // designed rather than that a gap exists.
        if (
          error instanceof GitCommitError &&
          !isCommitHookFailureLike(
            error.commitOutput,
            hooksInstalledForFailure,
          ) &&
          !isKnownNonHookGitFailure(error.commitOutput)
        ) {
          console.warn(
            "git commit failed but the output did not match known hook-failure patterns. " +
              "The commit-hook-retry feature will not apply. Raw output:\n" +
              error.commitOutput,
          );
        }
        throw error;
      }
      const hookLog =
        error instanceof GitCommitError ? error.commitOutput : String(error);
      console.warn(
        `Git commit hooks failed (attempt ${attempt + 1}/${maxPasses}); relaunching agent to fix.`,
      );
      await relaunchForHookFailure(hookLog, attempt + 1);
    }
  }

  throw new Error("runCommitWithHookRetry: exhausted passes without returning");
}

/**
 * Per-phase wrapper around {@link runCommitWithHookRetry} that owns the two
 * behaviours every phase needs and used to duplicate: building the relaunch
 * prompt (hook log + `Repository:`/`Branch:` orientation trailer) and emitting
 * the run-friction step summary when the retry budget is exhausted before the
 * post-commit success paths could write it.
 *
 * Keep the relaunch contract in one place so a future change (extra context in
 * the prompt, new friction bookkeeping) does not have to be repeated in
 * implement, yolo and fix-phase.
 */
export async function runCommitWithHookRetryForPhase<T>(options: {
  /** Phase name used for the run-friction step summary. */
  phase: string;
  maxPasses: number;
  commit: () => Promise<T>;
  /** Build the prompt for the relaunch session from the failed commit output. */
  buildRelaunchPrompt: (hookLog: string) => string;
  /** Run one extra agent session; called once per hook retry. */
  relaunchSession: (prompt: string, retryIndex: number) => Promise<void>;
  runFriction: RunFrictionCollector;
}): Promise<T> {
  const {
    phase,
    maxPasses,
    commit,
    buildRelaunchPrompt,
    relaunchSession,
    runFriction,
  } = options;

  try {
    return await runCommitWithHookRetry({
      maxPasses,
      commit,
      relaunchForHookFailure: (hookLog, retryIndex) =>
        relaunchSession(buildRelaunchPrompt(hookLog), retryIndex),
    });
  } catch (error) {
    // An exhausted commit-hook retry throws before the post-commit summaries,
    // so record friction now to keep the failure's diagnostics.
    appendRunFrictionStepSummary(runFriction, phase);
    throw error;
  }
}
