# gha-agent-pipeline

Reusable GitHub Actions agent library for [gha-agent-demo](https://github.com/iGLOO-be/gha-agent-demo) and other consumers.

## Status (Phase 2)

| Piece              | Location                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| Runtime            | `packages/agent-pipeline/` + `agent-pipeline` CLI                                                  |
| Config schema      | [`schema/agent.config.v1.schema.json`](./schema/agent.config.v1.schema.json)                       |
| Reusable workflows | [`dispatch.yml`](./.github/workflows/dispatch.yml) — **`workflow_call` only** (slash-command router) |
| Composite actions  | `install-agent-pipeline`, labels, comments, reactions, failure fallback, PR resolution helpers     |

**Consumer-owned:** checkout, `pnpm install` for the app, GitHub App token, and `setup-pr-environment` (or equivalent). Phase jobs (`agent-plan.yml`, etc.) live on the consumer and reference actions here via `owner/repo/.github/actions/...@ref`.

**Private repo:** keep this repository private. The consumer’s GitHub App must be **installed on this repo** (Contents read is enough) and the app token must list `gha-agent-pipeline` in `create-github-app-token` `repositories` (see demo `setup-pr-environment`).

## Development

```bash
pnpm install
pnpm test
pnpm run typecheck
pnpm run format:check
```

Run a phase from a **consumer repo** checkout (needs `.github/agent.config.yml` and agent env vars):

```bash
cd /path/to/gha-agent-demo
/path/to/gha-agent-pipeline/node_modules/.bin/agent-pipeline plan
```

## Cross-repo `workflow_call` (POC)

Reusable [`.github/workflows/poc-callable.yml`](./.github/workflows/poc-callable.yml) — validated in [#139](https://github.com/iGLOO-be/gha-agent-demo/issues/139).

**Repository setting:** Actions → General → Access → _Accessible from repositories in the **iGLOO-be** organization_ (`access_level: organization`).

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
# .github/workflows/agent-plan.yml (consumer) — excerpt
steps:
  - uses: ./.github/actions/setup-pr-environment
  - uses: iGLOO-be/gha-agent-pipeline/.github/actions/install-agent-pipeline@main
  - run: ${{ steps.pipeline.outputs.bin }} plan
```

**Runs and `github.repository` are always the consumer.** Pin `@main` or a release tag on pipeline actions/workflows.

## Related docs

- [gha-agent-demo reusable architecture](https://github.com/iGLOO-be/gha-agent-demo/blob/main/docs/reusable-architecture.md)
- [`AGENTS.md`](./AGENTS.md)
