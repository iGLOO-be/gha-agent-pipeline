import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { FILE_EDIT_SYSTEM_HINT } from "./prompts/file-edits.js";
import { RUN_FRICTION_SYSTEM_HINT } from "./prompts/run-friction.js";

export const agentConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    git: z
      .object({
        base_branch: z.string().min(1).default("main"),
        pr_target: z.string().min(1).optional(),
        branch_prefix: z.string().min(1).default("agent"),
        merge_strategy: z.enum(["merge", "rebase"]).default("merge"),
      })
      .default({}),
    models: z
      .object({
        plan: z.string().min(1).default("deepseek/deepseek-v4-pro"),
        implement: z.string().min(1).default("moonshotai/kimi-k2.7-code"),
        "ci-fix": z.string().min(1).default("moonshotai/kimi-k2.7-code"),
        "review-fix": z.string().min(1).default("moonshotai/kimi-k2.7-code"),
        ask: z.string().min(1).default("deepseek/deepseek-v4-pro"),
        "code-review": z.string().min(1).default("deepseek/deepseek-v4-pro"),
      })
      .default({}),
    ci: z
      .object({
        max_rounds: z.number().int().positive().default(3),
      })
      .default({}),
    prompts: z
      .object({
        plan: z
          .object({
            role_description: z
              .string()
              .min(1)
              .default("You are a planning agent for this repository."),
          })
          .default({}),
        implement: z
          .object({
            role_description: z
              .string()
              .min(1)
              .default("You are an implementation agent for this repository."),
          })
          .default({}),
        "ci-fix": z
          .object({
            role_description: z
              .string()
              .min(1)
              .default("You are a CI fix agent for this repository."),
          })
          .default({}),
        yolo: z
          .object({
            role_description: z
              .string()
              .min(1)
              .default("You are an implementation agent for this repository."),
          })
          .default({}),
        "review-fix": z
          .object({
            role_description: z
              .string()
              .min(1)
              .default("You are a review fix agent for this repository."),
          })
          .default({}),
        ask: z
          .object({
            role_description: z
              .string()
              .min(1)
              .default("You are a Q&A agent for this repository."),
          })
          .default({}),
        "code-review": z
          .object({
            role_description: z
              .string()
              .min(1)
              .default("You are a code review agent for this repository."),
          })
          .default({}),
      })
      .default({}),
    tools: z
      .object({
        run_commands_timeout_ms: z.number().int().min(1000).default(600_000),
      })
      .default({}),
    app: z
      .object({
        name: z.string().min(1).optional(),
      })
      .default({}),
  })
  .transform((data) => ({
    version: data.version,
    git: {
      ...data.git,
      pr_target: data.git.pr_target ?? data.git.base_branch,
    },
    models: data.models,
    ci: data.ci,
    prompts: data.prompts,
    tools: data.tools,
    app: data.app,
  }));

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type MergeStrategy = AgentConfig["git"]["merge_strategy"];

export type AgentPhase =
  | "plan"
  | "implement"
  | "yolo"
  | "ci-fix"
  | "review-fix"
  | "ask"
  | "code-review";

function applyAgentConfigEnvOverrides(config: AgentConfig): AgentConfig {
  const baseBranchOverride = process.env.AGENT_BASE_BRANCH?.trim();
  if (!baseBranchOverride) {
    return config;
  }
  const previousBase = config.git.base_branch;
  return {
    ...config,
    git: {
      ...config.git,
      base_branch: baseBranchOverride,
      pr_target:
        config.git.pr_target === previousBase
          ? baseBranchOverride
          : config.git.pr_target,
    },
  };
}

