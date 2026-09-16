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
    uses: iGLOO-be/gha-agent-pipeline/.github/workflows/dispatch.yml@v0.2.0
    secrets: inherit
```

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
      - uses: iGLOO-be/gha-agent-pipeline/.github/actions/agent-phase-run@v0.2.0
        with:
          phase: ${{ inputs.phase }}
          app_token: ${{ steps.setup.outputs.app_token }}
          comment_id: ${{ inputs.comment_id }}
          issue_number: ${{ inputs.issue_number }}
          pr_number: ${{ inputs.pr_number }}
          head_ref: ${{ inputs.head_ref }}
          review_feedback: ${{ inputs.review_feedback }}
          reaction_target: ${{ inputs.reaction_target }}
          node_version: "24"
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

**Environment setup is never provided by the library.** The consumer owns `setup-pr-environment` (or equivalent): checkout, package manager, Node version, GitHub App token scope, extra services. The library only provides post-setup orchestration through `agent-phase-run` (install pipeline, CLI run, failure fallback, `agent-working` cleanup). `OPENROUTER_API_KEY` is forwarded via the caller's step `env` (not through the composite).

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
    uses: iGLOO-be/gha-agent-pipeline/.github/workflows/agent-ci-fix.yml@v0.2.0
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
        uses: iGLOO-be/gha-agent-pipeline/.github/actions/get-pr-from-workflow-run@v0.2.0

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
        uses: iGLOO-be/gha-agent-pipeline/.github/actions/agent-ci-fix-run@v0.2.0
        with:
          app_token: ${{ steps.setup.outputs.app_token }}
          issue_number: ${{ steps.pr.outputs.issue_number }}
          pr_number: ${{ steps.pr.outputs.pr_number }}
          head_ref: ${{ steps.pr.outputs.head_ref }}
          head_sha: ${{ steps.pr.outputs.head_sha }}
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

(Same pattern: `agent-on-ci-success.yml` → `agent-ci-success.yml@v0.2.0` when `conclusion == 'success'`.)

**Runs and `github.repository` are always the consumer.** Pin `@v0.2.0` (or another release tag) on pipeline actions/workflows — do not rely on `@main` for consumers.

## Consumer contract (v0.1)

**Required files on the consumer repo**

| Path                                        | Role                                            |
| ------------------------------------------- | ----------------------------------------------- |
| `.github/agent.config.yml`                  | Agent config (schema v1)                        |
| `.github/workflows/agent.yml`               | Slash triggers → `dispatch.yml@v0.2.0`          |
| `.github/workflows/agent-phase.yml`         | **Fixed filename** — target of library dispatch |
| `.github/workflows/agent-on-ci-failure.yml` | `workflow_run` on failed **`CI`** workflow      |
| `.github/workflows/agent-on-ci-success.yml` | `workflow_run` on successful **`CI`** workflow  |
| `.github/actions/setup-pr-environment/`     | Checkout, App token, pnpm (consumer-owned)      |

Your app CI workflow must use **`name: CI`** (see `workflows: [CI]` in the triggers above) unless you fork the wrappers.

**Pin these library refs at `@v0.2.0`** (or latest release)

- `dispatch.yml`
- `agent-phase-run`
- `agent-ci-fix-run` (new split pattern, post-setup only)
- `agent-ci-fix.yml` (legacy thin wrapper — bundles setup + run)
- `agent-ci-success.yml`
- `get-pr-from-workflow-run` (for split-pattern CI fix jobs)

**Do not copy into the consumer**

- `install-agent-pipeline`, `report-failure-fallback`, `manage-agent-working-label`, or other internal composites. These are referenced via `$/` from public composites and match the ref of the public composite you pin.

## Dogfooding (slash commands on this repo)

After the consumer workflows are on **`main`**, comment on an issue:

- `/agent plan` — explore and post a plan
- `/agent implement` — implement from the plan and open a PR
- `/agent yolo` — implement directly from the issue
- `/agent fix` — on an agent PR (comment or submitted review)

Dispatch runs phase workflows from the default branch (`main`), not from open PR branches.

### Secrets (repository)

| Secret               | Usage         |
| -------------------- | ------------- |
| `APP_ID`             | GitHub App ID |
| `APP_PRIVATE_KEY`    | App PEM key   |
| `OPENROUTER_API_KEY` | LLM gateway   |

Use the same GitHub App as the demo (or a dedicated app) with these **repository permissions** on the app (Organization → GitHub Apps → _your app_ → Permissions):

| Permission    | Access        | Why                                                                                                                                                                          |
| ------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contents      | Read & write  | Checkout, commits, PR branches                                                                                                                                               |
| Issues        | Read & write  | Plans, agent comments, labels                                                                                                                                                |
| Pull requests | Read & write  | Agent PRs, reviews                                                                                                                                                           |
| Actions       | Read & write  | Workflow tokens, nested pipeline checkout                                                                                                                                    |
| **Checks**    | **Read-only** | **Agent CI Fix** — lists failed checks via [`checks.listForRef`](https://docs.github.com/rest/checks/runs#list-check-runs-for-a-git-reference) (`readCheckRuns` in `ci-fix`) |

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
- uses: iGLOO-be/gha-agent-pipeline/.github/actions/agent-phase-run@v0.2.0
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

| Phase        | Required                                                       | Optional / routing                                                                             |
| ------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `plan`       | `ISSUE_NUMBER`                                                 | `COMMENT_ID`, `SUCCESS_REACTION` (reaction on trigger comment)                                 |
| `implement`  | `ISSUE_NUMBER`                                                 | `COMMENT_ID`, `SUCCESS_REACTION` (reaction on trigger comment)                                 |
| `yolo`       | `ISSUE_NUMBER`                                                 | `COMMENT_ID`, `SUCCESS_REACTION` (reaction on trigger comment)                                 |
| `review-fix` | `ISSUE_NUMBER`, `PR_NUMBER`, `AGENT_BRANCH`, `REVIEW_FEEDBACK` | `COMMENT_ID`, `REACTION_TARGET` (`issue_comment` or `pull_request_review`), `SUCCESS_REACTION` |
| `ci-fix`     | `ISSUE_NUMBER`, `PR_NUMBER`, `HEAD_SHA`, `AGENT_BRANCH`        | (none — no trigger comment/reaction)                                                           |
| `ask`        | `ISSUE_NUMBER`, `QUESTION`                                     | `PR_NUMBER`, `COMMENT_ID`, `SUCCESS_REACTION` (reaction on trigger comment)                    |

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
