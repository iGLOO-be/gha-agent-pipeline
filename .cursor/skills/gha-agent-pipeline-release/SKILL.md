---
name: gha-agent-pipeline-release
description: Cut a semver release of iGLOO-be/gha-agent-pipeline (README pin bump, git tag, GitHub release) and open upgrade issues on consumer repos from a local gitignored list. Use when the user asks for a patch/minor release, consumer notification, pin upgrade issues, or /agent yolo rollout after a library release.
disable-model-invocation: true
---

# gha-agent-pipeline release and consumer rollout

Library repo: **this** checkout (`gha-agent-pipeline`). Consumer repos are listed only in [`.local/consumers.json`](../../../.local/consumers.json) (gitignored). Copy from [`.local/consumers.example.json`](../../../.local/consumers.example.json) if missing.

**Never** commit `.local/consumers.json` or put consumer lists in tracked files.

## Prerequisites

- `gh` authenticated with access to the library and all consumer repos
- `main` up to date; release commits already merged (or about to be tagged)
- Consumer file present at `.local/consumers.json`

## Phase 1 — Decide version and release notes

1. `git fetch origin && git checkout main && git pull origin main`
2. Latest tag: `git tag -l 'v*' --sort=-v:refname | head -1`
3. Commits since tag: `git log <tag>..HEAD --oneline` and `git diff <tag>..HEAD --stat`
4. Choose **patch** (`v0.1.x`) unless the user specifies otherwise; confirm breaking/schema changes (usually none for patch).
5. Draft GitHub release notes: summary, “Changes since …”, “Consumer upgrade” (pin `@vX.Y.Z` on `dispatch.yml`, `agent-phase-run`, `agent-ci-fix.yml`, `agent-ci-success.yml`; note any new inputs from the diff).

## Phase 2 — Ship the library release

1. `pnpm test && pnpm run typecheck && pnpm run format:check`
2. Replace all `@v<old>` with `@v<new>` in root `README.md` consumer examples only (do not change dogfood `agent.yml` if it uses `@main` by design).
3. Commit: `docs: pin consumer examples at vX.Y.Z`
4. `git push origin main`
5. `git tag vX.Y.Z && git push origin vX.Y.Z`
6. `gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."` (link PRs/issues from the changelog)

Protected `main` may require user approval for push/tag; retry or ask the user if blocked.

## Phase 3 — Consumer upgrade issues

For **each** entry in `.local/consumers.json`:

### Discover current pins (do not guess)

```bash
REPO="owner/name"
gh search code "gha-agent-pipeline" --repo "$REPO" --json path
rg 'gha-agent-pipeline@v0' .   # if repo is checked out locally
```

Via API for key workflows:

```bash
gh api "repos/$REPO/contents/.github/workflows/agent.yml" --jq '.content' | base64 -d | rg 'gha-agent-pipeline|v0\.'
```

Repeat for `agent-phase.yml`, `agent-on-ci-failure.yml`, `agent-on-ci-success.yml`, local actions (`run-agent-ci-fix`, `setup-agent-environment`), and docs (`README.md`, `AGENTS.md`, internal ops docs).

Record the **current pin** (e.g. `@v0.1.2`) per repo for the issue body.

### Issue per consumer (required for `/agent yolo`)

One issue **per repository** — yolo runs in the consumer repo, not the library.

- **Title:** `chore: upgrade gha-agent-pipeline pin to vX.Y.Z`
- **Body:** use [issue-body-template.md](issue-body-template.md); fill release link, changelog bullets, current pin, file table, `rg` commands, verification checklist.
- Language: match the consumer team (French or English) when the user prefers; keep technical paths in English.

Create and trigger (only when the user asked to launch implementation):

```bash
gh issue create --repo "$REPO" --title "..." --body-file /tmp/issue-body.md
gh issue comment <number> --repo "$REPO" --body "/agent yolo"
```

Skip `/agent yolo` if the user only wanted notification issues.

### Consumer-specific patterns

| Pattern            | What to mention in the issue                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| Standard consumer  | `dispatch.yml`, `agent-phase-run`, `agent-ci-fix.yml`, `agent-ci-success.yml`                          |
| Custom CI wrappers | Also bump `get-pr-from-workflow-run` and forked `run-agent-ci-fix` internal composites                 |
| Skipped versions   | If consumer is on `v0.1.1` and release is `v0.1.3`, summarize intermediate release notes (e.g. v0.1.2) |
| foldio-app         | Include `docs/internal/tech/operations/gha-agent-pipeline.md` when present                             |

## Phase 4 — Report back

Give the user:

- Release URL and tag SHA
- Table: consumer repo → issue URL → previous pin → `/agent yolo` posted or not

## Safety

- Do not commit `.local/consumers.json`
- Do not force-push tags or amend published release tags without explicit user request
- Do not change consumer workflow structure in the library release phase; consumer bumps are the yolo PR scope

## Additional resources

- Issue body skeleton: [issue-body-template.md](issue-body-template.md)
