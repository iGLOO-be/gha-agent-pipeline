import {
  REVIEW_FIX_MODEL,
  loadAgentConfig,
  loadReviewFixEnv,
  parseRepository,
} from "./config.js";
import { prepareCommandRuntime } from "./command-runtime.js";
import { runFixPhase } from "./fix-phase.js";
import { runAgentPhase } from "./lifecycle.js";
import { runAgentMain } from "./runtime.js";
import { createOctokit } from "./tools/github.js";

const env = loadReviewFixEnv();
const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
const octokit = createOctokit(env.GITHUB_TOKEN);
const bootCmd = prepareCommandRuntime(
  "review-fix",
  REVIEW_FIX_MODEL,
  loadAgentConfig(),
);

async function main() {
  await runFixPhase("review-fix", env);
}

runAgentMain(() =>
  runAgentPhase({
    phase: bootCmd.runtimePhase,
    displayLabel: bootCmd.displayLabel,
    octokit,
    owner,
    repo,
    issueNumber: env.ISSUE_NUMBER,
    prNumber: env.PR_NUMBER,
    main,
  }),
);