export function loadAgentConfig(
  configPath = ".github/agent.config.yml",
): AgentConfig {
  let raw: unknown = {};
  if (existsSync(configPath)) {
    const content = readFileSync(configPath, "utf8");
    raw = parseYaml(content) ?? {};
  }

  const parsed = agentConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid ${configPath}: ${issues}`);
  }

  return applyAgentConfigEnvOverrides(parsed.data);
}

export function getRunCommandsTimeoutMs(config?: AgentConfig): number {
  const envRaw = process.env.AGENT_RUN_COMMANDS_TIMEOUT_MS;
  if (envRaw) {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed >= 1000) {
      return parsed;
    }
  }
  const resolved = config ?? loadAgentConfig();
  return resolved.tools.run_commands_timeout_ms;
}

const GIT_SHALLOW_WORKSPACE_HINT = `
Git on CI checkouts is often shallow. Do not run \`git fetch --unshallow\` on large monorepos. Prefer \`git show origin/<ref>:path\` to read files at a ref, or \`git fetch origin <ref> --depth=1\` followed by \`git checkout FETCH_HEAD\` when you need a tree at that ref.`;

const planPromptBody = `Your job is to read the GitHub issue, explore the codebase with read_files and search_codebase, and post a structured implementation plan.

CRITICAL — completion rule:
- Every run MUST end by calling submitPlan. No exceptions.
- Do not finish by replying in chat, summarizing in text, or saying the existing plan is sufficient.
- If a prior "## Agent Plan" comment already exists and you agree with it, still call submitPlan (repost the same plan or a lightly refreshed copy).
- A run that does not call submitPlan is a failure.

When re-planning after human feedback:
- Call readComments to load the full issue conversation.
- Read any prior "## Agent Plan" comment and all human feedback after it.
- Post a REVISED plan that explicitly incorporates the human feedback.
- Do not repeat a rejected approach when the human asked for changes.
- Always use the exact heading \`## Agent Plan\` even when revising (never \`## Revised Agent Plan\`).

Workflow:
1. Call readIssue to understand the request.
2. Call readComments to see prior discussion, previous plans, and human feedback.
3. Use list_files to explore the directory tree, read_files and search_codebase to inspect relevant files. Use run_commands only for commands that have no tool equivalent (e.g. builds, tests, lint).
4. Call submitPlan with:
   - \`body\`: markdown using this structure (do **not** include \`### Risk score\` in the body — the runner adds it from your structured fields):
   - \`riskLevel\`: one of \`low\`, \`medium\`, \`high\` (lowercase)
   - \`riskJustification\`: one paragraph (scope/size, code surface, infra/workflows, security, reversibility)

## Agent Plan

### Executive summary
<up to 10 lines summarizing what will be done and why — for humans who only read this section>

<details><summary>📋 Full plan</summary>

### Files to change
- \`path/to/file\` — <what to change>

### Steps
1. <step>
2. <step>

### Risks
- <risk or "None">

</details>

### Next steps for humans
- Review the plan above
- Comment on the issue to request changes if needed
- Run \`/agent plan\` again to revise, or \`/agent implement\` to execute

Do not modify files. submitPlan is the only valid way to finish.`;

const SUBMIT_PHASE_REPORT_PROMPT = `
After you have finished all edits, call \`submitPhaseReport\` with a concise human-readable summary.  
If the repo contains an \`AGENTS.md\` with an **"Agent phase report"** (or **"Agent PR summary"**) section, follow its instructions. Otherwise summarize: what changed, which files were touched, and how to test your work.  
The report is optional but encouraged.

Use \`###\` headings or lower only; never emit top-level \`##\` headings — the runner provides the structural heading. Do not emit \`### Run metrics\` or \`### Run friction\` sections; those are injected automatically by the runner.`;
const implementPromptBody = `Implement the GitHub issue using the provided plan.

Workflow:
1. Read the issue and existing comments if needed.
2. Use list_files, read_files, search_codebase, editor, and apply_patch to inspect and modify files.
3. Keep changes minimal and focused on the issue.
4. Read AGENTS.md and the repo docs (README, package.json scripts) to understand the project conventions. If formatting or linting is part of the repo workflow, run the documented commands via run_commands during your session. Do not run Prettier on \`.\` unless the repo explicitly instructs it.
${GIT_SHALLOW_WORKSPACE_HINT}

${FILE_EDIT_SYSTEM_HINT}

${RUN_FRICTION_SYSTEM_HINT}

${SUBMIT_PHASE_REPORT_PROMPT}

Do not commit, push, or open a PR yourself. The runner will handle git operations after you finish.

Never announce completion or post comments on the GitHub issue. The runner will post the summary comment after pushing and opening the PR.`;

const ciFixPromptBody = `The pull request failed CI. Fix the code so lint and build pass.

Workflow:
1. Use readCheckRuns and readCheckLogs to understand failures.
2. Use list_files, read_files, search_codebase, editor, and apply_patch to fix the code.
3. Keep changes minimal and focused on CI failures.
4. Read AGENTS.md and the repo docs (README, package.json scripts) to understand the project conventions. If formatting or linting is part of the repo workflow, run the documented commands via run_commands during your session. Do not run Prettier on \`.\` unless the repo explicitly instructs it.
${GIT_SHALLOW_WORKSPACE_HINT}

${FILE_EDIT_SYSTEM_HINT}

${RUN_FRICTION_SYSTEM_HINT}

${SUBMIT_PHASE_REPORT_PROMPT}

Do not commit or push. The runner will handle git operations after you finish.`;

const yoloPromptBody = `Implement the GitHub issue using the instructions in the issue description.

Workflow:
1. Read the issue and existing comments if needed.
2. Use list_files, read_files, search_codebase, editor, and apply_patch to inspect and modify files.
3. Keep changes minimal and focused on the issue.
4. Read AGENTS.md and the repo docs (README, package.json scripts) to understand the project conventions. If formatting or linting is part of the repo workflow, run the documented commands via run_commands during your session. Do not run Prettier on \`.\` unless the repo explicitly instructs it.
${GIT_SHALLOW_WORKSPACE_HINT}

${FILE_EDIT_SYSTEM_HINT}

${RUN_FRICTION_SYSTEM_HINT}

${SUBMIT_PHASE_REPORT_PROMPT}

Do not commit, push, or open a PR yourself. The runner will handle git operations after you finish.

When you call \`submitPhaseReport\`, you **must** include \`riskLevel\` (\`low\` | \`medium\` | \`high\`) and \`riskJustification\` (one paragraph). The runner applies agent-risk-* labels from these fields — do not add a separate risk block in chat output.`;

function codeReviewPromptBody(): string {
  return `You are an agent in the **code-review** phase — a read-only two-axis review of the pull request diff. Your job is to review whether the change follows this repo's documented coding standards and whether it faithfully implements the originating issue / spec.

CRITICAL — completion rule:
- You MUST end every run by calling submitReview.
- Do not finish by replying in chat or summarizing in text.
- A run that does not call submitReview is a failure.

The two axes are deliberately separate. Do not merge, rerank, or pick a single winner across them:

- **Standards**: does the diff conform to documented repo standards, plus the smell baseline below?
- **Spec**: does the diff faithfully implement the originating issue / spec?

Workflow:
1. Read the injected diff, commit list, source issue, and PR body. Use readIssue / readComments / readPrComments if you need more thread context.
2. Use list_files, read_files, and search_codebase to inspect files named in the diff. Do not modify any files (no editor, no apply_patch).
3. Call submitReview with:
   - \`event\`: \`REQUEST_CHANGES\` only when there is a **hard** finding (documented-standard breach, or a spec requirement missing / wrong). Otherwise \`COMMENT\`. Never \`APPROVE\`.
   - \`body\`: markdown that starts with \`## Standards\` then \`## Spec\`. Report each axis independently. Under each heading, list findings per file/hunk, or say there are none.
   - \`comments\` (optional): inline comments on the PR diff (\`path\`, \`line\`, optional \`side\` defaulting to RIGHT, \`body\`). Only comment on lines that appear in the injected diff.

Standards rules:
- A documented repo standard always wins over the smell baseline.
- Documented-standard breaches can be hard findings. Baseline smells are always judgement calls — label them as such (e.g. "possible Feature Envy").
- Skip anything tooling already enforces (formatter, typecheck, lint, tests).

Smell baseline (Fowler, *Refactoring* ch.3) — what it is → how to fix:
- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same \`switch\`/\`if\`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long \`a.b().c().d()\` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

Spec report:
- (a) requirements the spec asked for that are missing or partial
- (b) behaviour in the diff that wasn't asked for (scope creep)
- (c) requirements that look implemented but where the implementation looks wrong
Quote the spec line for each finding. If there is no spec, say so under \`## Spec\` and skip that axis.

Do not emit \`### Run metrics\` or \`### Run friction\`; those are injected automatically by the runner.
Read AGENTS.md section **Agent code-review** if present for additional tone/scope guidance.`;
}

function askPromptBody(): string {
  return `You are an agent in the **ask** phase — a read-only Q&A mode. Your job is to answer a human question about a GitHub issue or an agent pull request using the issue/PR thread and codebase exploration.

CRITICAL — completion rule:
- You MUST end every run by calling submitAnswer with your answer.
- Do not finish by replying in chat or summarizing in text.
- A run that does not call submitAnswer is a failure.

Workflow:
1. Call readIssue to understand the issue context.
2. Call readComments to read the full conversation thread.
3. If a PR_NUMBER is set, use readComments on that PR to read the PR discussion.
4. Use list_files, read_files, and search_codebase to explore relevant code as needed.
5. Formulate a clear, concise answer, then call submitAnswer with your answer body in markdown starting with ## Agent answer.

Guidelines:
- Answer based on the thread context and codebase exploration only.
- Do not speculate about things you cannot verify from the codebase or thread.
- Do not modify any files (no editor, no apply_patch).
- Read AGENTS.md section **Agent ask** if present for additional tone/scope guidance.
- Keep answers concise and actionable.`;
}

function reviewFixPromptBody(config: AgentConfig): string {
  return `A human left review feedback on an open agent pull request. Update the code on the existing branch to address the feedback.

Workflow:
1. Read the review feedback and PR discussion.
2. Use list_files, read_files, search_codebase, editor, and apply_patch to apply minimal changes.
3. Read AGENTS.md and the repo docs (README, package.json scripts) to understand the project conventions. If formatting or linting is part of the repo workflow, run the documented commands via run_commands during your session. Do not run Prettier on \`.\` unless the repo explicitly instructs it.
${GIT_SHALLOW_WORKSPACE_HINT}

Merge handling:
- The runner synchronizes the branch with ${config.git.base_branch} using the default "${config.git.merge_strategy}" strategy before this session.
- If the merge context below reports conflicts, resolve them FIRST using read_files and editor. Remove ALL conflict markers (<<<<<<<, =======, >>>>>>>) and keep the correct resolution.
- After conflicts are resolved, address the review feedback in the same session.
- Use getMergeStatus at any time to re-check the local conflict file list and the PR mergeable state.
- Do not run git commands yourself and do not abort the merge.

${FILE_EDIT_SYSTEM_HINT}

${RUN_FRICTION_SYSTEM_HINT}

${SUBMIT_PHASE_REPORT_PROMPT}

Do not commit or push. The runner will handle git operations after you finish.`;
}

const PHASE_PROMPT_BODY: Record<AgentPhase, (config: AgentConfig) => string> = {
  plan: () => planPromptBody,
  implement: () => implementPromptBody,
  "ci-fix": () => ciFixPromptBody,
  yolo: () => yoloPromptBody,
  "review-fix": reviewFixPromptBody,
  ask: () => askPromptBody(),
  "code-review": () => codeReviewPromptBody(),
};

export function getAppName(config?: AgentConfig): string {
  if (config?.app?.name) {
    return config.app.name;
  }
  const repository = process.env.GITHUB_REPOSITORY;
  if (repository) {
    const [, repo] = repository.split("/");
    if (repo) return repo;
  }
  return "gha-agent";
}

export function buildPhaseSystemPrompt(
  phase: AgentPhase,
  config?: AgentConfig,
): string {
  const resolved = config ?? loadAgentConfig();
  const roleDescription = resolved.prompts[phase].role_description;
  const body = PHASE_PROMPT_BODY[phase](resolved);
  return `${roleDescription}\n\n${body}`;
}

const agentConfig = loadAgentConfig();

export const PLAN_MODEL = agentConfig.models.plan;
export const IMPLEMENT_MODEL = agentConfig.models.implement;
export const YOLO_MODEL = IMPLEMENT_MODEL;
export const CI_FIX_MODEL = agentConfig.models["ci-fix"];
export const REVIEW_FIX_MODEL = agentConfig.models["review-fix"];
export const ASK_MODEL = agentConfig.models.ask;
export const CODE_REVIEW_MODEL = agentConfig.models["code-review"];
export const DEFAULT_MERGE_STRATEGY = agentConfig.git.merge_strategy;

export function getCiMaxRounds(): number {
  const envRaw = process.env.CI_MAX_ROUNDS;
  if (envRaw) {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return agentConfig.ci.max_rounds;
}

const optionalEnvString = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return value;
}, z.string().min(1).optional());

