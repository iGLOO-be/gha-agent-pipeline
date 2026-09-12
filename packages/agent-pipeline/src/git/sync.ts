import { runShell } from "../tools/shell.js";
import {
  gitAddAllExcludingPipelineCheckoutCommand,
  unstagePipelineCheckoutCommand,
} from "./worktree-excludes.js";

export type MergeStrategy = "merge" | "rebase";

export type SyncResult = {
  status: "clean" | "merged" | "conflict";
  conflictFiles: string[];
  mergeOutput: string;
};

export async function fetchBase(baseBranch: string): Promise<void> {
  const result = await runShell(`git fetch origin ${baseBranch}`);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to fetch origin/${baseBranch}: ${result.stderr || result.stdout}`,
    );
  }
}

/**
 * True when `origin/<baseBranch>` is not fully contained in HEAD (behind or diverged).
 */
export async function needsBaseSync(baseBranch: string): Promise<boolean> {
  const result = await runShell(
    `git merge-base --is-ancestor origin/${baseBranch} HEAD`,
  );
  if (result.exitCode === 0) {
    return false;
  }
  if (result.exitCode === 1) {
    return true;
  }
  throw new Error(
    `Could not determine if branch includes origin/${baseBranch}: ${result.stderr || result.stdout}`,
  );
}

export async function mergeBase(baseBranch: string): Promise<SyncResult> {
  const result = await runShell(`git merge origin/${baseBranch} --no-edit`);

  if (result.exitCode === 0) {
    const output = result.stdout + result.stderr;
    return {
      status: output.includes("Already up to date") ? "clean" : "merged",
      conflictFiles: [],
      mergeOutput: output,
    };
  }

  const conflictFiles = await getConflictFiles();
  if (conflictFiles.length > 0) {
    return {
      status: "conflict",
      conflictFiles,
      mergeOutput: result.stdout + result.stderr,
    };
  }

  throw new Error(
    `Failed to merge origin/${baseBranch}: ${result.stderr || result.stdout}`,
  );
}

export type SyncWithBaseOptions = {
  /**
   * Merge even when HEAD already contains origin/base.
   * Use only when GitHub reports conflicts and the local branch still needs base sync.
   */
  force?: boolean;
};

/**
 * Avoid merging when GitHub's mergeable flag is stale but HEAD already includes main.
 */
export async function shouldForceMergeFromGitHub(
  baseBranch: string,
  githubReportsConflicts: boolean,
): Promise<boolean> {
  if (!githubReportsConflicts) {
    return false;
  }
  await fetchBase(baseBranch);
  return await needsBaseSync(baseBranch);
}

const AGENT_HARNESS_STASH_MESSAGE = "agent-harness-overlay";

/** Overlay `tools/agent` from the base branch (CI sync step runs before merge). */
export async function overlayAgentHarnessFromBase(
  baseBranch: string,
): Promise<void> {
  await fetchBase(baseBranch);
  const result = await runShell(
    `git checkout origin/${baseBranch} -- tools/agent`,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to overlay tools/agent from origin/${baseBranch}: ${result.stderr || result.stdout}`,
    );
  }
}

async function hasAgentHarnessWorkingTreeChanges(): Promise<boolean> {
  const unstaged = await runShell("git diff --quiet -- tools/agent");
  const staged = await runShell("git diff --cached --quiet -- tools/agent");
  return unstaged.exitCode !== 0 || staged.exitCode !== 0;
}

/**
 * GHA fix jobs overlay `tools/agent` from main before the runner merges base.
 * Stash that overlay so `git merge` is not blocked by local changes.
 */
async function stashAgentHarnessOverlay(): Promise<boolean> {
  if (!(await hasAgentHarnessWorkingTreeChanges())) {
    return false;
  }
  const stash = await runShell(
    `git stash push -m ${JSON.stringify(AGENT_HARNESS_STASH_MESSAGE)} -- tools/agent`,
  );
  if (stash.exitCode !== 0) {
    throw new Error(
      `Failed to stash tools/agent before merging base: ${stash.stderr || stash.stdout}`,
    );
  }
  return true;
}

