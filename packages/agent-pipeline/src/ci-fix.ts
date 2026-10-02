import { loadCiFixEnv, parseRepository } from "./config.js";
import { runFixPhase } from "./fix-phase.js";
import { runAgentMain } from "./runtime.js";
import { runAgentPhase } from "./lifecycle.js";
import { createOctokit } from "./tools/github.js";

async function main() {
  await runFixPhase("ci-fix", env);
}

const env = loadCiFixEnv();
const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
const octokit = createOctokit(env.GITHUB_TOKEN);

runAgentMain(() =>
  runAgentPhase({
    phase: "ci-fix",
    octokit,
    owner,
    repo,
    issueNumber: env.ISSUE_NUMBER,
    prNumber: env.PR_NUMBER,
    main,
  }),
);
