import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentConfig } from "../config.js";
import { runGh, runShell } from "../tools/shell.js";

const { git: gitConfig } = loadAgentConfig();

export async function commitAll(message: string): Promise<boolean> {
  await runShell("git add -A");
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

export async function pushBranch(branch: string): Promise<void> {
  let push = await runShell(`git push -u origin ${branch}`);
  if (push.exitCode !== 0 && push.stderr.includes("non-fast-forward")) {
    push = await runShell(`git push -u origin ${branch} --force-with-lease`);
  }
  if (push.exitCode !== 0) {
    throw new Error(`git push failed: ${push.stderr}`);
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
