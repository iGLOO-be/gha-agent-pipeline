import { loadAgentConfig } from "../config.js";
import { runShell } from "../tools/shell.js";

const { git: gitConfig } = loadAgentConfig();

export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function branchName(
  issueNumber: number,
  title: string,
  prefix = gitConfig.branch_prefix,
): string {
  const slug = slugifyTitle(title) || "change";
  return `${prefix}/${issueNumber}-${slug}`;
}

export async function createAndCheckoutBranch(
  branch: string,
  baseBranch = gitConfig.base_branch,
): Promise<void> {
  const fetch = await runShell(`git fetch origin ${baseBranch}`);
  if (fetch.exitCode !== 0) {
    throw new Error(`git fetch failed: ${fetch.stderr}`);
  }

  const checkout = await runShell(
    `git checkout -B ${branch} origin/${baseBranch}`,
  );
  if (checkout.exitCode !== 0) {
    throw new Error(`git checkout failed: ${checkout.stderr}`);
  }
}
