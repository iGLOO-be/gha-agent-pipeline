# AGENTS.md

> **First read [`CLAUDE.md`](./CLAUDE.md) — it contains the graphify knowledge graph integration that agents must use before answering codebase questions.**

Guide for agents working on [`iGLOO-be/gha-agent-pipeline`](https://github.com/iGLOO-be/gha-agent-pipeline).

## Role of this repo

**Library** — agent runtime (`packages/agent-pipeline`), reusable GitHub Actions workflows, and the consumer config JSON Schema. No application code.

**Dogfood consumer** — this repo also wires slash commands on itself ([#3](https://github.com/iGLOO-be/gha-agent-pipeline/issues/3)): `.github/agent.config.yml`, `agent.yml`, phase workflow ([`agent-phase.yml`](./.github/workflows/agent-phase.yml)), and local `setup-pr-environment`. Other consumers (e.g. [`gha-agent-demo`](https://github.com/iGLOO-be/gha-agent-demo)) keep their own copy of the consumer layer.

## Layout

- `packages/agent-pipeline/` — Cline agent harness (migrated from demo `tools/agent/`)
- `schema/agent.config.v1.schema.json` — config contract for consumers
- `.github/agent.config.yml` — agent config for dogfooding on this monorepo
- `.github/workflows/` — `dispatch.yml` (slash router), `agent.yml` + phase job (dogfood), `ci.yml`
- `.github/actions/` — shared composites (`install-agent-pipeline`, labels, comments, …) plus **`setup-pr-environment`** (local copy for dogfood only; other consumers keep their own)

## Dev commands

```bash
pnpm install
pnpm test
pnpm run typecheck
pnpm run format:fix
pnpm run format:check
```

Run a phase locally (cwd must contain `.github/agent.config.yml`):

```bash
# From this repo (dogfood) or another consumer checkout
pnpm exec agent-pipeline plan   # requires OPENROUTER_API_KEY, GITHUB_TOKEN, etc.
```

## Conventions

- TypeScript strict mode; Vitest for unit tests under `packages/agent-pipeline/`
- Any change to the runtime must include or update tests
- Do not add Next.js or consumer app code to this repository
- Runners (`runs-on`) belong in **consumer** workflows, not in `agent.config.yml`

## Phase 2 tracking

Parent epic: [gha-agent-demo#138](https://github.com/iGLOO-be/gha-agent-demo/issues/138)
