# gha-agent-pipeline

Reusable GitHub Actions agent library for [gha-agent-demo](https://github.com/iGLOO-be/gha-agent-demo) and other consumers.

## Status (Phase 2)

| Piece              | Location                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime            | `packages/agent-pipeline/` + `agent-pipeline` CLI                                                                                                                 |
| Config schema      | [`schema/agent.config.v1.schema.json`](./schema/agent.config.v1.schema.json)                                                                                      |
| Reusable workflows | [`dispatch.yml`](./.github/workflows/dispatch.yml) (slash router) + **dogfood** phase job ([`agent-phase.yml`](./.github/workflows/agent-phase.yml)) on this repo |
| Composite actions  | `install-agent-pipeline`, labels, comments, reactions, failure fallback, PR resolution helpers                                                                    |

**Consumer-owned (other repos):** checkout, `pnpm install`, GitHub App token, and `setup-pr-environment`. Phase jobs reference library actions via `owner/repo/.github/actions/...@ref`.

**This repo also dogfoods** the same consumer wiring as [gha-agent-demo](https://github.com/iGLOO-be/gha-agent-demo) ([#3](https://github.com/iGLOO-be/gha-agent-pipeline/issues/3)): `agent.yml`, phase workflow, [`.github/agent.config.yml`](./.github/agent.config.yml), and local [`setup-pr-environment`](./.github/actions/setup-pr-environment/action.yml).

**Private repo:** keep this repository private. The consumer’s GitHub App must be **installed on this repo** (Contents read is enough) and the app token must list `gha-agent-pipeline` in `create-github-app-token` `repositories` (see demo `setup-pr-environment`).

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
    uses: iGLOO-be/gha-agent-pipeline/.github/workflows/dispatch.yml@main
    secrets: inherit
```

```yaml
# .github/workflows/agent-phase.yml (consumer) — excerpt
on:
  workflow_dispatch:
    inputs:
      phase:
        required: true
        type: choice
        options: [plan, implement, yolo, review-fix]
jobs:
  agent:
    steps:
      - uses: ./.github/actions/setup-pr-environment
      - uses: iGLOO-be/gha-agent-pipeline/.github/actions/install-agent-pipeline@main
      - run: ${{ steps.pipeline.outputs.bin }} ${{ inputs.phase }}
```

**Runs and `github.repository` are always the consumer.** Pin `@main` or a release tag on pipeline actions/workflows.

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

`agent-ci-fix.yml` sets `permissions.checks: read` on the job, but that only applies if the **app installation** also grants Checks read. Without it, CI Fix fails before the agent runs. Agent CI Fix only operates on PRs labelled `agent-pr` (the label set by `implement`/`yolo` at PR creation).

```text
HttpError: Resource not accessible by integration
  at readCheckRuns (packages/agent-pipeline/src/tools/github.ts)
```

After changing app permissions, accept the updated installation request on each repo (including **`gha-agent-pipeline`**) and keep this repo in the app token `repositories` list — see `setup-pr-environment`.

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

Lifecycle actions (add/remove `agent-working`, post `<!-- agent-startup -->`, clear `agent-waiting-human`/`agent-failed`, react to trigger) run inside the TypeScript wrapper before and after the phase `main()`.

## Related docs

- [gha-agent-demo reusable architecture](https://github.com/iGLOO-be/gha-agent-demo/blob/main/docs/reusable-architecture.md)
- [`AGENTS.md`](./AGENTS.md)
