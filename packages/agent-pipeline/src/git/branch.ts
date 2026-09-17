import { loadAgentConfig } from "../config.js";
import { runShell } from "../tools/shell.js";

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
  prefix?: string,
): string {
  const gitConfig = loadAgentConfig().git;
  const branchPrefix = prefix ?? gitConfig.branch_prefix;
  const slug = slugifyTitle(title) || "change";
  return `${branchPrefix}/${issueNumber}-${slug}`;
}

export function resolveYoloBranchName(
  issueNumber: number,
  title: string,
  agentBranch?: string,
  branchPrefix?: string,
): string {
  if (agentBranch) {
    return agentBranch;
  }
  return branchName(issueNumber, title, branchPrefix);
}

export async function createAndCheckoutBranch(
  branch: string,
  baseBranch?: string,
): Promise<void> {
  const gitConfig = loadAgentConfig().git;
  const resolvedBase = baseBranch ?? gitConfig.base_branch;
  const fetch = await runShell(`git fetch origin ${resolvedBase}`);
  if (fetch.exitCode !== 0) {
    throw new Error(`git fetch failed: ${fetch.stderr}`);
  }

  const checkout = await runShell(
    `git checkout -B ${branch} origin/${resolvedBase}`,
  );
  if (checkout.exitCode !== 0) {
    throw new Error(`git checkout failed: ${checkout.stderr}`);
  }
}

export async function checkoutExistingBranch(branch: string): Promise<void> {
  const fetch = await runShell(`git fetch origin ${branch}`);
  if (fetch.exitCode !== 0) {
    throw new Error(
      `Failed to fetch origin/${branch}: ${fetch.stderr || fetch.stdout}`,
    );
  }

  const checkout = await runShell(`git checkout -B ${branch} origin/${branch}`);
  if (checkout.exitCode !== 0) {
    throw new Error(`git checkout failed: ${checkout.stderr}`);
  }
}
