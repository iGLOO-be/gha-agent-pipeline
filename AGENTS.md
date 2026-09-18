# AGENTS.md

> **First read [`CLAUDE.md`](./CLAUDE.md) — it contains the graphify knowledge graph integration that agents must use before answering codebase questions.**

Guide for agents working on [`iGLOO-be/gha-agent-pipeline`](https://github.com/iGLOO-be/gha-agent-pipeline).

## Role of this repo

**Library** — agent runtime (`packages/agent-pipeline`), reusable GitHub Actions workflows, and the consumer config JSON Schema. No application code. Library composites (`install-agent-pipeline`, `agent-phase-run`, labels, comments, …) provide post-setup orchestration only; **environment setup (checkout, package manager, Node, app token) is never part of the library contract**.

**Dogfood consumer** — this repo also wires slash commands on itself ([#3](https://github.com/iGLOO-be/gha-agent-pipeline/issues/3)): `.github/agent.config.yml`, `agent.yml`, phase workflow ([`agent-phase.yml`](./.github/workflows/agent-phase.yml)), and local `setup-pr-environment`. Other consumers (e.g. [`gha-agent-demo`](https://github.com/iGLOO-be/gha-agent-demo)) keep their own copy of the consumer layer.

## Layout

- `packages/agent-pipeline/` — Cline agent harness (migrated from demo `tools/agent/`)
- `schema/agent.config.v1.schema.json` — config contract for consumers
- `.github/agent.config.yml` — agent config for dogfooding on this monorepo
- `.github/workflows/` — `dispatch.yml`, `agent-ci-fix.yml` / `agent-ci-success.yml` (`workflow_call`), dogfood `agent-on-ci-failure.yml` / `agent-on-ci-success.yml`, `agent.yml` + `agent-phase.yml`, `ci.yml`
- `.github/actions/` — **Public (post-setup):** `agent-phase-run`, `agent-ci-fix-run`. **Public (consumer wiring):** `get-pr-from-workflow-run`. **Public (pipeline install):** `install-agent-pipeline`. **Deprecated:** `run-agent-ci-fix`. **Internal:** `get-pr-from-check-suite`, `report-failure-fallback`, `manage-agent-working-label`, legacy label/comment composites, plus **`setup-pr-environment`** (dogfood only)

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
- Consumer `setup-pr-environment` (or equivalent) should install **`ripgrep`** (`rg`) on the agent phase runner — see [README — Agent runner tooling](README.md#agent-runner-tooling-ripgrep)
- Before finishing work, run `pnpm test && pnpm run typecheck && pnpm run format:check` to verify all checks pass. CI enforces these in the PR workflow.

## Phase 2 tracking

Parent epic: [gha-agent-demo#138](https://github.com/iGLOO-be/gha-agent-demo/issues/138)

## Agent phase report

When the agent finishes edits (implement, yolo, ci-fix, review-fix), it may call `submitPhaseReport` to provide a structured markdown summary. This is the agent's **business summary** only: what changed, which files were touched, and how to verify the work.

The runner wraps this into a unified end-of-phase block (`## Agent phase report ({phase})`) that also includes a status line and — injected automatically by the runner, **never** by the agent — the run metrics and run friction sections:

- **`### Run metrics`** — tokens, cost, model, and session ID, generated from `safeFormatUsageMarkdown` using the session result. The agent must not fill in token/cost numbers itself.
- **`### Run friction`** — suboptimal moments (retries, tool limits, agent-reported friction) collected by the runner.

The agent should only call `submitPhaseReport` for the `summary` (and optional `testPlan`). If the agent omits it, the runner emits a neutral fallback so the comment still shows the status + metrics.

### Report structure

- **summary** (required): markdown describing what changed, which files were touched, and why.
- **test plan** (optional): markdown describing how to verify the changes.

### Example

```
### Implementation

- Added `widgetSort` to `src/widgets/sort.ts` — handles ASC / DESC with locale-aware comparisons.
- Patched `src/widgets/index.ts` to export the new sort utility.
- Tests in `src/widgets/sort.test.ts` cover the three ordering edge cases.

### Test plan

1. `pnpm test` — all Vitest suites pass including the new sort tests.
2. `pnpm run typecheck` — no new TypeScript errors.
```

Agent summaries submitted via `submitPhaseReport` must use `###` headings or lower; never emit top-level `##` headings — the runner provides the structural heading. Similarly, do not emit `### Run metrics` or `### Run friction` sections; those are injected automatically by the runner.

## Agent ask

When the agent runs in the ask phase (`/agent ask`), it answers questions from humans on GitHub issues or agent pull requests.

### Tone and scope

- Answer based on the issue/PR thread and codebase exploration only.
- Do not speculate about things you cannot verify from the codebase or thread.
- Keep answers concise and actionable. Prefer bullet points or short paragraphs.
- If the question is ambiguous, state your interpretation and answer both possible readings if reasonable.
- When answering about code, cite specific file paths and line ranges.

### What not to answer

- Do not make code changes or suggest edits (the ask phase has no write tools).
- Do not promise future agent work; redirect humans to `/agent plan` or `/agent implement` for that.
- Do not answer questions about the agent's own internal state, cost calculations, or session details.
- Do not reveal secrets, API keys, or tokens that may appear in the codebase.
