import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentConfig } from "../config.js";
import { sleep } from "../session-retry.js";
import { runGh, runShell } from "../tools/shell.js";
import {
  gitAddAllExcludingPipelineCheckoutCommand,
  unstagePipelineCheckoutCommand,
} from "./worktree-excludes.js";

const { git: gitConfig } = loadAgentConfig();

export async function commitAll(message: string): Promise<boolean> {
  const add = await runShell(gitAddAllExcludingPipelineCheckoutCommand());
  if (add.exitCode !== 0) {
    await runShell("git add -A");
    await runShell(unstagePipelineCheckoutCommand());
  }
  const status = await runShell("git diff --cached --quiet");
  if (status.exitCode === 0) {
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
): Promise<CommitAndPushResult> {
  const committed = await commitAll(message);

  const aheadResult = await runShell(
    `git rev-list --count origin/${branch}..HEAD`,
  );
  let ahead = 0;
  if (aheadResult.exitCode === 0) {
    ahead = parseInt(aheadResult.stdout.trim(), 10) || 0;
  }

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
  base = gitConfig.pr_target,
): Promise<{ url: string; number: number }> {
  const tempDir = await mkdtemp(join(tmpdir(), "agent-pr-"));
  const bodyPath = join(tempDir, "body.md");

  try {
    await writeFile(bodyPath, body, "utf8");

    const result = await runGh(
      `gh pr create --title ${JSON.stringify(title)} --body-file ${JSON.stringify(bodyPath)} --head ${branch} --base ${base}`,
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
