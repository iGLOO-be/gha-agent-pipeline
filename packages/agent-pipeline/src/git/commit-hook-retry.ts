import { GitCommitError } from "./pr.js";

const DEFAULT_MAX_PASSES = 2;
const MIN_MAX_PASSES = 1;
const MAX_MAX_PASSES = 3;

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

/** Total commit attempts (includes the first try after a session). Default 2 = one hook-fix relaunch. */
export function getCommitHookRetryMaxPasses(): number {
  const raw = process.env.AGENT_COMMIT_HOOK_MAX_PASSES;
  if (!raw) {
    return DEFAULT_MAX_PASSES;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MAX_PASSES;
  }
  return Math.min(MAX_MAX_PASSES, Math.max(MIN_MAX_PASSES, parsed));
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

export function isCommitHookFailure(commitOutput: string): boolean {
  const normalized = stripAnsi(commitOutput);
  return HOOK_FAILURE_MARKERS.some((pattern) => pattern.test(normalized));
}

export function shouldRetryCommitHookFailure(
  error: unknown,
  commitAttemptIndex: number,
  maxPasses: number,
): boolean {
  if (commitAttemptIndex >= maxPasses - 1) {
    return false;
  }
  if (!(error instanceof GitCommitError)) {
    return false;
  }
  return isCommitHookFailure(error.commitOutput);
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

  for (let attempt = 0; attempt < maxPasses; attempt++) {
    try {
      return await commit();
    } catch (error) {
      if (!shouldRetryCommitHookFailure(error, attempt, maxPasses)) {
        // Only flag the heuristic gap when the output really matched nothing;
        // when a marker matched but the retry budget is exhausted the reason is
        // the pass limit, not the detection heuristic.
        if (
          error instanceof GitCommitError &&
          !isCommitHookFailure(error.commitOutput)
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
