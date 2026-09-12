# gha-agent-pipeline

Reusable GitHub Actions agent library for [gha-agent-demo](https://github.com/iGLOO-be/gha-agent-demo) and other consumers.

## Status (Phase 2)

| Piece              | Location                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| Runtime (WIP)      | `packages/agent-pipeline/` — Step 2 [#141](https://github.com/iGLOO-be/gha-agent-demo/issues/141) |
| Config schema      | [`schema/agent.config.v1.schema.json`](./schema/agent.config.v1.schema.json)                      |
| Reusable workflows | `.github/workflows/` (POC + future `dispatch.yml`)                                                |

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

## Consumer wiring (target)

```yaml
jobs:
  agent:
    uses: iGLOO-be/gha-agent-pipeline/.github/workflows/dispatch.yml@main
    secrets: inherit
```

Runners (`runs-on`) are set on the **consumer** workflow job, not in agent config.

## Related docs

- [gha-agent-demo reusable architecture](https://github.com/iGLOO-be/gha-agent-demo/blob/main/docs/reusable-architecture.md)
- [`AGENTS.md`](./AGENTS.md)
