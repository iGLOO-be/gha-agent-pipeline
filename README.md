# gha-agent-pipeline

Reusable GitHub Actions agent library for [gha-agent-demo](https://github.com/iGLOO-be/gha-agent-demo) and other consumers.

## Status (Phase 2)

| Piece              | Location                                                                                                                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime            | `packages/agent-pipeline/` + `agent-pipeline` CLI                                                                                                                                                                                                                                               |
| Config schema      | [`schema/agent.config.v1.schema.json`](./schema/agent.config.v1.schema.json)                                                                                                                                                                                                                    |
| Reusable workflows | [`dispatch.yml`](./.github/workflows/dispatch.yml), [`agent-ci-fix.yml`](./.github/workflows/agent-ci-fix.yml), [`agent-ci-success.yml`](./.github/workflows/agent-ci-success.yml) (`workflow_call`)                                                                                            |
| Composite actions  | **Public (post-setup):** `agent-phase-run`, `agent-ci-fix-run`. **Public (consumer wiring):** `get-pr-from-workflow-run`. **Public (pipeline install):** `install-agent-pipeline`. **Deprecated:** `run-agent-ci-fix`. **Internal:** `get-pr-from-check-suite`, legacy label/comment composites |

**Consumer-owned (other repos):** checkout, `pnpm install`, GitHub App token, and `setup-pr-environment`. Slash phases use `agent-phase-run@ref`; CI loops use `agent-ci-fix-run@ref` (post-setup). The `get-pr-from-workflow-run` composite is public for consumer use in CI fix jobs. Do **not** copy library composites into consumer repos.

**This repo also dogfoods** the same consumer wiring as [gha-agent-demo](https://github.com/iGLOO-be/gha-agent-demo) ([#3](https://github.com/iGLOO-be/gha-agent-pipeline/issues/3)): `agent.yml`, phase workflow, [`.github/agent.config.yml`](./.github/agent.config.yml), and local [`setup-pr-environment`](./.github/actions/setup-pr-environment/action.yml).

**Repository visibility:** This repository is **public** so consumers in other GitHub organizations can use `iGLOO-be/gha-agent-pipeline/...` actions and reusable workflows. No application secrets are stored here. For a **private fork** of the library, the consumer’s GitHub App must be installed on that fork (Contents read) and the fork must appear in `create-github-app-token` `repositories` (see demo `setup-pr-environment`).

## Development

```bash
pnpm install
pnpm test
pnpm run typecheck
pnpm run format:check
```

`pnpm test` includes a dogfood check that validates [`.github/agent.config.yml`](./.github/agent.config.yml) against the runtime Zod schema.

Run a phase from a **consumer repo** checkout (needs `.github/agent.config.yml` and agent env vars):

```bash
cd /path/to/gha-agent-demo
/path/to/gha-agent-pipeline/node_modules/.bin/agent-pipeline plan
```

## Consumer wiring

Triggers (`issue_comment`, `workflow_run` on CI) and **all agent phase jobs** stay on the **consumer** repo. This library provides dispatch routing and shared composite actions + CLI install.

```yaml
# .github/workflows/agent.yml (consumer)
on:
  issue_comment:
    types: [created]
  pull_request_review:
    types: [submitted]
jobs:
  dispatch:
    uses: iGLOO-be/gha-agent-pipeline/.github/workflows/dispatch.yml@v0.3.4
    secrets: inherit
    # Optional (v0.2.2+): run dispatch on another runner pool, e.g. Blacksmith
    # with:
    #   runner: blacksmith-2vcpu-ubuntu-2404
```

**Dispatch filtering (v0.2.2+):** `dispatch.yml` skips its job (no runner allocated) unless the triggering comment or review contains an allowed `/agent` slash command from an `OWNER`, `MEMBER`, or `COLLABORATOR`. Consumers do not need to duplicate this `if` in `agent.yml`; bumping `dispatch.yml` is enough. The parent **Agent pipeline** workflow run still appears on every `issue_comment` / `pull_request_review` (GitHub has no body filter on `on:`), but dispatch minutes are not consumed on no-op events.

**Dispatch scripts (v0.3.1+):** configurable slash parsing uses `.github/scripts/*.cjs` from the **pinned library ref** (`job.workflow_repository` / `job.workflow_sha`). Consumers do **not** copy those files into their own repo.

**Dispatch runner (`runner` input, v0.2.2+):** defaults to `ubuntu-latest`. Pass `with: runner: <label>` on the `uses:` job to override (same as choosing `runs-on` for a normal job).

```yaml
# .github/workflows/agent-phase.yml (consumer) — excerpt
jobs:
  agent:
    steps:
      - id: setup
        uses: ./.github/actions/setup-pr-environment
        with:
          ref: ${{ inputs.checkout_ref || inputs.head_ref || github.ref_name }}
          app_id: ${{ secrets.APP_ID }}
          app_private_key: ${{ secrets.APP_PRIVATE_KEY }}
      - uses: iGLOO-be/gha-agent-pipeline/.github/actions/agent-phase-run@v0.3.4
        with:
          phase: ${{ inputs.phase }}
          app_token: ${{ steps.setup.outputs.app_token }}
          comment_id: ${{ inputs.comment_id }}
          issue_number: ${{ inputs.issue_number }}
          pr_number: ${{ inputs.pr_number }}
          head_ref: ${{ inputs.head_ref }}
          review_feedback: ${{ inputs.review_feedback }}
          reaction_target: ${{ inputs.reaction_target }}
          chain_code_review: ${{ inputs.chain_code_review }}
          review_loop_active: ${{ inputs.review_loop_active }}
          review_loop_round: ${{ inputs.review_loop_round }}
          node_version: "24"
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

**Environment setup is never provided by the library.** The consumer owns `setup-pr-environment` (or equivalent): checkout, package manager, Node version, GitHub App token scope, extra services. The library only provides post-setup orchestration through `agent-phase-run` (install pipeline, CLI run, failure fallback, `agent-working` cleanup). `OPENROUTER_API_KEY` is forwarded via the caller's step `env` (not through the composite).

**Chained code-review:** forward the `chain_code_review` input in the consumer `agent-phase.yml` (as in the excerpt above) and grant the App **Actions read & write** (`permission-actions: write` on `create-github-app-token`) — the runtime dispatches the follow-up `agent-phase.yml` `code-review` with the App token, so a missing scope makes the chain silently no-op.

### Review loop (`review_loop` in agent.config)

Automated **implement → code-review ↔ review-fix** cycle on the new PR. Only starts when **`review_loop.enabled: true`** on a successful **`/agent implement`** (not from a manual `/agent code-review` on its own). When the loop is enabled, implement uses this path instead of `implement.follow_up.code_review` (you do not need both).

**Dogfood:** this repository runs the loop on itself during [#107](https://github.com/iGLOO-be/gha-agent-pipeline/issues/107) — [`.github/agent.config.yml`](./.github/agent.config.yml) sets `review_loop.enabled: true` with `max_rounds: 2`. Smoke test [#115](https://github.com/iGLOO-be/gha-agent-pipeline/issues/115) covered **implement → chained code-review**; the **manual review-fix** (`/agent fix`) with the **follow-up code-review recheck** is the smoke of this ticket ([#118](https://github.com/iGLOO-be/gha-agent-pipeline/issues/118)), covering **review-fix → follow-up code-review** (`review_fix.follow_up.code_review: true`).

**Flow**

1. Implement opens the PR and dispatches the first **code-review** (`review_loop_round=0`, `review_loop_active=true`).
2. If the review is **`COMMENT`** (no hard findings) → loop ends; a PR comment `<!-- agent-review-loop -->` marks success.
3. If the review is **`REQUEST_CHANGES`** and `round < review_loop.max_rounds` → dispatch **review-fix** with synthesized feedback (review body + inline comments, truncated when the payload would exceed the `workflow_dispatch` input size limit — the comment then links to the posted review).
4. After review-fix **pushes** commits → dispatch the next **code-review** with `review_loop_round` incremented.
5. Repeat from step 2 until a stop condition below.

**`review_loop.max_rounds` (default `3`)** — safety cap on the **code-review round index** (0-based). Review-fix runs only while `round < max_rounds` after a `REQUEST_CHANGES` review. Example with `max_rounds: 3`: rounds `0`, `1`, and `2` may each trigger a fix; at round `3`, another `REQUEST_CHANGES` stops the loop without auto-fix.

**Stop conditions**

| Outcome                                                                  | What happens                          |
| ------------------------------------------------------------------------ | ------------------------------------- |
| Code-review `COMMENT`                                                    | Success; loop ends                    |
| `REQUEST_CHANGES` and `round >= max_rounds`                              | PR comment; no auto review-fix        |
| Review-fix finishes with **no code changes**                             | Stall comment; no further code-review |
| Review not posted                                                        | No chain (logged warning)             |
| Dispatch rejected (`actions: write` missing, 422) or `COMMENT_ID` absent | Stop comment; loop ends               |
| Next code-review would exceed `max_rounds` after a fix push              | Cap comment; no dispatch              |

Every stop comment carries the `<!-- agent-review-loop -->` marker. A dispatch that cannot be issued — including the **initial** code-review after implement — is always surfaced as a comment, never a silent end.

**Consumer wiring** (in addition to chained code-review above):

- `agent-phase.yml` `workflow_dispatch` inputs: `review_loop_active`, `review_loop_round` (see dogfood [`.github/workflows/agent-phase.yml`](./.github/workflows/agent-phase.yml)).
- Pass them through `agent-phase-run` (excerpt above). Runtime sets `REVIEW_LOOP_ACTIVE` / `REVIEW_LOOP_ROUND` for the CLI.
- App token needs **`actions: write`** (same as any runtime `workflow_dispatch` chain).

**Config example**

```yaml
review_loop:
  enabled: true
  max_rounds: 3

code_review:
  labels:
    apply_to: pr
    status:
      ok: "ai-review:ok"
      pending: "ai-review:pending"
```

Optional `implement.follow_up.code_review` / `review_fix.follow_up.code_review` remain useful for **non-loop** runs (single chained code-review after implement or after `/agent fix`). They are not used for the implement entrypoint when `review_loop.enabled` is true.

PR comments tagged `<!-- agent-review-loop -->` document loop completion, caps, and stalls.

### Agent runner tooling (`ripgrep`)

Agent phases use shell search heavily; **`rg` (ripgrep)** on the phase runner is much faster than falling back to `grep -R`. Install it in the consumer setup composite (before `agent-phase-run`), not in the library.

**Ubuntu / Blacksmith runners** (idempotent step in `setup-pr-environment` or `setup-agent-environment`):

```yaml
- name: Install ripgrep
  shell: bash
  run: |
    if command -v rg >/dev/null 2>&1; then
      rg --version
      exit 0
    fi
    sudo apt-get update -qq
    sudo apt-get install -y ripgrep
    rg --version
```

Do not rely on `ubuntu-latest` shipping `rg` forever, and custom runner images may omit it. Verify in the **Agent phase** job log that `rg --version` runs successfully after setup.

**Node version:** `install-agent-pipeline` (via `agent-phase-run`) runs `setup-node` again after your consumer setup step, so pass `node_version` on `agent-phase-run` to match `engines.node` / `.node-version` (default `22` for backward compatibility).

**Pinning:** Internal composites in `agent-phase-run` use the [`$/`](https://github.blog/changelog/2026-07-30-reference-same-repository-actions-with-self-repository-syntax/) self-repository syntax so they match the tag or SHA you pin on `agent-phase-run`. The pipeline CLI checkout uses the same ref as that pin unless you set `pipeline_ref` explicitly (for example `pipeline_ref: main` to float the runtime on `main` while keeping composite definitions on a release tag).

```yaml
# .github/workflows/agent-on-ci-failure.yml (consumer) — thin wrapper (legacy)
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
concurrency:
  group: agent-ci-${{ github.event.workflow_run.head_branch }}
  cancel-in-progress: false
jobs:
  ci-fix:
    if: github.event.workflow_run.conclusion == 'failure'
    uses: iGLOO-be/gha-agent-pipeline/.github/workflows/agent-ci-fix.yml@v0.3.4
    secrets: inherit
```

If your consumer environment differs from the library's default (different package manager, Node version, or token scope), use the **split pattern** so you own setup:

```yaml
# .github/workflows/agent-on-ci-failure.yml (consumer) — split pattern (recommended)
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
concurrency:
  group: agent-ci-${{ github.event.workflow_run.head_branch }}
  cancel-in-progress: false
jobs:
  ci-fix:
    if: github.event.workflow_run.conclusion == 'failure'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Resolve agent PR
        id: pr
        uses: iGLOO-be/gha-agent-pipeline/.github/actions/get-pr-from-workflow-run@v0.3.4

      - if: steps.pr.outputs.skip == 'true'
        run: echo "Skipping agent CI fix"

      - name: Setup environment
        id: setup
        uses: ./.github/actions/setup-pr-environment
        with:
          ref: ${{ steps.pr.outputs.head_ref }}
          app_id: ${{ secrets.APP_ID }}
          app_private_key: ${{ secrets.APP_PRIVATE_KEY }}

      - name: Run agent CI fix
        uses: iGLOO-be/gha-agent-pipeline/.github/actions/agent-ci-fix-run@v0.3.4
        with:
          app_token: ${{ steps.setup.outputs.app_token }}
          issue_number: ${{ steps.pr.outputs.issue_number }}
          pr_number: ${{ steps.pr.outputs.pr_number }}
          head_ref: ${{ steps.pr.outputs.head_ref }}
          head_sha: ${{ steps.pr.outputs.head_sha }}
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

(Same pattern: `agent-on-ci-success.yml` → `agent-ci-success.yml@v0.3.4` when `conclusion == 'success'`.)

**Runs and `github.repository` are always the consumer.** Pin `@v0.3.4` (or another release tag) on pipeline actions/workflows — do not rely on `@main` for consumers.

## Consumer contract (v0.1)

**Required files on the consumer repo**

| Path                                        | Role                                            |
| ------------------------------------------- | ----------------------------------------------- |
| `.github/agent.config.yml`                  | Agent config (schema v1)                        |
| `.github/workflows/agent.yml`               | Slash triggers → `dispatch.yml@v0.3.4`          |
| `.github/workflows/agent-phase.yml`         | **Fixed filename** — target of library dispatch |
| `.github/workflows/agent-on-ci-failure.yml` | `workflow_run` on failed **`CI`** workflow      |
| `.github/workflows/agent-on-ci-success.yml` | `workflow_run` on successful **`CI`** workflow  |
| `.github/actions/setup-pr-environment/`     | Checkout, App token, pnpm (consumer-owned)      |

**Consumer `.gitignore` (required on greenfield install)** — the runner writes local state under `.agent-state/` (CI fix round counter, cache files) and checks out the library under `gha-agent-pipeline/`. Add both to `.gitignore` so agent commits never include them:

```gitignore
# gha-agent-pipeline runtime (not application source)
.agent-state/
gha-agent-pipeline/
```

Consumers should also keep `packageManager` in `package.json` when using `pnpm/action-setup` (see `install-agent-pipeline` in the library).

When bumping `dispatch.yml` to a release that includes `/agent code-review`, add `code-review` to the `phase` choice options in the consumer's `agent-phase.yml`.

For **chained code-review** after implement or review-fix, add optional `workflow_dispatch` input `chain_code_review` on the consumer `agent-phase.yml` and pass it through to `agent-phase-run` (see excerpt above). For the full **review loop**, also forward `review_loop_active` and `review_loop_round` ([Review loop](#review-loop-review_loop-in-agentconfig)). Slash flags (`+code-review`, `--code-review`, `--recheck` on fix) set `chain_code_review` from `dispatch.yml`; config flags (`implement.follow_up.code_review` / `review_fix.follow_up.code_review`) work without slash flags for single-shot chains. The phase job also needs `permissions.actions: write` if the runtime dispatches follow-up workflows with the App token.

### Code review scope (`code_review` in agent.config)

Optional `code_review` block in `.github/agent.config.yml` controls which changed files the review agent focuses on and path-specific instructions (CodeRabbit-style `path_filters` / `path_instructions`). Values in **agent.config take priority**; missing keys fall back to `.coderabbit.yaml` at the repo root (`reviews.path_filters`, `reviews.path_instructions`) when present.

### Custom slash commands (`commands` in agent.config)

Declare additional `/agent <slash>` commands (or override built-ins) under `commands`. Each custom command must set `extends` to a built-in runtime (`plan`, `implement`, `yolo`, `ci-fix`, `review-fix`, `ask`, `code-review`) so git/PR orchestration stays the same while you customize prompts, models, GitHub tool allowlists, and targets (`issue` / `pr`).

List enabled commands as JSON for dispatch wiring:

```bash
pnpm exec agent-pipeline list-commands --format json
```

Dogfood example: `/agent config-audit` on an issue (extends `ask`).

**Recognized vs reserved slashes.** Dispatch resolves slash tokens from `loadAgentCommands()` and only accepts the ones enabled for the target (`issue` / `pr`). Two slashes are routed directly in `dispatch.yml` before config resolution: `code-review` (PR only) and `fix` (PR only, also accepted from a submitted review body). `fix` is reserved and cannot be declared as a `commands` slash (`RESERVED` in `.github/scripts/command-constants.cjs`); `code-review` is a built-in phase and can still be overridden in `commands`. When an `/agent <slash>` is syntactically valid but unknown, disabled, or not allowed on the target, dispatch posts an explanatory comment on the same thread — with the received token, the reason (unknown / disabled in config / not available on this target), a suggestion when it is close to an available slash (e.g. `review` → `code-review`), and the list of commands available for that context — then stops without adding the 👀 reaction or dispatching an agent phase.

```yaml
code_review:
  path_filters:
    - "!libs/translations/data/**"
  path_instructions:
    - path: "docs/internal/**"
      instructions: |
        Check frontmatter and cross-links.
  apply_default_ignores: false # when true, also skip lockfiles, node_modules, dist
```

Optional `code_review.labels` applies GitHub labels after a review is posted (no-op when omitted):

- **Status** — `status.ok` when the review is `COMMENT` (no hard findings); `status.pending` when `REQUEST_CHANGES`. Sibling status labels are removed when both are configured, and a stale status label is cleared when the current review event has no configured label.
- **Merge risk** — when `merge_risk` is present and `enabled` (default `true`), the runner parses `## Merge risk` (**Minimal** / **Moderate** / **High**) and applies the configured label for that level (defaults: `agent-risk-low`, `agent-risk-medium`, `agent-risk-high`). Sibling risk labels are removed, and a stale risk label is cleared when the review has no parseable level.
- **Severity** — when `severity` is present and `enabled` (default `true`), the runner loads inline review comments for the posted review and applies the label for the highest parsed **Severity** (`Minor` / `Major` / `Critical` from the `_Category_ | _Severity_ | _Effort_` tag line; defaults: `ai-review:minor`, `ai-review:major`, `ai-review:critical`). Sibling severity labels are removed when none parse. On `COMMENT`, `status.ok` is not applied when any severity label is set (so a PR is not both `ai-review:ok` and `ai-review:minor`).
- **Display** — at post time the runner adds emojis to inline tag lines, `Suggested fix` / `Evidence` summaries, and the `## Merge risk` level line for easier scanning on GitHub (parsing for labels is unchanged).
- **apply_to** — `pr` (default), `issue`, or `both`.

```yaml
code_review:
  labels:
    apply_to: pr
    status:
      ok: "ai-review:ok"
      pending: "ai-review:pending"
    merge_risk:
      enabled: true
      low: agent-risk-low
      medium: agent-risk-medium
      high: agent-risk-high
    severity:
      enabled: true
      minor: ai-review:minor
      major: ai-review:major
      critical: ai-review:critical
```

Your app CI workflow must use **`name: CI`** (see `workflows: [CI]` in the triggers above) unless you fork the wrappers.

**Pin these library refs at `@v0.3.4`** (or latest release)

- `dispatch.yml` (optional `runner` input since v0.2.2)
- `agent-phase-run`
- `agent-ci-fix-run` (new split pattern, post-setup only)
- `agent-ci-fix.yml` (legacy thin wrapper — bundles setup + run)
- `agent-ci-success.yml`
- `get-pr-from-workflow-run` (for split-pattern CI fix jobs)

**Do not copy into the consumer**

- `install-agent-pipeline`, `report-failure-fallback`, `manage-agent-working-label`, or other internal composites. These are referenced via `$/` from public composites and match the ref of the public composite you pin.

## Dogfooding (slash commands on this repo)

After the consumer workflows are on **`main`**, comment on an issue or PR:

- `/agent plan` — explore and post a plan
- `/agent implement` — implement from the plan and open a PR. Optional **review loop** (`review_loop.enabled` in config) or single-shot follow-up code-review (`implement.follow_up.code_review`, or `/agent implement +code-review` / `--code-review` on the slash command). See [Review loop](#review-loop-review_loop-in-agentconfig).
- `/agent yolo` — implement directly from the issue. The runner commits and pushes after the session; do not instruct agents to run `git commit` in `role_description` or issue text. A yolo run that produces no commits and has **no** open PR for the branch is reported as **agent-failed** (not a silent success).
- `/agent fix` — on an agent PR (comment or submitted review). One fix session covers merge conflicts, **failing CI checks** (preloaded when Checks read is granted + `readCheckRuns` / `readCheckLogs`), and review feedback. A bare `/agent fix` prioritizes open CI failures when checks are red, otherwise loads PR review bodies and inline comments (human and bot). The agent replies on addressed review threads (`replyToReviewComment`) and resolves threads when the fix is clear. If check preload fails (missing Checks permission), the slash fix still runs and the agent can call `readCheckRuns` when permitted. A PR comment containing `<!-- agent-blocked -->` skips any fix run (slash or CI auto-fix). Optional follow-up: `/agent fix --recheck` or `/agent fix +code-review`, or `review_fix.follow_up.code_review: true` in `.github/agent.config.yml`, dispatches `/agent code-review` after a successful fix. Set `models.fix` to use one model for both `/agent fix` and CI auto-fix; without it, `models.review-fix` and `models.ci-fix` are used per entry.
- `/agent code-review` — hybrid review (walkthrough, merge risk, Standards + Spec, inline comments) posted as a GitHub PR review
- `/agent ask` — read-only Q&A on an issue or PR

Dispatch runs phase workflows from the default branch (`main`), not from open PR branches.

### Secrets (repository)

| Secret               | Usage         |
| -------------------- | ------------- |
| `APP_ID`             | GitHub App ID |
| `APP_PRIVATE_KEY`    | App PEM key   |
| `OPENROUTER_API_KEY` | LLM gateway   |

Use the same GitHub App as the demo (or a dedicated app) with these **repository permissions** on the app (Organization → GitHub Apps → _your app_ → Permissions):

| Permission    | Access        | Why                                                                                                                                                                                                                                                    |
| ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contents      | Read & write  | Checkout, commits, PR branches                                                                                                                                                                                                                         |
| Issues        | Read & write  | Plans, agent comments, labels                                                                                                                                                                                                                          |
| Pull requests | Read & write  | Agent PRs, reviews                                                                                                                                                                                                                                     |
| Actions       | Read & write  | Workflow tokens, nested pipeline checkout, and **chained** `code-review` after implement/review-fix (`workflow_dispatch` via the App token — grant Actions write on the app and set `permission-actions: write` on `create-github-app-token` in setup) |
| **Checks**    | **Read-only** | **Agent fix** (slash `/agent fix` and CI auto-fix) — lists failed checks via [`checks.listForRef`](https://docs.github.com/rest/checks/runs#list-check-runs-for-a-git-reference) (`readCheckRuns`)                                                     |

`agent-ci-fix.yml` sets `permissions.checks: read` on the job, but that only applies if the **app installation** also grants Checks read. Without it, CI Fix fails before the agent runs. Agent CI fix and Agent CI success only operate on PRs labelled `agent-pr` (the label set by `implement`/`yolo` at PR creation).

```text
HttpError: Resource not accessible by integration
  at readCheckRuns (packages/agent-pipeline/src/tools/github.ts)
```

After changing app permissions, accept the updated installation request on each consumer repo.

### Deployment models

The pipeline supports two deployment models depending on repository visibility and App installation scope:

**Model A: Public pipeline + app on consumer only (default)**

This is the default for consumers using the public `iGLOO-be/gha-agent-pipeline` library. The GitHub App is installed **only on the consumer repo**. The workflow `GITHUB_TOKEN` suffices to checkout the public pipeline, while the App token is reserved for privileged consumer operations (branches, commits, issues, PRs, labels).

- No extra configuration required — the new defaults handle this.
- `pipeline_install_token` is left empty (falls back to `github.token`).
- `pipeline_repo` is left empty in `setup-pr-environment`.

**Model B: Private pipeline fork + app on both repos**

When the pipeline library is a **private fork**, the GitHub App must be installed on both the consumer repo and the pipeline fork. In this model:

- Pass `pipeline_repo: <your-fork-name>` to `setup-pr-environment` (or `agent-ci-fix.yml`) so the App token includes the fork in its repository scope.
- Optionally pass `pipeline_install_token` if the install step also needs the App token (typically unnecessary when using the same App for both repos — the `install-agent-pipeline` step will reuse `github.token` for public repos).

Example consumer `agent-phase.yml` for Model B:

```yaml
- uses: ./.github/actions/setup-pr-environment
  with:
    ref: ${{ inputs.checkout_ref || inputs.head_ref || github.ref_name }}
    app_id: ${{ secrets.APP_ID }}
    app_private_key: ${{ secrets.APP_PRIVATE_KEY }}
    pipeline_repo: gha-agent-pipeline # include if pipeline is private
- uses: iGLOO-be/gha-agent-pipeline/.github/actions/agent-phase-run@v0.3.4
  with:
    phase: ${{ inputs.phase }}
    app_token: ${{ steps.setup.outputs.app_token }}
    comment_id: ${{ inputs.comment_id }}
    issue_number: ${{ inputs.issue_number }}
    pipeline_install_token: ${{ steps.setup.outputs.app_token }} # only if pipeline is private
```

The nested checkout at `gha-agent-pipeline/` from `install-agent-pipeline` is gitignored; agent commits must not include that path (runtime excludes it from `git add`).

## Phase environment contract

The CLI phases read the following environment variables. Common variables (`OPENROUTER_API_KEY`, `GITHUB_TOKEN`, `GITHUB_REPOSITORY`) are required by all phases.

| Variable                                                                | Phases                   | Description                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_BASE_BRANCH`                                                     | git sync / branch create | Overrides `git.base_branch` when set (via workflow `base_branch` input on `agent-phase-run`). Use when the checked-out ref has no `.github/agent.config.yml`.                                                                 |
| `AGENT_RUN_COMMANDS_TIMEOUT_MS`                                         | all tool phases          | Overrides `tools.run_commands_timeout_ms` for the Cline `run_commands` tool (default 600000 ms).                                                                                                                              |
| `AGENT_SESSION_MAX_ATTEMPTS`                                            | all LLM phases           | Full session restarts after retriable failures (default 3). Each restart runs `cline.start` again with the original prompt.                                                                                                   |
| `AGENT_SESSION_CONTINUE_MAX_ATTEMPTS`                                   | all LLM phases           | In-session continues via `cline.send` after retriable `error`/`aborted` finishes, before a full restart (default 2). Set `0` to disable. Backoff uses `AGENT_SESSION_RETRY_BASE_DELAY_MS`.                                    |
| `AGENT_SESSION_RETRY_BASE_DELAY_MS`                                     | all LLM phases           | Base delay in ms for session continue and full-session retry backoff (default 10000).                                                                                                                                         |
| `AGENT_UPSTREAM_DRIFT_MAX_PASSES`                                       | `review-fix`, `ci-fix`   | Total agent passes (clamped to 1–3, default 2) when the base branch advances during a fix session. A retry pass resyncs with the new base and resolves the resulting conflicts before reporting success.                      |
| `OPENROUTER_JEV_ROUTER_ENABLED`                                         | all LLM phases           | When `true`/`false`, enables or disables [OpenRouter Jev Router](https://openrouter.ai/docs/guides/routing/routers/jev-router) globally (overrides `openrouter.jev_router.enabled` unless a phase sets `enabled` explicitly). |
| `OPENROUTER_JEV_ROUTER_MODELS` / `OPENROUTER_JEV_ROUTER_ALLOWED_MODELS` | Jev Router active        | Comma-separated include patterns when YAML pool lists are empty for the phase.                                                                                                                                                |
| `OPENROUTER_JEV_ROUTER_EXCLUDED_MODELS`                                 | Jev Router active        | Comma-separated exclude patterns when YAML `excluded_models` are empty for the phase.                                                                                                                                         |
| `OPENROUTER_JEV_ROUTER_FALLBACK_ON_EXHAUSTION`                          | Jev Router active        | When `true`/`false`, enables or disables falling back to the phase `models.<phase>` slug after a Jev Router admission failure (overrides `openrouter.jev_router.fallback_to_phase_model_on_exhaustion` when set).             |

All LLM requests send OpenRouter [app attribution](https://openrouter.ai/docs/app-attribution) headers (`HTTP-Referer`, `X-Title`, optional `OPENROUTER_HTTP_REFERER` / `OPENROUTER_APP_TITLE` env overrides) plus **`X-OpenRouter-App-Visibility: hidden`** so new attributed apps stay off public rankings and the marketplace while usage still appears in your OpenRouter analytics. That visibility value applies only when OpenRouter creates a **new** app for a referer; already-public apps are unchanged (contact OpenRouter support to adjust them).

### OpenRouter Jev Router (optional)

In `.github/agent.config.yml`, enable dynamic model selection via `typesafe/jev-router`:

```yaml
openrouter:
  jev_router:
    enabled: true
    models: ["anthropic/*", "google/*"]
    excluded_models: ["anthropic/claude-opus*"]
    phases:
      plan:
        enabled: false # keep a fixed model for plan
      implement:
        enabled: true
```

When Jev Router is active for a phase, the runtime sends `model: typesafe/jev-router` and injects the `jev-router` plugin pool. If you omit `models` / `allowed_models`, the phase’s `models.<phase>` slug (after `AGENT_MODEL_*` overrides) is the sole candidate. If OpenRouter returns a Jev admission error (no models left in the pool for the request), the runtime starts a **new** session on the fixed phase slug when `fallback_to_phase_model_on_exhaustion` is true (default). End-of-phase usage tables list **Model (requested)** and **Served model(s)** (upstream slugs parsed from OpenRouter responses, including `openrouter_metadata` when enabled). When Cline’s aggregated `totalCost` is zero, **Estimated cost** falls back to the sum of OpenRouter `usage.cost` captured on the same HTTP responses. See the [OpenRouter Jev Router guide](https://openrouter.ai/docs/guides/routing/routers/jev-router).

| Phase         | Required                                    | Optional / routing                                                                                                                     |
| ------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `plan`        | `ISSUE_NUMBER`                              | `COMMENT_ID`, `SUCCESS_REACTION` (reaction on trigger comment)                                                                         |
| `implement`   | `ISSUE_NUMBER`                              | `COMMENT_ID`, `SUCCESS_REACTION` (reaction on trigger comment)                                                                         |
| `yolo`        | `ISSUE_NUMBER`                              | `AGENT_BRANCH` (existing head branch via `head_ref`), `COMMENT_ID`, `SUCCESS_REACTION`                                                 |
| `review-fix`  | `ISSUE_NUMBER`, `PR_NUMBER`, `AGENT_BRANCH` | `REVIEW_FEEDBACK` (empty for bare `/agent fix`), `HEAD_SHA` (defaults to PR head), `COMMENT_ID`, `REACTION_TARGET`, `SUCCESS_REACTION` |
| `ci-fix`      | `ISSUE_NUMBER`, `PR_NUMBER`, `AGENT_BRANCH` | `HEAD_SHA` (defaults to PR head), `REVIEW_FEEDBACK` (usually empty)                                                                    |
| `ask`         | `ISSUE_NUMBER`, `QUESTION`                  | `PR_NUMBER`, `COMMENT_ID`, `SUCCESS_REACTION` (reaction on trigger comment)                                                            |
| `code-review` | `ISSUE_NUMBER`, `PR_NUMBER`                 | `REVIEW_INSTRUCTIONS`, `COMMENT_ID`, `SUCCESS_REACTION` (reaction on trigger comment)                                                  |

Lifecycle actions (add/remove `agent-working`, post `<!-- agent-startup -->`, clear `agent-waiting-human`/`agent-failed`, react to trigger) run inside the TypeScript `runAgentPhase()` wrapper before and after the phase `main()`. The `agent-phase.yml` workflow must not repeat those steps (it only runs the CLI and keeps `always()` label cleanup as a safety net).

## Usage block (Job Summary & comments)

After each agent run, the runtime emits a **Usage** block (stdout, GitHub step summary, and issue/PR comment footer). The block includes:

- Token counts (input, output, cache read/write, total)
- **Iterations** — number of agent loop cycles (model call → tools → repeat)
- **Tool calls** — total tool invocations across all iterations
- Estimated cost (provider-side estimate)

Iterations and tool calls are sourced from `session.result` (`AgentResult` from the Cline SDK). If the session ends early (error/abort), they are omitted.

## Related docs

- [gha-agent-demo reusable architecture](https://github.com/iGLOO-be/gha-agent-demo/blob/main/docs/reusable-architecture.md)
- [`AGENTS.md`](./AGENTS.md)
