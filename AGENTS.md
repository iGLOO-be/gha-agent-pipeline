# AGENTS.md

Guide for agents working on [`iGLOO-be/gha-agent-pipeline`](https://github.com/iGLOO-be/gha-agent-pipeline).

## Role of this repo

**Library only** — agent runtime (`packages/agent-pipeline`), reusable GitHub Actions workflows, and the consumer config JSON Schema. No application code.

Consumers (e.g. [`gha-agent-demo`](https://github.com/iGLOO-be/gha-agent-demo)) keep `.github/agent.config.yml` and a thin `workflow_call` wrapper.

## Layout

- `packages/agent-pipeline/` — Cline agent harness (migrated from demo `tools/agent/`)
- `schema/agent.config.v1.schema.json` — config contract for consumers
- `.github/workflows/` — reusable workflows (`poc-callable.yml` today; `dispatch.yml` etc. in later steps)

## Dev commands

```bash
pnpm install
pnpm test
pnpm run typecheck
pnpm run format:fix
pnpm run format:check
```

Run a phase against a **consumer checkout** (cwd must contain `.github/agent.config.yml`):

```bash
cd /path/to/gha-agent-demo
pnpm exec agent-pipeline plan   # requires OPENROUTER_API_KEY, GITHUB_TOKEN, etc.
```

## Conventions

- TypeScript strict mode; Vitest for unit tests under `packages/agent-pipeline/`
- Any change to the runtime must include or update tests
- Do not add Next.js or consumer app code to this repository
- Runners (`runs-on`) belong in **consumer** workflows, not in `agent.config.yml`

## Phase 2 tracking

Parent epic: [gha-agent-demo#138](https://github.com/iGLOO-be/gha-agent-demo/issues/138)
