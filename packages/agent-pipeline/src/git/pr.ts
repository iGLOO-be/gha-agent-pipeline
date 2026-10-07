import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentConfig } from "../config.js";
import { sleep } from "../session-retry.js";
import { runGh, runShell } from "../tools/shell.js";
import {
  gitAddAllExcludingPipelineCheckoutCommand,
  gitStatusPorcelainExcludingPipelineCheckoutCommand,
  unstagePipelineCheckoutCommand,
} from "./worktree-excludes.js";

async function isMergeInProgress(): Promise<boolean> {
  const mergeHead = await runShell("git rev-parse -q --verify MERGE_HEAD");
  return mergeHead.exitCode === 0;
}

export async function commitAll(message: string): Promise<boolean> {
  const add = await runShell(gitAddAllExcludingPipelineCheckoutCommand());
  if (add.exitCode !== 0) {
    await runShell("git add -A");
    await runShell(unstagePipelineCheckoutCommand());
  }
  const status = await runShell("git diff --cached --quiet");
  const mergeInProgress = await isMergeInProgress();
  if (status.exitCode === 0 && !mergeInProgress) {
    return false;
  }

  const commit = await runShell(`git commit -m ${JSON.stringify(message)}`);
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed: ${commit.stderr}`);
  }
  return true;
}

const NETWORK_ERROR_PATTERN =
  /unable to access|failed to connect|couldn't connect|could not resolve host|timed out|connection reset|connection refused|network is unreachable/i;

export function getPushMaxAttempts(): number {
  const raw = process.env.AGENT_PUSH_MAX_ATTEMPTS;
  if (!raw) {
    return 3;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10) {
    return 3;
  }
  return parsed;
}

export function getPushRetryBaseDelayMs(): number {
  const raw = process.env.AGENT_PUSH_RETRY_BASE_DELAY_MS;
  if (!raw) {
    return 10_000;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 10_000;
  }
  return parsed;
}

function isNetworkPushError(stderr: string): boolean {
  return NETWORK_ERROR_PATTERN.test(stderr);
}

export async function pushBranch(branch: string): Promise<void> {
  const pushCommand = `git push -u origin ${branch}`;
  const maxAttempts = getPushMaxAttempts();
  const baseDelayMs = getPushRetryBaseDelayMs();

  let push = await runShell(pushCommand);
  let attempts = 1;

  // Retry transient network errors with exponential backoff.
  while (
    attempts < maxAttempts &&
    push.exitCode !== 0 &&
    !push.stderr.includes("non-fast-forward") &&
    isNetworkPushError(push.stderr)
  ) {
    await sleep(baseDelayMs * 2 ** (attempts - 1));
    push = await runShell(pushCommand);
    attempts += 1;
  }

  if (push.exitCode !== 0 && push.stderr.includes("non-fast-forward")) {
    push = await runShell(`${pushCommand} --force-with-lease`);
    if (push.exitCode !== 0) {
      throw new Error(`git push failed: ${push.stderr}`);
    }
    return;
  }

  if (push.exitCode !== 0) {
    const label = attempts === 1 ? "attempt" : "attempts";
    throw new Error(
      `git push failed after ${attempts} ${label}: ${push.stderr}`,
    );
  }
}

export type CommitAndPushResult =
  { status: "pushed"; commitsAhead: number } | { status: "noChanges" };

export async function commitAndPushBranch(
  branch: string,
  message: string,
  options?: { baseBranch?: string },
): Promise<CommitAndPushResult> {
  const baseBranch = options?.baseBranch ?? loadAgentConfig().git.base_branch;

  const committed = await commitAll(message);

  const remoteRef = `origin/${branch}`;
  const remoteBranchExists =
    (await runShell(`git rev-parse --verify --quiet ${remoteRef}`)).exitCode ===
    0;
  const range = remoteBranchExists
    ? `${remoteRef}..HEAD`
    : `origin/${baseBranch}..HEAD`;

  const aheadResult = await runShell(`git rev-list --count ${range}`);
  let ahead = 0;
  const revListExit = aheadResult.exitCode;
  if (revListExit === 0) {
    ahead = parseInt(aheadResult.stdout.trim(), 10) || 0;
  } else {
    // Ignore untracked excluded artifacts (pipeline checkout, agent state) so
    // the diagnostic reflects real working-tree changes only.
    const porcelain = await runShell(
      gitStatusPorcelainExcludingPipelineCheckoutCommand(),
    );
    const dirty =
      porcelain.exitCode === 0 && porcelain.stdout.trim().length > 0;
    if (committed || dirty) {
      throw new Error(
        `commitAndPushBranch: could not count commits ahead (range=${range}, rev-list exit ${revListExit}). ` +
          `Committed=${committed}, working tree dirty=${dirty}. ` +
          `Ensure origin/${baseBranch} is fetched (not a shallow clone missing the ref). ` +
          `stderr: ${aheadResult.stderr.trim()}`,
      );
    }
    throw new Error(
      `commitAndPushBranch: git rev-list --count failed for range ${range} (exit ${revListExit}): ${aheadResult.stderr.trim()}`,
    );
  }

  console.log(
    `commitAndPushBranch: committed=${committed} ahead=${ahead} range=${range} remoteExists=${remoteBranchExists} revListExit=${revListExit}`,
  );

  if (committed || ahead > 0) {
    await pushBranch(branch);
    return { status: "pushed", commitsAhead: ahead + (committed ? 1 : 0) };
  }

  return { status: "noChanges" };
}

export async function createPullRequest(
  title: string,
  body: string,
  branch: string,
  base?: string,
): Promise<{ url: string; number: number }> {
  const prTarget = base ?? loadAgentConfig().git.pr_target;
  const tempDir = await mkdtemp(join(tmpdir(), "agent-pr-"));
  const bodyPath = join(tempDir, "body.md");

  try {
    await writeFile(bodyPath, body, "utf8");

    const result = await runGh(
      `gh pr create --title ${JSON.stringify(title)} --body-file ${JSON.stringify(bodyPath)} --head ${branch} --base ${prTarget}`,
    );
    if (result.exitCode !== 0) {
      const existingUrl = result.stderr.match(
        /https:\/\/github\.com\/[^\s]+\/pull\/\d+/,
      )?.[0];
      if (existingUrl) {
        const prNumber = extractPRNumberFromUrl(existingUrl);
        return { url: existingUrl, number: prNumber };
      }
      throw new Error(`gh pr create failed: ${result.stderr}`);
    }

    const url = result.stdout.trim();
    const prNumber = extractPRNumberFromUrl(url);
    return { url, number: prNumber };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function extractPRNumberFromUrl(url: string): number {
  const match = url.match(/\/pull\/(\d+)$/);
  if (!match) {
    throw new Error(`Could not extract PR number from URL: ${url}`);
  }
  return parseInt(match[1], 10);
}

export async function findOpenPullRequestForBranch(
  branch: string,
): Promise<{ url: string; number: number } | null> {
  const result = await runGh(
    `gh pr list --head ${JSON.stringify(branch)} --state open --json number,url --limit 1`,
  );
  if (result.exitCode !== 0) {
    return null;
  }
  const trimmed = result.stdout.trim();
  if (!trimmed || trimmed === "[]") {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Array<{
      number: number;
      url: string;
    }>;
    const first = parsed[0];
    if (!first?.url || first.number == null) {
      return null;
    }
    return { url: first.url, number: first.number };
  } catch {
    return null;
  }
}