const envSchema = z.object({
  OPENROUTER_API_KEY: z.string().min(1),
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_REPOSITORY: z.string().min(1),
  ISSUE_NUMBER: z.coerce.number().int().positive(),
  AGENT_BRANCH: optionalEnvString,
});

const ciFixEnvSchema = envSchema.extend({
  PR_NUMBER: z.coerce.number().int().positive(),
  HEAD_SHA: z.string().min(1),
});

export type AgentEnv = z.infer<typeof envSchema>;

export function loadAgentEnv(): AgentEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid agent environment: ${missing}`);
  }
  return parsed.data;
}

const reviewFixEnvSchema = envSchema.extend({
  PR_NUMBER: z.coerce.number().int().positive(),
  AGENT_BRANCH: z.string().min(1),
  REVIEW_FEEDBACK: z.string().min(1),
});

export type CiFixEnv = z.infer<typeof ciFixEnvSchema>;
export type ReviewFixEnv = z.infer<typeof reviewFixEnvSchema>;

export function loadCiFixEnv(): CiFixEnv {
  const parsed = ciFixEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid ci-fix environment: ${missing}`);
  }
  return parsed.data;
}

export function loadReviewFixEnv(): ReviewFixEnv {
  const parsed = reviewFixEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid review-fix environment: ${missing}`);
  }
  return parsed.data;
}

/** GitHub Actions sets unset optional inputs to "" — treat as missing. */
const optionalEnvPositiveInt = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return value;
}, z.coerce.number().int().positive().optional());

const askEnvSchema = envSchema.extend({
  QUESTION: z.string().min(1),
  PR_NUMBER: optionalEnvPositiveInt,
});

export type AskEnv = z.infer<typeof askEnvSchema>;

export function loadAskEnv(): AskEnv {
  const parsed = askEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid ask environment: ${missing}`);
  }
  return parsed.data;
}

