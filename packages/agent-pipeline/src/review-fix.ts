import { loadReviewFixEnv, parseRepository } from "./config.js";
import { runFixPhase } from "./fix-phase.js";
import { runAgentMain } from "./runtime.js";
import { runAgentPhase } from "./lifecycle.js";
import { createOctokit } from "./tools/github.js";

async function main() {
  await runFixPhase("review-fix");
}

const env = loadReviewFixEnv();
const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
const octokit = createOctokit(env.GITHUB_TOKEN);

runAgentMain(() =>
  runAgentPhase({
    phase: "review-fix",
    octokit,
    owner,
    repo,
    issueNumber: env.ISSUE_NUMBER,
    prNumber: env.PR_NUMBER,
    main,
  }),
);
