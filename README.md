# gha-agent-pipeline

Reusable GitHub Actions agent library for [gha-agent-demo](https://github.com/iGLOO-be/gha-agent-demo) and other consumers.

## Status (Phase 2)

| Piece              | Location                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| Runtime            | `packages/agent-pipeline/` + `agent-pipeline` CLI                                                  |
| Config schema      | [`schema/agent.config.v1.schema.json`](./schema/agent.config.v1.schema.json)                       |
| Reusable workflows | `dispatch.yml`, `plan.yml`, `implement.yml`, … — **`workflow_call` only** (no issue triggers here) |

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
# or: pnpm exec agent-pipeline plan   # when run from gha-agent-pipeline with workspace linked
```

## Cross-repo `workflow_call` (POC)

Reusable [`.github/workflows/poc-callable.yml`](./.github/workflows/poc-callable.yml) — validated in [#139](https://github.com/iGLOO-be/gha-agent-demo/issues/139).

**Repository setting:** Actions → General → Access → _Accessible from repositories in the **iGLOO-be** organization_ (`access_level: organization`).

## Consumer wiring

Triggers (`issue_comment`, `workflow_run` on CI) stay on the **consumer** repo. This library only defines reusable workflows.

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

Phase jobs are thin `workflow_dispatch` wrappers on the consumer (e.g. `agent-plan.yml`) that call `plan.yml` here. **Runs and `github.repository` are always the consumer.**

Runners (`runs-on`) are defined on jobs inside the reusable workflows here (or can move to consumer wrappers later).

## Related docs

- [gha-agent-demo reusable architecture](https://github.com/iGLOO-be/gha-agent-demo/blob/main/docs/reusable-architecture.md)
- [`AGENTS.md`](./AGENTS.md)