async function dropAgentHarnessStash(): Promise<void> {
  const list = await runShell("git stash list");
  const entry = list.stdout
    .split("\n")
    .find((line) => line.includes(AGENT_HARNESS_STASH_MESSAGE));
  if (!entry) {
    return;
  }
  const ref = entry.slice(0, entry.indexOf(":"));
  await runShell(`git stash drop ${ref}`);
}

export async function syncWithBaseBranch(
  baseBranch: string,
  conflictNextStep: string,
  options: SyncWithBaseOptions = {},
): Promise<string> {
  await fetchBase(baseBranch);
  const shouldMerge =
    options.force === true || (await needsBaseSync(baseBranch));
  if (!shouldMerge) {
    await overlayAgentHarnessFromBase(baseBranch);
    return `(branch is up to date with ${baseBranch})`;
  }

  const stashedHarness = await stashAgentHarnessOverlay();
  let sync: SyncResult;
  try {
    sync = await mergeBase(baseBranch);
  } finally {
    await overlayAgentHarnessFromBase(baseBranch);
    if (stashedHarness) {
      await dropAgentHarnessStash();
    }
  }

  if (sync.status === "clean") {
    return `(branch is up to date with ${baseBranch})`;
  }
  if (sync.status === "merged") {
    return `(merged ${baseBranch} successfully, no conflicts)`;
  }

  const status = await runShell("git status --porcelain");
  return [
    `(MERGE CONFLICT after merging ${baseBranch})`,
    "Conflicting files:",
    ...sync.conflictFiles.map((file) => `- ${file}`),
    "",
    "Git status:",
    status.stdout || "(unknown)",
    "",
    conflictNextStep,
  ].join("\n");
}

export async function getConflictFiles(): Promise<string[]> {
  const result = await runShell("git diff --name-only --diff-filter=U");
  if (result.exitCode !== 0) {
    throw new Error(`Could not list conflict files: ${result.stderr}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Line-anchored markers from `git merge` (not prose in prompts or regex strings). */
export const GIT_CONFLICT_MARKER_GREP = "^<<<<<<< |^>>>>>>> |^=======$";

export async function hasConflictMarkers(files?: string[]): Promise<boolean> {
  const paths = files ?? (await getConflictFiles());
  if (paths.length === 0) {
    return false;
  }
  const result = await runShell(
    `grep -lE ${JSON.stringify(GIT_CONFLICT_MARKER_GREP)} ${paths
      .map((p) => JSON.stringify(p))
      .join(" ")}`,
  );
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

export async function findPathsWithConflictMarkers(): Promise<string[]> {
  const result = await runShell(
    `git grep -lE ${JSON.stringify(GIT_CONFLICT_MARKER_GREP)} -- . 2>/dev/null || true`,
  );
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function assertNoConflictMarkersInRepository(): Promise<void> {
  const paths = await findPathsWithConflictMarkers();
  if (paths.length > 0) {
    throw new Error(`Unresolved merge conflicts remain: ${paths.join(", ")}`);
  }
}

/**
 * Stage resolved files when a merge is in progress, then verify the tree is committable.
 * The runner's `commitAll` completes the merge commit afterward.
 */
export async function prepareResolvedMergeForCommit(): Promise<void> {
  const mergeHead = await runShell("git rev-parse -q --verify MERGE_HEAD");
  if (mergeHead.exitCode === 0) {
    const add = await runShell(gitAddAllExcludingPipelineCheckoutCommand());
    if (add.exitCode !== 0) {
      const fallback = await runShell("git add -A");
      if (fallback.exitCode !== 0) {
        throw new Error(`git add failed: ${fallback.stderr || fallback.stdout}`);
      }
      await runShell(unstagePipelineCheckoutCommand());
    }
  }

  const conflictFiles = await getConflictFiles();
  if (conflictFiles.length > 0) {
    throw new Error(
      `Unresolved merge conflicts remain: ${conflictFiles.join(", ")}`,
    );
  }

  await assertNoConflictMarkersInRepository();
}

/** Fail if a merge was left incomplete after commit/push. */
export async function assertLocalMergeResolved(): Promise<void> {
  const mergeHead = await runShell("git rev-parse -q --verify MERGE_HEAD");
  if (mergeHead.exitCode === 0) {
    throw new Error(
      "Merge is still in progress after commit; the runner should have completed the merge commit.",
    );
  }

  await assertNoConflictMarkersInRepository();
}
