# gha-agent-pipeline

Reusable GitHub Actions agent library for [gha-agent-demo](https://github.com/iGLOO-be/gha-agent-demo) and other consumers.

**Phase 2** — runtime and workflows are migrated from the demo repo incrementally.

## POC (issue #139)

Reusable workflow [`.github/workflows/poc-callable.yml`](./.github/workflows/poc-callable.yml) validates cross-repo `workflow_call` from a consumer repository.

## Consumer wiring (target)

```yaml
jobs:
  agent:
    uses: iGLOO-be/gha-agent-pipeline/.github/workflows/dispatch.yml@main
    secrets: inherit
```

Runners (`runs-on`) are set on the **consumer** workflow job, not in agent config.