const codeReviewEnvSchema = envSchema.extend({
  PR_NUMBER: z.coerce.number().int().positive(),
  REVIEW_INSTRUCTIONS: optionalEnvString,
});

export type CodeReviewEnv = z.infer<typeof codeReviewEnvSchema>;

export function loadCodeReviewEnv(): CodeReviewEnv {
  const parsed = codeReviewEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid code-review environment: ${missing}`);
  }
  return parsed.data;
}

export function parseRepository(repository: string): {
  owner: string;
  repo: string;
} {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`);
  }
  return { owner, repo };
}

const BUILTIN_READ_TOOLS = [
  "read_files",
  "search_codebase",
  "run_commands",
  "fetch_web_content",
] as const;

const BUILTIN_WRITE_TOOLS = ["editor", "apply_patch"] as const;

const DISABLED_BUILTIN_TOOLS = [
  "ask_question",
  "skills",
  "submit_and_exit",
] as const;

function disabledPolicies(toolNames: readonly string[]) {
  return Object.fromEntries(
    toolNames.map((name) => [name, { enabled: false }]),
  );
}

function approvedPolicies(toolNames: readonly string[]) {
  return Object.fromEntries(
    toolNames.map((name) => [name, { autoApprove: true }]),
  );
}

export function buildToolPolicies(
  phase: AgentPhase,
  customToolNames: string[],
) {
  const writeTools =
    phase === "implement" ||
    phase === "yolo" ||
    phase === "ci-fix" ||
    phase === "review-fix"
      ? BUILTIN_WRITE_TOOLS
      : [];

  return {
    ...approvedPolicies(BUILTIN_READ_TOOLS),
    ...approvedPolicies(writeTools),
    ...approvedPolicies(customToolNames),
    ...disabledPolicies(DISABLED_BUILTIN_TOOLS),
  };
}
