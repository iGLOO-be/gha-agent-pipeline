import { runShell } from "../tools/shell.js";
import { fetchBase } from "./sync.js";

export const MAX_REVIEW_DIFF_CHARS = 80_000;

export type ReviewDiffContext = {
  baseBranch: string;
  log: string;
  files: string[];
  diff: string;
  truncated: boolean;
  sinceRef?: string;
};

export function isSafeGitRef(value: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

export function isSafeGitRev(value: string): boolean {
  if (/^[a-f0-9]{7,40}$/i.test(value)) {
    return true;
  }
  return isSafeGitRef(value);
}

export function truncateReviewDiff(
  diff: string,
  maxChars = MAX_REVIEW_DIFF_CHARS,
): { diff: string; truncated: boolean } {
  if (diff.length <= maxChars) {
    return { diff, truncated: false };
  }
  const omitted = diff.length - maxChars;
  return {
    diff: `${diff.slice(0, maxChars)}\n\n…(truncated ${omitted} characters)`,
    truncated: true,
  };
}

export async function collectReviewDiff(
  baseBranch: string,
): Promise<ReviewDiffContext> {
  if (!isSafeGitRef(baseBranch)) {
    throw new Error(`Unsafe git base branch: ${baseBranch}`);
  }

  await fetchBase(baseBranch);

  const logResult = await runShell(
    `git log --oneline origin/${baseBranch}..HEAD`,
  );
  const filesResult = await runShell(
    `git diff --name-only origin/${baseBranch}...HEAD`,
  );
  const diffResult = await runShell(`git diff origin/${baseBranch}...HEAD`);
  if (diffResult.exitCode !== 0) {
    throw new Error(
      `Failed to compute review diff against origin/${baseBranch}: ${diffResult.stderr || diffResult.stdout}`,
    );
  }

  const files = filesResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const truncated = truncateReviewDiff(diffResult.stdout);

  return {
    baseBranch,
    log: logResult.stdout.trim() || "(no commits)",
    files,
    diff: truncated.diff,
    truncated: truncated.truncated,
  };
}

export async function collectReviewDiffSince(
  sinceRef: string,
): Promise<Pick<ReviewDiffContext, "log" | "files" | "diff" | "truncated">> {
  if (!isSafeGitRev(sinceRef)) {
    throw new Error(`Unsafe git revision for review diff: ${sinceRef}`);
  }

  const logResult = await runShell(`git log --oneline ${sinceRef}..HEAD`);
  const filesResult = await runShell(`git diff --name-only ${sinceRef}..HEAD`);
  const diffResult = await runShell(`git diff ${sinceRef}..HEAD`);
  if (diffResult.exitCode !== 0) {
    throw new Error(
      `Failed to compute review diff since ${sinceRef}: ${diffResult.stderr || diffResult.stdout}`,
    );
  }

  const files = filesResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const truncated = truncateReviewDiff(diffResult.stdout);

  return {
    log: logResult.stdout.trim() || "(no commits)",
    files,
    diff: truncated.diff,
    truncated: truncated.truncated,
  };
}
